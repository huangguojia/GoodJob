import assert from "node:assert/strict";
import { publicUser, signToken } from "./auth.js";
import { defineProvider, type LeadProvider } from "./provider-contract.js";
import { LEAD_PROVIDERS } from "./lead-providers.js";
import { getStore } from "./store.js";
import type { Customer, ProviderCatalogItem, User } from "./types.js";

const store = getStore();
const teamId = "lead-finder-existing-filter-team";
const ownerId = "lead-finder-existing-filter-owner";
const providerId = "existing_filter_fixture";
const now = "2026-08-28T00:00:00.000Z";

const user: User = {
  id: ownerId,
  name: "Existing Filter Owner",
  email: "existing-filter@example.test",
  password: "test-only",
  role: "sales",
  teamId,
  avatar: "EF",
  status: "active",
  authVersion: 1
};

const existingCustomer: Customer = {
  id: "customer_existing_filter",
  company: "Existing Pump GmbH",
  country: "Germany",
  contact: "Anna",
  ownerId,
  teamId,
  stage: "已成交",
  amount: 1000,
  health: 90,
  lifecycleStatus: "won",
  nextReminder: "",
  wecomBound: false,
  billingName: "Existing Pump GmbH",
  billingAddress: "",
  documentContact: "",
  website: "https://existing-pump.example",
  defaultPortDischarge: "",
  defaultIncoterm: "",
  defaultPaymentTerm: ""
};

const provider: LeadProvider = defineProvider({
  id: providerId,
  name: "Existing Filter Fixture",
  tier: "free",
  category: "web",
  requiresKey: false,
  capabilities: ["web"],
  docsUrl: "",
  keyHint: "",
  defaultBaseUrl: "https://fixture.example",
  costNote: "test only",
  networkPolicy: {
    allowedHosts: ["fixture.example"],
    allowedPathPrefixes: ["/"],
    allowedMethods: ["GET"]
  },
  async search() {
    return {
      records: [{
        company: "Existing Pump GmbH",
        country: "Germany",
        business: "Industrial pump distributor",
        officialWebsite: "https://existing-pump.example/products",
        sourceUrl: "https://fixture.example/existing-pump",
        contact: "Anna",
        contactInfo: "sales@existing-pump.example",
        description: "Should be filtered because it is already a customer.",
        confidence: 70,
        providerRecordId: "fixture-existing-pump",
        recordType: "discovery_page",
        evidenceSummary: "Existing customer candidate",
        matchedFields: ["company", "officialWebsite", "country"]
      }],
      rawCount: 1,
      exhausted: true
    };
  },
  async health() {
    return { ok: true, message: "ok" };
  }
});

const catalog: ProviderCatalogItem = {
  id: `provider_${providerId}`,
  code: providerId,
  name: provider.name,
  category: "web",
  sourceLevel: "public_web",
  accessMode: "api",
  baseUrl: provider.defaultBaseUrl || "",
  officialDocsUrl: "",
  capabilities: ["web"],
  allowedFields: [
    "company", "officialWebsite", "country", "business", "contact",
    "contactInfo", "description", "providerRecordId", "sourceUrl",
    "recordType", "evidenceSummary", "matchedFields"
  ],
  fieldAuthority: {
    company: "discovery",
    officialWebsite: "discovery",
    country: "discovery"
  },
  licensePolicy: { tier: "free", requiresKey: false },
  defaultRatePolicy: {},
  retentionPolicy: { mode: "provider_terms" },
  status: "active",
  version: "existing-filter-test-v1",
  reviewedAt: now,
  createdAt: now,
  updatedAt: now
};

const snapshots = {
  users: structuredClone(store.users),
  customers: structuredClone(store.customers),
  leads: structuredClone(store.leads),
  opportunities: structuredClone(store.websiteOpportunities),
  catalog: structuredClone(store.providerCatalog)
};
const originalPersist = store.persist;
const originalPersistProspectCandidates = store.persistProspectCandidates;
const providerStartIndex = LEAD_PROVIDERS.length;

try {
  store.persist = async () => undefined;
  store.persistProspectCandidates = async () => undefined;
  store.users.push(user);
  store.customers.push(existingCustomer);
  store.providerCatalog.push(catalog);
  LEAD_PROVIDERS.push(provider);

  const { app } = await import("./server.js");
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Cannot start existing CRM filter test server");
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/lead-finder/search`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${signToken(publicUser(user))}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          goal: "Find German pump distributors",
          productKeywords: "industrial pump",
          countries: "Germany",
          customerType: "Distributor",
          sources: [providerId],
          limit: 5
        })
      }
    );
    const json = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, JSON.stringify(json));
    assert.equal(json.opportunities.length, 0);
    assert.equal(json.incrementalStats.rawCount, 1);
    assert.equal(json.incrementalStats.existingFilteredCount, 1);
    assert.equal(store.websiteOpportunities.some((item) =>
      item.company === "Existing Pump GmbH"
      && item.teamId === teamId
    ), false);
    assert.ok(
      (json.skipped || []).some((item: string) => item.includes("客户库")),
      JSON.stringify(json.skipped)
    );
  } finally {
    server.close();
  }

  console.log(JSON.stringify({
    ok: true,
    existingFilteredCount: 1,
    returned: 0
  }, null, 2));
} finally {
  store.persist = originalPersist;
  store.persistProspectCandidates = originalPersistProspectCandidates;
  store.users.splice(0, store.users.length, ...snapshots.users);
  store.customers.splice(0, store.customers.length, ...snapshots.customers);
  store.leads.splice(0, store.leads.length, ...snapshots.leads);
  store.websiteOpportunities.splice(
    0,
    store.websiteOpportunities.length,
    ...snapshots.opportunities
  );
  store.providerCatalog.splice(
    0,
    store.providerCatalog.length,
    ...snapshots.catalog
  );
  LEAD_PROVIDERS.splice(providerStartIndex);
}
