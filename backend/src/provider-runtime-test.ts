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

console.log("Provider runtime contract tests passed");
