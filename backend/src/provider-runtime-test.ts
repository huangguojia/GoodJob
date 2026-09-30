import assert from "node:assert/strict";
import { encryptProviderConfiguration } from "./credential-security.js";
import {
  ProviderContractError,
  defineProvider,
  providerHttpStatusError,
  type LeadProvider
} from "./provider-contract.js";
import {
  assertProviderBaseUrlAllowed,
  assertProviderRedirectAllowed,
  assertProviderRequestAllowed,
  createProviderHttpClient,
  setProviderHttpTestTransport
} from "./provider-http-client.js";
import {
  createProviderExecutionContext,
  executeProviderEnrich,
  executeProviderHealth,
  executeProviderSearch
} from "./provider-runtime.js";
import {
  providerRequestFingerprint,
  recordProviderHttpResult,
  withProviderRequestLogging
} from "./provider-request-logging.js";
import {
  DEFAULT_LEAD_SEARCH_PROVIDER_IDS,
  decisionMakerTier,
  defaultSearchProviderIdsFor,
  getProvider,
  providerMeta
} from "./lead-providers.js";
import type { ProviderCatalogItem, ProviderConnection, ProviderRequestLog } from "./types.js";

const query = {
  goal: "Find distributors",
  productKeywords: "industrial sensor",
  countries: "Germany",
  industry: "automation",
  customerType: "distributor",
  excludeKeywords: "consumer",
  limit: 5
};

function catalog(
  provider: LeadProvider,
  overrides: Partial<ProviderCatalogItem> = {}
): ProviderCatalogItem {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    id: `provider_${provider.id}`,
    code: provider.id,
    name: provider.name,
    category: provider.category,
    sourceLevel: provider.category === "ai" ? "assisted_discovery" : "identity",
    accessMode: provider.accessMode,
    baseUrl: provider.defaultBaseUrl || "",
    officialDocsUrl: provider.docsUrl,
    capabilities: [...provider.capabilities],
    allowedFields: [
      "company",
      "officialWebsite",
      "country",
      "business",
      "contact",
      "contactInfo",
      "description",
      "confidence",
      "sourceUrl",
      "evidenceSummary",
      "matchedFields"
    ],
    licensePolicy: {
      requiresKey: provider.requiresKey
    },
    defaultRatePolicy: {},
    retentionPolicy: { mode: "provider_terms" },
    status: "active",
    version: "policy-1",
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function context(providerId: string) {
  return createProviderExecutionContext({
    teamId: "team_a",
    ownerId: "owner_a",
    runId: "run_provider_test",
    providerId,
    operation: "search",
    purpose: "provider_contract_test"
  });
}

function connection(
  providerId: string,
  overrides: Partial<ProviderConnection> = {}
): ProviderConnection {
  const now = "2026-07-13T00:00:00.000Z";
  const identity = {
    id: `connection_${providerId}`,
    providerId,
    ownerId: "owner_a",
    teamId: "team_a",
    ...overrides
  };
  return {
    ...identity,
    scope: "personal" as const,
    credentialRef: `credential_${providerId}`,
    configurationEncrypted: encryptProviderConfiguration(identity, {
      apiKey: "secret-key",
      baseUrl: "https://example.com/api"
    }),
    status: "active" as const,
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "",
    lastHealthStatus: "untested",
    lastErrorCode: "",
    lastHealthMessage: "",
    usage: "",
    createdBy: identity.ownerId,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/**
 * 为真实适配器（Apollo / PDL / Hunter）构造"已配置凭据"的连接。
 * 刻意不带自定义 baseUrl —— 走适配器默认域名，才能命中各自的白名单策略。
 */
function adapterConnection(provider: LeadProvider, apiKey = "test-key"): ProviderConnection {
  const identity = {
    id: `connection_${provider.id}`,
    providerId: provider.id,
    ownerId: "owner_a",
    teamId: "team_a"
  };
  return {
    ...identity,
    scope: "personal" as const,
    credentialRef: `credential_${provider.id}`,
    configurationEncrypted: encryptProviderConfiguration(identity, { apiKey, baseUrl: "" }),
    status: "active" as const,
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "",
    lastHealthStatus: "untested" as const,
    lastErrorCode: "",
    lastHealthMessage: "",
    usage: "",
    createdBy: identity.ownerId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  };
}

function provider(
  id: string,
  search: NonNullable<LeadProvider["search"]>,
  options: { requiresKey?: boolean; category?: LeadProvider["category"]; capabilities?: string[] } = {}
) {
  return defineProvider({
    id,
    name: id,
    tier: options.requiresKey ? "paid" : "free",
    category: options.category || "company",
    requiresKey: options.requiresKey || false,
    capabilities: options.capabilities || ["company"],
    docsUrl: "https://example.com/docs",
    keyHint: "",
    defaultBaseUrl: "https://example.com/api",
    costNote: "",
    networkPolicy: {
      allowedHosts: ["example.com"],
      allowedPathPrefixes: ["/api/"],
      allowedMethods: ["GET"]
    },
    search,
    async health() {
      return { ok: true, message: "ok" };
    }
  });
}

async function expectCode(operation: Promise<unknown>, code: ProviderContractError["code"]) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ProviderContractError && error.code === code
  );
}

const successProvider = provider("success_provider", async () => ({
  records: [{
    company: "Acme GmbH",
    officialWebsite: "https://acme.example",
    sourceUrl: "https://registry.example/acme",
    providerRecordId: "DE-1",
    recordType: "identity_evidence",
    evidenceSummary: "Registry identity",
    matchedFields: ["company", "country"],
    country: "DE"
  }],
  exhausted: true
}));
const successPage = await executeProviderSearch({
  provider: successProvider,
  catalog: catalog(successProvider),
  context: context(successProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(successPage.status, "success");
assert.equal(successPage.records[0]?.providerRecordId, "DE-1");
assert.equal(successPage.records[0]?.officialWebsite, "https://acme.example/");
assert.equal(successPage.records[0]?.sourceUrl, "https://registry.example/acme");
assert.equal(successPage.records[0]?.recordType, "identity_evidence");

const emptyProvider = provider("empty_provider", async () => ({ records: [] }));
const emptyPage = await executeProviderSearch({
  provider: emptyProvider,
  catalog: catalog(emptyProvider),
  context: context(emptyProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(emptyPage.status, "success_empty");

const partialProvider = provider("partial_provider", async () => ({
  records: [{ company: "Valid Company" }],
  invalidCount: 2,
  warnings: ["two records rejected"]
}));
const partialPage = await executeProviderSearch({
  provider: partialProvider,
  catalog: catalog(partialProvider),
  context: context(partialProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(partialPage.status, "partial_success");
assert.equal(partialPage.invalidCount, 2);

const blockedFieldsPage = await executeProviderSearch({
  provider: successProvider,
  catalog: catalog(successProvider, { allowedFields: [] }),
  context: context(successProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(blockedFieldsPage.records[0]?.officialWebsite, "");
assert.equal(blockedFieldsPage.records[0]?.sourceUrl, "");
assert.equal(blockedFieldsPage.records[0]?.evidenceSummary, "");
assert.deepEqual(blockedFieldsPage.records[0]?.matchedFields, []);

const privateEvidenceProvider = provider("private_evidence_provider", async () => ({
  records: [{
    company: "Unsafe Evidence",
    officialWebsite: "https://127.0.0.1/internal",
    sourceUrl: "https://169.254.169.254/latest/meta-data",
    recordType: "identity_evidence"
  }]
}));
const privateEvidencePage = await executeProviderSearch({
  provider: privateEvidenceProvider,
  catalog: catalog(privateEvidenceProvider),
  context: context(privateEvidenceProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(privateEvidencePage.records[0]?.officialWebsite, "");
assert.equal(privateEvidencePage.records[0]?.sourceUrl, "");

await expectCode(executeProviderSearch({
  provider: successProvider,
  catalog: catalog(successProvider, { status: "disabled" }),
  context: context(successProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
}), "PROVIDER_DISABLED");

await expectCode(executeProviderSearch({
  provider: successProvider,
  catalog: catalog(successProvider, { capabilities: ["web"] }),
  context: context(successProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
}), "PROVIDER_POLICY_BLOCKED");

const keyedProvider = provider("keyed_provider", async () => ({ records: [] }), { requiresKey: true });
const invalidConnectionLogs: ProviderRequestLog[] = [];
await expectCode(executeProviderSearch({
  provider: keyedProvider,
  catalog: catalog(keyedProvider),
  context: context(keyedProvider.id),
  connection: connection(keyedProvider.id, { ownerId: "owner_b" }),
  query,
  onLogs(items) {
    invalidConnectionLogs.push(...items);
  }
}), "PROVIDER_CONNECTION_INVALID");
assert.equal(invalidConnectionLogs.length, 1);
assert.equal(invalidConnectionLogs[0]?.errorCode, "provider_connection_invalid");
await expectCode(executeProviderSearch({
  provider: keyedProvider,
  catalog: catalog(keyedProvider),
  context: context(keyedProvider.id),
  connection: connection(keyedProvider.id, { scope: "team" }),
  query,
  onLogs() {}
}), "PROVIDER_CONNECTION_INVALID");

const freeWithoutConnection = await executeProviderSearch({
  provider: emptyProvider,
  catalog: catalog(emptyProvider),
  context: context(emptyProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(freeWithoutConnection.status, "success_empty");

await expectCode(executeProviderHealth({
  provider: successProvider,
  catalog: catalog(successProvider, { status: "disabled" }),
  context: { ...context(successProvider.id), operation: "health" },
  credential: { apiKey: "" },
  onLogs() {}
}), "PROVIDER_DISABLED");

for (const [status, expectedCode] of [[401, "PROVIDER_AUTH_FAILED"], [429, "PROVIDER_RATE_LIMITED"]] as const) {
  const failingProvider = provider(`http_${status}`, async () => {
    throw providerHttpStatusError(new Response("", { status }), "Typed Provider");
  });
  await expectCode(executeProviderSearch({
    provider: failingProvider,
    catalog: catalog(failingProvider),
    context: context(failingProvider.id),
    credential: { apiKey: "" },
    query,
    onLogs() {}
  }), expectedCode);
}

const typedRateLimitProvider = provider("typed_rate_limit", async () => {
  throw providerHttpStatusError(new Response("", {
    status: 429,
    headers: { "retry-after": "60" }
  }), "Typed Provider");
});
await assert.rejects(executeProviderSearch({
  provider: typedRateLimitProvider,
  catalog: catalog(typedRateLimitProvider),
  context: context(typedRateLimitProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
}), (error: unknown) =>
  error instanceof ProviderContractError
  && error.code === "PROVIDER_RATE_LIMITED"
  && Boolean(error.retryAfterAt)
);

const aiProvider = provider("ai_contract", async () => ({
  records: [{
    company: "Suggested Co",
    recordType: "assisted_suggestion",
    evidenceSummary: "AI suggestion, unverified"
  }]
}), { category: "ai", capabilities: ["ai", "company"] });
const aiPage = await executeProviderSearch({
  provider: aiProvider,
  catalog: catalog(aiProvider),
  context: context(aiProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs() {}
});
assert.equal(aiPage.records[0]?.recordType, "assisted_suggestion");
assert.equal(aiPage.records[0]?.sourceUrl, "");

const enrichmentProvider = defineProvider({
  id: "enrichment_provider",
  name: "Enrichment Provider",
  tier: "free",
  category: "email",
  requiresKey: false,
  capabilities: ["email", "enrich"],
  docsUrl: "https://example.com/docs",
  keyHint: "",
  defaultBaseUrl: "https://example.com/api",
  costNote: "",
  networkPolicy: {
    allowedHosts: ["example.com"],
    allowedPathPrefixes: ["/api/"],
    allowedMethods: ["GET"]
  },
  async health() {
    return { ok: true, message: "healthy" };
  },
  async enrich({ domain }) {
    return {
      contact: "Test Buyer",
      contactInfo: `buyer@${domain}`,
      officialWebsite: `https://${domain}`,
      sourceUrl: `https://example.com/api/contact?domain=${encodeURIComponent(domain)}`,
      providerRecordId: `${domain}:buyer`,
      evidenceSummary: "Public contact record",
      matchedFields: ["officialWebsite", "contact", "contactInfo"],
      confidence: 82
    };
  }
});
const enrichmentResult = await executeProviderEnrich({
  provider: enrichmentProvider,
  catalog: catalog(enrichmentProvider),
  context: { ...context(enrichmentProvider.id), operation: "enrich" },
  credential: { apiKey: "" },
  domain: "acme.example",
  onLogs() {}
});
assert.equal(enrichmentResult?.contactInfo, "buyer@acme.example");
assert.equal(enrichmentResult?.confidence, 82);
assert.equal(enrichmentResult?.evidence.recordType, "contact_evidence");
assert.equal(enrichmentResult?.evidence.providerRecordId, "acme.example:buyer");
assert.match(enrichmentResult?.evidence.payloadHash || "", /^[a-f0-9]{64}$/);

const invalidEnrichmentProvider = {
  ...enrichmentProvider,
  id: "invalid_enrichment_provider",
  async enrich() {
    return {} as never;
  }
};
await expectCode(executeProviderEnrich({
  provider: invalidEnrichmentProvider,
  catalog: catalog(invalidEnrichmentProvider),
  context: { ...context(invalidEnrichmentProvider.id), operation: "enrich" },
  credential: { apiKey: "" },
  domain: "acme.example",
  onLogs() {}
}), "PROVIDER_SCHEMA_CHANGED");

const rateLimitedEnrichmentProvider = {
  ...enrichmentProvider,
  id: "rate_limited_enrichment_provider",
  async enrich() {
    throw providerHttpStatusError(new Response("", {
      status: 429,
      headers: { "retry-after": "30" }
    }), "Enrichment Provider");
  }
};
await assert.rejects(executeProviderEnrich({
  provider: rateLimitedEnrichmentProvider,
  catalog: catalog(rateLimitedEnrichmentProvider),
  context: { ...context(rateLimitedEnrichmentProvider.id), operation: "enrich" },
  credential: { apiKey: "" },
  domain: "acme.example",
  onLogs() {}
}), (error: unknown) =>
  error instanceof ProviderContractError
  && error.code === "PROVIDER_RATE_LIMITED"
  && Boolean(error.retryAfterAt)
);

const invalidHealthProvider = {
  ...enrichmentProvider,
  id: "invalid_health_provider",
  async health() {
    return { ok: true, message: "" };
  }
};
await expectCode(executeProviderHealth({
  provider: invalidHealthProvider,
  catalog: catalog(invalidHealthProvider),
  context: { ...context(invalidHealthProvider.id), operation: "health" },
  credential: { apiKey: "" },
  onLogs() {}
}), "PROVIDER_SCHEMA_CHANGED");

const networkPolicy = {
  allowedHosts: ["api.example.com"],
  allowedPathPrefixes: ["/v1/"],
  allowedMethods: ["GET"] as Array<"GET" | "POST">,
  redirectHosts: ["download.example.com"]
};
assert.doesNotThrow(() => assertProviderBaseUrlAllowed("https://api.example.com/v1", networkPolicy));
assert.throws(() => assertProviderBaseUrlAllowed("https://evil.example/v1", networkPolicy));
assert.throws(() => assertProviderBaseUrlAllowed("https://api.example.com/v1?token=secret", networkPolicy));
assert.doesNotThrow(() => assertProviderRequestAllowed("https://api.example.com/v1/search", "GET", networkPolicy));
assert.throws(() => assertProviderRequestAllowed("https://api.example.com/admin", "GET", networkPolicy));
assert.throws(() => assertProviderRequestAllowed("https://api.example.com/v1/search", "POST", networkPolicy));
assert.throws(() => assertProviderRedirectAllowed(
  "https://api.example.com/v1/search",
  "https://unknown.example/v1/result",
  networkPolicy
));
assert.doesNotThrow(() => assertProviderRedirectAllowed(
  "https://api.example.com/v1/search",
  "https://download.example.com/v1/result",
  { ...networkPolicy, allowedPathPrefixes: ["/v1/"] }
));
assert.doesNotThrow(() => assertProviderRedirectAllowed(
  "https://api.example.com/v1/search",
  "https://api.example.com/en-US/search",
  { ...networkPolicy, redirectPathPrefixes: ["/"] }
));
assert.throws(() => assertProviderRedirectAllowed(
  "https://api.example.com/v1/search",
  "https://api.example.com/admin",
  networkPolicy
));
assert.throws(() => assertProviderRedirectAllowed(
  "https://api.example.com/v1/search",
  "https://download.example.com/v1/result",
  networkPolicy,
  true
));

let redirectTransportCalls = 0;
setProviderHttpTestTransport(async (url) => {
  redirectTransportCalls += 1;
  return url.includes("api.example.com")
    ? new Response("", { status: 302, headers: { location: "https://download.example.com/v1/result" } })
    : new Response("ok", { status: 200 });
});
try {
  const redirectClient = createProviderHttpClient(networkPolicy);
  await expectCode(redirectClient.fetch("https://api.example.com/v1/search", {
    headers: { "Api-Key": "custom-provider-secret" }
  }), "PROVIDER_POLICY_BLOCKED");
  assert.equal(redirectTransportCalls, 1);
} finally {
  setProviderHttpTestTransport(null);
}

setProviderHttpTestTransport(async (url) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return url.includes("api.example.com")
    ? new Response("", { status: 302, headers: { location: "https://download.example.com/v1/result" } })
    : new Response("ok", { status: 200 });
});
try {
  const timeoutClient = createProviderHttpClient({ ...networkPolicy, timeoutMs: 70 });
  const startedAt = Date.now();
  await assert.rejects(timeoutClient.fetch("https://api.example.com/v1/search"), /timeout/i);
  assert.ok(Date.now() - startedAt < 120, "redirect chain must share one absolute deadline");
} finally {
  setProviderHttpTestTransport(null);
}

let sameHostLocaleRedirectCalls = 0;
setProviderHttpTestTransport(async (url) => {
  sameHostLocaleRedirectCalls += 1;
  return url.endsWith("/v1/search")
    ? new Response("", {
      status: 302,
      headers: { location: "https://api.example.com/en-US/search" }
    })
    : new Response("ok", { status: 200 });
});
try {
  const localeRedirectClient = createProviderHttpClient({
    ...networkPolicy,
    redirectPathPrefixes: ["/"],
    maxRedirects: 1
  });
  const localeResponse = await localeRedirectClient.fetch("https://api.example.com/v1/search");
  assert.equal(localeResponse.status, 200);
  assert.equal(sameHostLocaleRedirectCalls, 2);
} finally {
  setProviderHttpTestTransport(null);
}

for (const privateUrl of ["https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/"]) {
  const privateHost = new URL(privateUrl).hostname.replace(/^\[|\]$/g, "");
  const client = createProviderHttpClient({
    allowedHosts: [privateHost],
    allowedPathPrefixes: ["/"],
    allowedMethods: ["GET"]
  });
  await expectCode(client.fetch(privateUrl), "PROVIDER_POLICY_BLOCKED");
}
const headerClient = createProviderHttpClient({
  allowedHosts: ["api.example.com"],
  allowedPathPrefixes: ["/"],
  allowedMethods: ["GET"]
});
await expectCode(headerClient.fetch("https://api.example.com/", {
  headers: { host: "evil.example" }
}), "PROVIDER_POLICY_BLOCKED");

const policyLogs: ProviderRequestLog[] = [];
const blockedNetworkProvider = provider("blocked_network_provider", async (_request, _credential, tools) => {
  await tools.http.fetch("https://evil.example/api/search");
  return { records: [] };
});
await expectCode(executeProviderSearch({
  provider: blockedNetworkProvider,
  catalog: catalog(blockedNetworkProvider),
  context: context(blockedNetworkProvider.id),
  credential: { apiKey: "" },
  query,
  onLogs(items) {
    policyLogs.push(...items);
  }
}), "PROVIDER_POLICY_BLOCKED");
assert.equal(policyLogs.length, 1);
assert.equal(policyLogs[0]?.httpStatus, 0);
assert.equal(policyLogs[0]?.errorCode, "provider_policy_blocked");

const logs: ProviderRequestLog[] = [];
const secret = "provider-key-should-never-appear";
const email = "buyer@example.com";
await withProviderRequestLogging({
  teamId: "team_a",
  ownerId: "owner_a",
  providerId: "log_provider",
  connectionId: "connection_log",
  runId: "run_log",
  runShardId: "run_log_provider",
  requestFingerprint: providerRequestFingerprint({ secret, email }),
  endpointCode: "search"
}, async () => {
  recordProviderHttpResult({
    httpStatus: 200,
    durationMs: 12,
    responseSize: 128,
    errorCode: "",
    requestedAt: new Date().toISOString()
  });
}, (items) => logs.push(...items));
assert.equal(logs.length, 1);
const serializedLogs = JSON.stringify(logs);
assert.equal(serializedLogs.includes(secret), false);
assert.equal(serializedLogs.includes(email), false);

// ---------------------------------------------------------------------------
// W2 · 搜客联系方式获取：决策人分级 / 默认搜索链资格 / 人员化搜索
// ---------------------------------------------------------------------------

assert.equal(decisionMakerTier("CEO"), 3);
assert.equal(decisionMakerTier("Managing Director"), 3);
assert.equal(decisionMakerTier("Purchasing Manager"), 2);
assert.equal(decisionMakerTier("Head of Procurement"), 2);
assert.equal(decisionMakerTier("Operations Director"), 1);
// 纯销售/行政岗对"找老板或采购"没有价值，必须归零
assert.equal(decisionMakerTier("Sales Manager"), 0);
assert.equal(decisionMakerTier("Marketing Assistant"), 0);
assert.equal(decisionMakerTier(""), 0);

// anysearch 是唯一免 Key 网页源，必须默认在链里（此前因为 recommended=false 从未被选中）
assert.equal(DEFAULT_LEAD_SEARCH_PROVIDER_IDS.includes("anysearch"), true);

for (const id of ["hunter", "apollo", "pdl"]) {
  const member = getProvider(id)!;
  assert.equal(providerMeta(member).contactCapable, true, `${id} 应标记为可补联系方式`);
  assert.equal(typeof member.enrich, "function", `${id} 应实现 enrich()`);
}
// Hunter 是纯补全源（只有 email/enrich），不能进企业搜索链，否则运行时直接报错
assert.equal(providerMeta(getProvider("hunter")!).searchCapable, false);
assert.equal(providerMeta(getProvider("apollo")!).searchCapable, true);
assert.equal(providerMeta(getProvider("pdl")!).searchCapable, true);

// 默认链资格：免费推荐源 + 已配置凭据的联系方式源；未配置/未启用/手动源/纯补全源一律排除
const providerStatuses = [
  { id: "anysearch", recommended: true, contactCapable: false, searchCapable: true, enabled: true, ready: true, accessMode: "api" },
  { id: "hunter", recommended: false, contactCapable: true, searchCapable: false, enabled: true, ready: true, accessMode: "api" },
  { id: "apollo", recommended: false, contactCapable: true, searchCapable: true, enabled: true, ready: true, accessMode: "api" },
  { id: "pdl", recommended: false, contactCapable: true, searchCapable: true, enabled: true, ready: false, accessMode: "api" },
  { id: "ai_search", recommended: false, contactCapable: true, searchCapable: true, enabled: true, ready: true, accessMode: "api" },
  { id: "manual_source", recommended: true, contactCapable: false, searchCapable: true, enabled: true, ready: true, accessMode: "manual" }
];
assert.deepEqual(defaultSearchProviderIdsFor(providerStatuses), ["anysearch", "apollo"]);

// Hunter：多邮箱按决策人优先排序，而不是盲取 emails[0]（那往往只是 info@ 通用邮箱）
const hunterProvider = getProvider("hunter")!;
setProviderHttpTestTransport(async (url) =>
  url.includes("/v2/domain-search")
    ? new Response(JSON.stringify({
      data: {
        domain: "acme.example",
        organization: "Acme GmbH",
        country: "Germany",
        emails: [
          { value: "info@acme.example", position: "sales", confidence: 96 },
          { value: "purchase@acme.example", first_name: "Pia", last_name: "Kaufmann", position: "Purchasing Manager", confidence: 70 },
          { value: "ceo@acme.example", first_name: "Cara", last_name: "Chef", position: "CEO", confidence: 52 }
        ]
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("", { status: 404 })
);
try {
  const hunterEnrich = await executeProviderEnrich({
    provider: hunterProvider,
    catalog: catalog(hunterProvider),
    context: { ...context(hunterProvider.id), operation: "enrich" },
    connection: adapterConnection(hunterProvider),
    credential: { apiKey: "test-key" },
    domain: "acme.example",
    onLogs() {}
  });
  // CEO（tier 3）应压过 confidence 更高的 info@ sales（tier 0）
  assert.equal(hunterEnrich?.contact, "Cara Chef");
  assert.equal(hunterEnrich?.contactInfo, "ceo@acme.example");
  assert.equal(hunterEnrich?.evidence.recordType, "contact_evidence");
  assert.match(hunterEnrich?.evidence.evidenceSummary || "", /决策人优先/);
} finally {
  setProviderHttpTestTransport(null);
}

// Apollo：公司搜索 + 人员搜索合并，带真实姓名的决策人排在公司候选之前
const apolloProvider = getProvider("apollo")!;
setProviderHttpTestTransport(async (url) => {
  if (url.includes("mixed_companies/search")) {
    return new Response(JSON.stringify({
      organizations: [{ id: "org1", name: "Acme GmbH", primary_domain: "acme.example", country: "Germany", industry: "automation" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("mixed_people/search")) {
    return new Response(JSON.stringify({
      people: [
        { id: "p1", name: "Sam Sales", title: "Sales Manager", email: "sam@acme.example", organization: { name: "Acme GmbH", primary_domain: "acme.example" } },
        { id: "p2", name: "Paula Buyer", title: "Head of Purchasing", email: "paula@acme.example", organization: { name: "Acme GmbH", primary_domain: "acme.example" } }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("", { status: 404 });
});
try {
  const apolloPage = await executeProviderSearch({
    provider: apolloProvider,
    catalog: catalog(apolloProvider),
    context: context(apolloProvider.id),
    connection: adapterConnection(apolloProvider),
    credential: { apiKey: "test-key" },
    query,
    onLogs() {}
  });
  assert.ok(apolloPage.records.length >= 2, "Apollo 应同时返回人员与公司候选");
  assert.equal(apolloPage.records[0]?.recordType, "contact_evidence");
  assert.equal(apolloPage.records[0]?.contact, "Paula Buyer");
  assert.equal(apolloPage.records[0]?.contactInfo, "paula@acme.example");
  assert.equal(apolloPage.records.some((item) => item.contact === "Sam Sales"), true);
  assert.equal(apolloPage.records.some((item) => item.recordType === "company_candidate"), true);
} finally {
  setProviderHttpTestTransport(null);
}

// Apollo enrich：按域名锁定公司后返回决策人邮箱
setProviderHttpTestTransport(async (url) =>
  url.includes("mixed_people/search")
    ? new Response(JSON.stringify({
      people: [{ id: "p2", name: "Paula Buyer", title: "Purchasing Manager", email: "paula@acme.example" }]
    }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("", { status: 404 })
);
try {
  const apolloEnrich = await executeProviderEnrich({
    provider: apolloProvider,
    catalog: catalog(apolloProvider),
    context: { ...context(apolloProvider.id), operation: "enrich" },
    connection: adapterConnection(apolloProvider),
    credential: { apiKey: "test-key" },
    domain: "acme.example",
    onLogs() {}
  });
  assert.equal(apolloEnrich?.contact, "Paula Buyer");
  assert.equal(apolloEnrich?.contactInfo, "paula@acme.example");
  assert.equal(apolloEnrich?.evidence.recordType, "contact_evidence");
} finally {
  setProviderHttpTestTransport(null);
}

// PDL：person/search 按 job_title_levels 产出决策人；无人员时降级为公司候选 + warning
const pdlProvider = getProvider("pdl")!;
setProviderHttpTestTransport(async (url) => {
  if (url.includes("/v5/company/search")) {
    return new Response(JSON.stringify({
      data: [{ id: "pdl_org", display_name: "Acme GmbH", website: "acme.example", industry: "automation" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("/v5/person/search")) {
    return new Response(JSON.stringify({
      data: [{
        id: "pdl_person",
        full_name: "Uwe Einkauf",
        job_title: "Procurement Director",
        job_company_name: "Acme GmbH",
        job_company_website: "acme.example",
        work_email: "uwe@acme.example",
        location_country: "germany"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("", { status: 404 });
});
try {
  const pdlPage = await executeProviderSearch({
    provider: pdlProvider,
    catalog: catalog(pdlProvider),
    context: context(pdlProvider.id),
    connection: adapterConnection(pdlProvider),
    credential: { apiKey: "test-key" },
    query,
    onLogs() {}
  });
  assert.equal(pdlPage.records[0]?.recordType, "contact_evidence");
  assert.equal(pdlPage.records[0]?.contact, "Uwe Einkauf");
  assert.equal(pdlPage.records[0]?.contactInfo, "uwe@acme.example");
  assert.equal(pdlPage.records.some((item) => item.recordType === "company_candidate"), true);
} finally {
  setProviderHttpTestTransport(null);
}

// 人员搜索失败不能拖垮公司候选：降级为公司候选 + warning
setProviderHttpTestTransport(async (url) =>
  url.includes("/v5/company/search")
    ? new Response(JSON.stringify({
      data: [{ id: "pdl_org", display_name: "Acme GmbH", website: "acme.example", industry: "automation" }]
    }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "30" }
    })
);
try {
  const degradedPage = await executeProviderSearch({
    provider: pdlProvider,
    catalog: catalog(pdlProvider),
    context: context(pdlProvider.id),
    connection: adapterConnection(pdlProvider),
    credential: { apiKey: "test-key" },
    query,
    onLogs() {}
  });
  assert.equal(degradedPage.records.length, 1);
  assert.equal(degradedPage.records[0]?.recordType, "company_candidate");
  assert.equal(degradedPage.warnings.some((item) => item.includes("PDL 人员搜索降级")), true);
} finally {
  setProviderHttpTestTransport(null);
}

console.log("Provider runtime contract tests passed");
