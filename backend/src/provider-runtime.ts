import { randomUUID } from "node:crypto";
import { decryptProviderConfiguration } from "./credential-security.js";
import type { ProviderCatalogItem, ProviderConnection, ProviderRequestLog } from "./types.js";
import {
  ProviderContractError,
  normalizeProviderEnrichment,
  normalizeProviderHealthResult,
  normalizeProviderPage,
  normalizeProviderQuery,
  normalizeProviderTradePage,
  normalizeTradeQuery,
  providerErrorFromUnknown,
  type LeadProvider,
  type LeadQuery,
  type ProviderCredential,
  type ProviderExecutionContext,
  type ProviderHealthResult,
  type ProviderPage,
  type ProviderTradeAdapterPage,
  type ProviderTradePage,
  type TradeProvider,
  type TradeQuery
} from "./provider-contract.js";
import { createProviderHttpClient } from "./provider-http-client.js";
import {
  readProviderResponseCache,
  writeProviderResponseCache
} from "./provider-response-cache.js";
import {
  providerRequestFingerprint,
  recordProviderCacheHit,
  recordProviderHttpResult,
  recordProviderHttpResultIfEmpty,
  withProviderRequestLogging
} from "./provider-request-logging.js";

interface RuntimeBase {
  provider: LeadProvider | TradeProvider;
  catalog: ProviderCatalogItem;
  context: ProviderExecutionContext;
  connection?: ProviderConnection;
  credential?: ProviderCredential;
  allowDisabledConnectionForHealth?: boolean;
  onLogs: (logs: ProviderRequestLog[]) => void;
}

interface LeadRuntimeBase extends Omit<RuntimeBase, "provider"> {
  provider: LeadProvider;
}

interface TradeRuntimeBase extends Omit<RuntimeBase, "provider"> {
  provider: TradeProvider;
}

interface SearchRuntimeInput extends LeadRuntimeBase {
  query: LeadQuery;
  cursor?: string;
}

interface EnrichRuntimeInput extends LeadRuntimeBase {
  domain: string;
}

interface TradeRuntimeInput extends TradeRuntimeBase {
  query: TradeQuery;
  cursor?: string;
}

interface TradeConnectionBudgetState {
  active: number;
  lastStartedAt: number;
  requestStartedAt: number[];
}

interface TradeConnectionBudgetInput {
  provider: TradeProvider;
  catalog: ProviderCatalogItem;
  connection?: ProviderConnection;
  operation: ProviderExecutionContext["operation"];
}

interface TradeFlightResult {
  adapterPage: ProviderTradeAdapterPage;
  fetchedAt: string;
  cacheWriteFailed: boolean;
}

const tradeConnectionBudgets = new Map<string, TradeConnectionBudgetState>();
const activeTradeFlights = new Map<string, Promise<TradeFlightResult>>();

function contractError(code: ProviderContractError["code"], message: string, operation: ProviderExecutionContext["operation"]) {
  return new ProviderContractError({
    code,
    retryable: false,
    retryAfterAt: null,
    publicMessage: message,
    httpStatus: null,
    phase: operation
  });
}

function positivePolicyInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function rateLimitError(
  retryAfterAt: string,
  phase: ProviderExecutionContext["operation"]
) {
  recordProviderHttpResult({
    httpStatus: 429,
    durationMs: 0,
    responseSize: 0,
    errorCode: "provider_rate_limited",
    requestedAt: new Date().toISOString(),
    quotaUnits: 0
  });
  return new ProviderContractError({
    code: "PROVIDER_RATE_LIMITED",
    retryable: true,
    retryAfterAt,
    publicMessage: "数据源调用过于频繁，请稍后重试",
    httpStatus: 429,
    phase
  });
}

function acquireTradeConnectionBudget(input: TradeConnectionBudgetInput) {
  if (!input.connection) return () => undefined;
  const maxConcurrent = positivePolicyInteger(input.catalog.defaultRatePolicy.maxConcurrentPerConnection);
  const minIntervalMs = positivePolicyInteger(input.catalog.defaultRatePolicy.minIntervalMs);
  const requestsPerMinute = positivePolicyInteger(input.catalog.defaultRatePolicy.requestsPerMinute);
  if (!maxConcurrent && !minIntervalMs && !requestsPerMinute) return () => undefined;

  const now = Date.now();
  const key = `${input.provider.id}\u001f${input.connection.id}`;
  const state = tradeConnectionBudgets.get(key) || {
    active: 0,
    lastStartedAt: 0,
    requestStartedAt: []
  };
  state.requestStartedAt = state.requestStartedAt.filter((startedAt) => startedAt > now - 60_000);
  let retryAt = 0;
  if (maxConcurrent && state.active >= maxConcurrent) {
    retryAt = Math.max(retryAt, now + Math.max(250, minIntervalMs));
  }
  if (minIntervalMs && state.lastStartedAt + minIntervalMs > now) {
    retryAt = Math.max(retryAt, state.lastStartedAt + minIntervalMs);
  }
  if (requestsPerMinute && state.requestStartedAt.length >= requestsPerMinute) {
    retryAt = Math.max(retryAt, state.requestStartedAt[0]! + 60_000);
  }
  if (retryAt) throw rateLimitError(new Date(retryAt).toISOString(), input.operation);

  state.active += 1;
  state.lastStartedAt = now;
  state.requestStartedAt.push(now);
  tradeConnectionBudgets.set(key, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}

function cloneProviderFailure(error: unknown) {
  const normalized = providerErrorFromUnknown(error, "trade");
  return new ProviderContractError({
    code: normalized.code,
    retryable: normalized.retryable,
    retryAfterAt: normalized.retryAfterAt,
    publicMessage: normalized.publicMessage,
    httpStatus: normalized.httpStatus,
    phase: normalized.phase
  });
}

function tradeFlightKey(input: {
  providerId: string;
  adapterVersion: string;
  requestFingerprint: string;
  licenseScope: string;
}) {
  return [
    input.providerId,
    input.adapterVersion,
    input.requestFingerprint,
    input.licenseScope
  ].join("\u001f");
}

export function providerRequiresKey(provider: LeadProvider | TradeProvider, catalog?: ProviderCatalogItem) {
  return typeof catalog?.licensePolicy.requiresKey === "boolean"
    ? catalog.licensePolicy.requiresKey
    : provider.requiresKey;
}

export function assertProviderOperationPolicy(
  provider: LeadProvider | TradeProvider,
  catalog: ProviderCatalogItem,
  operation: ProviderExecutionContext["operation"]
) {
  if (catalog.code !== provider.id) {
    throw contractError("PROVIDER_POLICY_BLOCKED", "数据源目录与适配器不匹配", operation);
  }
  if (provider.contractVersion !== "1.0") {
    throw contractError("PROVIDER_POLICY_BLOCKED", "数据源契约版本不兼容", operation);
  }
  if (catalog.accessMode !== provider.accessMode || catalog.accessMode !== "api") {
    throw contractError("PROVIDER_POLICY_BLOCKED", "数据源接入方式不允许当前操作", operation);
  }
  if (catalog.status !== "active") {
    throw contractError("PROVIDER_DISABLED", "数据源当前未启用", operation);
  }
  const sharedCapabilities = provider.capabilities.filter((item) =>
    catalog.capabilities.includes(item)
  );
  if (operation === "search" && (
    !("search" in provider)
    || !provider.search
    || !sharedCapabilities.some((item) => ["web", "company", "ai"].includes(item))
  )) {
    throw contractError("PROVIDER_POLICY_BLOCKED", "数据源不支持企业搜索", operation);
  }
  if (operation === "enrich" && (
    !("enrich" in provider)
    || !provider.enrich
    || !sharedCapabilities.includes("enrich")
  )) {
    throw contractError("PROVIDER_POLICY_BLOCKED", "数据源不支持联系人补全", operation);
  }
  if (operation === "trade" && (
    !("trade" in provider)
    || !provider.trade
    || !sharedCapabilities.includes("trade")
  )) {
    throw contractError("PROVIDER_POLICY_BLOCKED", "数据源不支持宏观贸易查询", operation);
  }
}

function validateRuntime(input: RuntimeBase): ProviderCredential {
  const { provider, catalog, context, connection } = input;
  let credential = input.credential || { apiKey: "" };
  for (const [label, value] of [
    ["team", context.teamId],
    ["owner", context.ownerId],
    ["run", context.runId],
    ["run shard", context.runShardId],
    ["request", context.requestId],
    ["purpose", context.purpose]
  ]) {
    if (!value.trim()) throw contractError("PROVIDER_CONNECTION_INVALID", `Provider ${label} context is required`, context.operation);
  }
  assertProviderOperationPolicy(provider, catalog, context.operation);
  if (connection) {
    if (connection.scope !== "personal"
      || connection.providerId !== provider.id
      || connection.ownerId !== context.ownerId
      || connection.teamId !== context.teamId) {
      throw contractError("PROVIDER_CONNECTION_INVALID", "数据源连接不属于当前账号", context.operation);
    }
    if (connection.status !== "active"
      && !(context.operation === "health" && input.allowDisabledConnectionForHealth)) {
      throw contractError("PROVIDER_CONNECTION_INVALID", "数据源连接未启用", context.operation);
    }
    try {
      credential = decryptProviderConfiguration(connection, connection.configurationEncrypted);
    } catch {
      throw contractError("PROVIDER_CONNECTION_INVALID", "数据源连接凭据不可读取", context.operation);
    }
  }
  if (providerRequiresKey(provider, catalog)
    && (!credential.apiKey || (!connection && provider.id !== "ai_search"))) {
    throw contractError("PROVIDER_CONNECTION_INVALID", "数据源连接缺少有效凭据", context.operation);
  }
  return credential;
}

async function runLogged<T>(
  input: RuntimeBase,
  endpointCode: string,
  fingerprintValue: unknown,
  operation: (credential: ProviderCredential) => Promise<T>
) {
  const fingerprint = providerRequestFingerprint({
    providerId: input.provider.id,
    adapterVersion: input.provider.adapterVersion,
    catalogPolicyVersion: input.catalog.version,
    endpointCode,
    value: fingerprintValue
  });
  try {
    return await withProviderRequestLogging({
      teamId: input.context.teamId,
      ownerId: input.context.ownerId,
      providerId: input.provider.id,
      connectionId: input.connection?.id || "",
      runId: input.context.runId,
      runShardId: input.context.runShardId,
      requestFingerprint: fingerprint,
      endpointCode
    }, async () => {
      try {
        return await operation(validateRuntime(input));
      } catch (error) {
        const normalized = providerErrorFromUnknown(error, input.context.operation);
        recordProviderHttpResultIfEmpty({
          httpStatus: normalized.httpStatus || 0,
          durationMs: 0,
          responseSize: 0,
          errorCode: normalized.code.toLocaleLowerCase(),
          requestedAt: new Date().toISOString()
        });
        throw normalized;
      }
    }, input.onLogs);
  } catch (error) {
    throw providerErrorFromUnknown(error, input.context.operation);
  }
}

export function createProviderExecutionContext(input: {
  teamId: string;
  ownerId: string;
  runId: string;
  providerId: string;
  operation: ProviderExecutionContext["operation"];
  purpose: string;
  suffix?: string;
}): ProviderExecutionContext {
  return {
    teamId: input.teamId,
    ownerId: input.ownerId,
    runId: input.runId,
    runShardId: `${input.runId}_${input.providerId}${input.suffix ? `_${input.suffix}` : ""}`,
    requestId: `preq_${randomUUID()}`,
    purpose: input.purpose,
    operation: input.operation
  };
}

export async function executeProviderPreflight(input: RuntimeBase) {
  return await runLogged(
    input,
    `${input.context.operation}_preflight`,
    { preflight: true },
    async () => true
  );
}

export async function executeProviderSearch(input: SearchRuntimeInput): Promise<ProviderPage> {
  const runtimeInput: SearchRuntimeInput = {
    ...input,
    context: { ...input.context, operation: "search" }
  };
  const normalizedQuery = normalizeProviderQuery(input.query);
  const cursor = (input.cursor || "").trim();
  if (cursor.length > 2000) throw contractError("PROVIDER_POLICY_BLOCKED", "数据源游标超过允许大小", "search");
  const { limit: _limit, ...fingerprintQuery } = normalizedQuery;
  return await runLogged(runtimeInput, "search", {
    query: fingerprintQuery,
    cursor
  }, async (credential) => {
    const page = await input.provider.search!(
      { query: normalizedQuery, cursor },
      credential,
      { http: createProviderHttpClient(input.provider.networkPolicy) }
    );
    return normalizeProviderPage({
      provider: input.provider,
      catalogPolicyVersion: input.catalog.version,
      sourceLevel: input.catalog.sourceLevel,
      allowedFields: input.catalog.allowedFields,
      retentionPolicy: input.catalog.retentionPolicy,
      page
    });
  });
}

export async function executeProviderHealth(input: RuntimeBase): Promise<ProviderHealthResult> {
  const runtimeInput: RuntimeBase = {
    ...input,
    context: { ...input.context, operation: "health" }
  };
  return await runLogged(runtimeInput, "connection_test", { health: true }, async (credential) => {
    const tradeProvider = input.provider.category === "market_trade"
      ? input.provider
      : null;
    const releaseBudget = tradeProvider
      ? acquireTradeConnectionBudget({
          provider: tradeProvider,
          catalog: input.catalog,
          connection: input.connection,
          operation: "health"
        })
      : () => undefined;
    try {
      return normalizeProviderHealthResult(await input.provider.health(
        credential,
        { http: createProviderHttpClient(input.provider.networkPolicy) }
      ));
    } finally {
      releaseBudget();
    }
  });
}

export async function executeProviderEnrich(input: EnrichRuntimeInput) {
  const runtimeInput: EnrichRuntimeInput = {
    ...input,
    context: { ...input.context, operation: "enrich" }
  };
  const domain = input.domain.trim().toLocaleLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.length > 253) {
    throw contractError("PROVIDER_POLICY_BLOCKED", "待补全域名格式无效", "enrich");
  }
  return await runLogged(runtimeInput, "enrich", { domain }, async (credential) =>
    normalizeProviderEnrichment({
      provider: input.provider,
      catalogPolicyVersion: input.catalog.version,
      sourceLevel: input.catalog.sourceLevel,
      allowedFields: input.catalog.allowedFields,
      retentionPolicy: input.catalog.retentionPolicy,
      domain,
      result: await input.provider.enrich!(
      { domain },
      credential,
      { http: createProviderHttpClient(input.provider.networkPolicy) }
      )
    })
  );
}

function tradeCachePolicy(catalog: ProviderCatalogItem) {
  const licenseScope = typeof catalog.licensePolicy.cacheScope === "string"
    ? catalog.licensePolicy.cacheScope.trim()
    : "";
  const configuredTtl = Number(catalog.defaultRatePolicy.cacheTtlSeconds);
  const ttlSeconds = Number.isFinite(configuredTtl)
    ? Math.max(0, Math.trunc(configuredTtl))
    : 0;
  return licenseScope && ttlSeconds > 0
    ? { licenseScope, ttlSeconds }
    : null;
}

export async function executeProviderTradeQuery(input: TradeRuntimeInput): Promise<ProviderTradePage> {
  const runtimeInput: TradeRuntimeInput = {
    ...input,
    context: { ...input.context, operation: "trade" }
  };
  const query = normalizeTradeQuery(input.query);
  const cursor = (input.cursor || "").trim();
  if (cursor.length > 2000) throw contractError("PROVIDER_POLICY_BLOCKED", "数据源游标超过允许大小", "trade");
  const fingerprintValue = { query, cursor };
  const requestFingerprint = providerRequestFingerprint({
    providerId: input.provider.id,
    adapterVersion: input.provider.adapterVersion,
    endpointCode: "trade",
    value: fingerprintValue
  });
  const cachePolicy = tradeCachePolicy(input.catalog);
  const cacheKey = cachePolicy ? {
    providerId: input.provider.id,
    providerVersion: input.provider.adapterVersion,
    requestFingerprint,
    licenseScope: cachePolicy.licenseScope
  } : null;

  return await runLogged(runtimeInput, "trade", fingerprintValue, async (credential) => {
    if (cacheKey) {
      const cached = await readProviderResponseCache<unknown>(cacheKey);
      if (cached) {
        recordProviderCacheHit();
        const page = normalizeProviderTradePage({
          provider: input.provider,
          page: cached.payload,
          fetchedAt: cached.fetchedAt,
          cacheStatus: "cache"
        });
        return {
          ...page,
          usage: {
            ...page.usage,
            requestCount: 0,
            quotaUsed: 0,
            display: "公共缓存命中"
          }
        };
      }
    }

    if (cacheKey && cachePolicy) {
      const flightKey = tradeFlightKey({
        providerId: input.provider.id,
        adapterVersion: input.provider.adapterVersion,
        requestFingerprint,
        licenseScope: cachePolicy.licenseScope
      });
      let flight = activeTradeFlights.get(flightKey);
      const follower = Boolean(flight);
      if (!flight) {
        flight = Promise.resolve().then(async (): Promise<TradeFlightResult> => {
          let releaseBudget: () => void = () => undefined;
          try {
            releaseBudget = acquireTradeConnectionBudget({
              provider: runtimeInput.provider,
              catalog: runtimeInput.catalog,
              connection: runtimeInput.connection,
              operation: "trade"
            });
            const adapterPage = await input.provider.trade(
              { query, cursor },
              credential,
              { http: createProviderHttpClient(input.provider.networkPolicy) }
            );
            const validated = normalizeProviderTradePage({
              provider: input.provider,
              page: adapterPage,
              cacheStatus: "live"
            });
            const fetchedAt = validated.observations[0]?.fetchedAt || new Date().toISOString();
            let cacheWriteFailed = false;
            try {
              await writeProviderResponseCache(cacheKey, adapterPage, {
                fetchedAt,
                expiresAt: new Date(Date.now() + cachePolicy.ttlSeconds * 1000).toISOString()
              });
            } catch {
              cacheWriteFailed = true;
            }
            return { adapterPage, fetchedAt, cacheWriteFailed };
          } finally {
            releaseBudget();
            activeTradeFlights.delete(flightKey);
          }
        });
        activeTradeFlights.set(flightKey, flight);
      }

      let shared: TradeFlightResult;
      try {
        shared = await flight;
      } catch (error) {
        const failure = cloneProviderFailure(error);
        if (follower) {
          recordProviderHttpResult({
            httpStatus: failure.httpStatus || 0,
            durationMs: 0,
            responseSize: 0,
            errorCode: failure.code.toLocaleLowerCase(),
            requestedAt: new Date().toISOString(),
            quotaUnits: 0
          });
        }
        throw failure;
      }
      if (follower) recordProviderCacheHit();
      const page = normalizeProviderTradePage({
        provider: input.provider,
        page: shared.adapterPage,
        fetchedAt: shared.fetchedAt,
        cacheStatus: follower ? "cache" : "live"
      });
      if (follower) {
        page.usage = {
          ...page.usage,
          requestCount: 0,
          quotaUsed: 0,
          display: "并发公共请求复用"
        };
      }
      if (shared.cacheWriteFailed) {
        page.warnings.push("公共缓存写入失败，本次仍使用实时结果");
        if (page.status === "success") page.status = "partial_success";
      }
      return page;
    }

    const releaseBudget = acquireTradeConnectionBudget({
      provider: runtimeInput.provider,
      catalog: runtimeInput.catalog,
      connection: runtimeInput.connection,
      operation: "trade"
    });
    try {
      const adapterPage = await input.provider.trade(
        { query, cursor },
        credential,
        { http: createProviderHttpClient(input.provider.networkPolicy) }
      );
      return normalizeProviderTradePage({
        provider: input.provider,
        page: adapterPage,
        cacheStatus: "live"
      });
    } finally {
      releaseBudget();
    }
  });
}

export function resetProviderTradeRuntimeStateForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Provider trade runtime state can only be reset in tests");
  }
  tradeConnectionBudgets.clear();
  activeTradeFlights.clear();
}
