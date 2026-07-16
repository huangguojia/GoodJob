import { LEAD_PROVIDERS } from "./lead-providers.js";
import { TRADE_PROVIDERS } from "./trade-providers.js";
import type { LeadProvider, TradeProvider } from "./provider-contract.js";
import type { ProviderCatalogItem } from "./types.js";

const CATALOG_TIMESTAMP = "2026-07-13T00:00:00.000Z";
const LEAD_FIELDS = [
  "company",
  "website",
  "officialWebsite",
  "country",
  "business",
  "contact",
  "contactInfo",
  "description",
  "confidence",
  "providerRecordId",
  "sourceUrl",
  "recordType",
  "evidenceSummary",
  "matchedFields"
];
const TRADE_FIELDS = [
  "reporterCountry",
  "partnerCountry",
  "reporterCode",
  "partnerCode",
  "tradeFlow",
  "classification",
  "requestedClassification",
  "commodityCode",
  "commodityDescription",
  "period",
  "tradeValueUsd",
  "netWeightKg",
  "quantity",
  "quantityUnit",
  "isAggregate",
  "suppressed",
  "statusFlags",
  "sourceRevision",
  "providerRecordId"
];

function sourceLevel(provider: LeadProvider | TradeProvider) {
  if (provider.category === "market_trade") return "market_opportunity";
  if (provider.capabilities.includes("procurement")) return "business_signal";
  if (provider.category === "company") return "identity";
  if (provider.category === "email") return "contact";
  if (provider.category === "ai") return "assisted_discovery";
  return "discovery";
}

function providerCatalogItem(
  provider: LeadProvider | TradeProvider
): ProviderCatalogItem {
  return {
    id: `provider_${provider.id}`,
    code: provider.id,
    name: provider.name,
    category: provider.category,
    sourceLevel: sourceLevel(provider),
    accessMode: provider.accessMode,
    baseUrl: provider.defaultBaseUrl || "",
    officialDocsUrl: provider.docsUrl,
    capabilities: [...provider.capabilities],
    allowedFields: provider.category === "market_trade" ? [...TRADE_FIELDS] : [...LEAD_FIELDS],
    licensePolicy: {
      tier: provider.tier,
      requiresKey: provider.requiresKey,
      keyHint: provider.keyHint,
      costNote: provider.costNote,
      ...(provider.category === "market_trade" ? { cacheScope: "public_api" } : {})
    },
    defaultRatePolicy: provider.id === "sec_edgar"
      ? {
          cacheTtlSeconds: 86400,
          maxConcurrentPerConnection: 1,
          minIntervalMs: 120,
          requestsPerMinute: 500
        }
      : provider.capabilities.includes("procurement")
      ? {
          cacheTtlSeconds: 3600,
          maxConcurrentPerConnection: 1,
          minIntervalMs: 1000,
          requestsPerMinute: 30
        }
      : provider.category === "market_trade"
      ? provider.id === "us_census_trade"
        ? {
            cacheTtlSeconds: 86400,
            maxConcurrentPerConnection: 1,
            minIntervalMs: 1000,
            requestsPerMinute: 30
          }
        : { cacheTtlSeconds: 86400 }
      : {},
    retentionPolicy: { mode: "provider_terms" },
    status: "active",
    version: "1.0",
    reviewedAt: CATALOG_TIMESTAMP,
    createdAt: CATALOG_TIMESTAMP,
    updatedAt: CATALOG_TIMESTAMP
  };
}

export function createDefaultProviderCatalog(): ProviderCatalogItem[] {
  const aiSearch: ProviderCatalogItem = {
    id: "provider_ai_search",
    code: "ai_search",
    name: "AI 搜索",
    category: "ai",
    sourceLevel: "assisted_discovery",
    accessMode: "api",
    baseUrl: "",
    officialDocsUrl: "",
    capabilities: ["ai", "company"],
    allowedFields: [...LEAD_FIELDS],
    licensePolicy: {
      tier: "ai",
      requiresKey: false,
      keyHint: "使用「AI 模型配置」中已启用并勾选自动获客的模型，无需在此另填 Key。",
      costNote: "调用已配置的 AI 模型生成候选公司，结果需人工核实。"
    },
    defaultRatePolicy: {},
    retentionPolicy: { mode: "provider_terms" },
    status: "active",
    version: "1.0",
    reviewedAt: CATALOG_TIMESTAMP,
    createdAt: CATALOG_TIMESTAMP,
    updatedAt: CATALOG_TIMESTAMP
  };
  return [
    aiSearch,
    ...LEAD_PROVIDERS.map(providerCatalogItem),
    ...TRADE_PROVIDERS.map(providerCatalogItem)
  ];
}
