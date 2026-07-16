import assert from "node:assert/strict";
import {
  upsertMarketTradeObservations,
  visibleMarketTradeObservations
} from "./market-trade-observations.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { TradeObservation } from "./provider-contract.js";
import type { SessionUser, User } from "./types.js";

function user(id: string, role: User["role"], teamId: string): User {
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

function session(item: User): SessionUser {
  return {
    id: item.id,
    name: item.name,
    email: item.email,
    role: item.role,
    teamId: item.teamId,
    avatar: item.avatar,
    authVersion: item.authVersion || 1
  };
}

function observation(overrides: Partial<TradeObservation> = {}): TradeObservation {
  return {
    reporterCountry: "USA",
    partnerCountry: "WORLD",
    reporterCode: "842",
    partnerCode: "0",
    tradeFlow: "IMPORT",
    classification: "HS2022",
    requestedClassification: "HS2022",
    commodityCode: "940542",
    commodityDescription: "Other electric lamps and lighting fittings",
    period: "2023",
    tradeValueUsd: null,
    netWeightKg: null,
    quantity: null,
    quantityUnit: null,
    isAggregate: true,
    suppressed: true,
    statusFlags: ["SUPPRESSED"],
    sourceRevision: null,
    providerRecordId: "un-comtrade:record-001",
    fetchedAt: "2026-07-13T08:00:00.000Z",
    payloadHash: "a".repeat(64),
    adapterVersion: "1.0.0",
    ...overrides
  };
}

const salesA = user("sales_a", "sales", "team_a");
const salesA2 = user("sales_a_2", "sales", "team_a");
const adminA = user("admin_a", "admin", "team_a");
const salesB = user("sales_b", "sales", "team_b");
const adminB = user("admin_b", "admin", "team_b");
const superAdmin = user("super_admin_test", "super_admin", "all");
let persistCount = 0;
const store: CrmStore = {
  ...memoryStore,
  users: [salesA, salesA2, adminA, salesB, adminB, superAdmin],
  marketTradeObservations: [],
  async persist() {
    persistCount += 1;
  }
};

const first = await upsertMarketTradeObservations(store, {
  teamId: "team_a",
  ownerId: "sales_a",
  campaignId: "campaign_shared",
  providerId: "un_comtrade",
  observations: [observation()]
});
assert.equal(first.createdCount, 1);
assert.equal(first.updatedCount, 0);
assert.equal(store.marketTradeObservations.length, 1);
assert.equal(first.observations[0]?.tradeValueUsd, null);
assert.equal(first.observations[0]?.suppressed, true);
assert.equal(first.observations[0]?.reporterCode, "842");
assert.equal(first.observations[0]?.partnerCode, "0");
assert.equal(first.observations[0]?.commodityDescription, "Other electric lamps and lighting fittings");
const firstId = first.observations[0]!.id;
const firstCreatedAt = first.observations[0]!.createdAt;

const repeated = await upsertMarketTradeObservations(store, {
  teamId: "team_a",
  ownerId: "sales_a",
  campaignId: "campaign_shared",
  providerId: "un_comtrade",
  observations: [observation({
    reporterCountry: "usa",
    partnerCountry: "world",
    classification: "hs2022",
    tradeValueUsd: 1250000,
    netWeightKg: 12000,
    quantity: 12000,
    quantityUnit: "kg",
    suppressed: false,
    statusFlags: ["REVISED"],
    sourceRevision: "2026-07-12",
    providerRecordId: "un-comtrade:record-001-revised",
    fetchedAt: "2026-07-13T09:00:00.000Z",
    payloadHash: "b".repeat(64)
  })]
});
assert.equal(repeated.createdCount, 0);
assert.equal(repeated.updatedCount, 1);
assert.equal(store.marketTradeObservations.length, 1);
assert.equal(repeated.observations[0]?.id, firstId);
assert.equal(repeated.observations[0]?.createdAt, firstCreatedAt);
assert.equal(repeated.observations[0]?.observedAt, "2026-07-13T09:00:00.000Z");
assert.equal(repeated.observations[0]?.tradeValueUsd, 1250000);
assert.equal(repeated.observations[0]?.reporterCountry, "usa");
assert.deepEqual(repeated.observations[0]?.statusFlags, ["REVISED"]);
assert.equal(repeated.observations[0]?.sourceRevision, "2026-07-12");

const sameTeamDifferentOwner = await upsertMarketTradeObservations(store, {
  teamId: "team_a",
  ownerId: "sales_a_2",
  campaignId: "campaign_shared",
  providerId: "un_comtrade",
  observations: [observation({ tradeValueUsd: 880000 })]
});
assert.equal(sameTeamDifferentOwner.createdCount, 1);
assert.equal(sameTeamDifferentOwner.updatedCount, 0);
assert.equal(store.marketTradeObservations.length, 2);
assert.notEqual(sameTeamDifferentOwner.observations[0]?.id, firstId);
assert.equal(sameTeamDifferentOwner.observations[0]?.ownerId, "sales_a_2");
assert.equal(store.marketTradeObservations.find((item) => item.id === firstId)?.ownerId, "sales_a");

const sameBatchDuplicate = await upsertMarketTradeObservations(store, {
  teamId: "team_a",
  ownerId: "sales_a_2",
  campaignId: "campaign_shared",
  providerId: "un_comtrade",
  observations: [
    observation({ commodityCode: "940549", providerRecordId: "record-002" }),
    observation({
      commodityCode: "940549",
      providerRecordId: "record-002-revised",
      tradeValueUsd: 300
    })
  ]
});
assert.equal(sameBatchDuplicate.createdCount, 1);
assert.equal(sameBatchDuplicate.updatedCount, 0);
assert.equal(store.marketTradeObservations.length, 3);
assert.equal(sameBatchDuplicate.observations[0]?.tradeValueUsd, 300);

await upsertMarketTradeObservations(store, {
  teamId: "team_b",
  ownerId: "sales_b",
  campaignId: "campaign_shared",
  providerId: "un_comtrade",
  observations: [observation({ tradeValueUsd: 990000 })]
});
assert.equal(store.marketTradeObservations.length, 4);

await upsertMarketTradeObservations(store, {
  teamId: "team_a",
  ownerId: "sales_a",
  campaignId: "campaign_other",
  providerId: "un_comtrade",
  observations: [observation()]
});
assert.equal(store.marketTradeObservations.length, 5);

assert.equal(visibleMarketTradeObservations(store, session(adminA), "campaign_shared").length, 3);
assert.equal(visibleMarketTradeObservations(store, session(adminB), "campaign_shared").length, 1);
assert.equal(visibleMarketTradeObservations(store, session(salesA), "campaign_shared").length, 1);
assert.equal(visibleMarketTradeObservations(store, session(salesA2), "campaign_shared").length, 2);
assert.equal(visibleMarketTradeObservations(store, session(superAdmin), "campaign_shared").length, 4);
assert.equal(visibleMarketTradeObservations(store, session(adminA), "campaign_other").length, 1);

await assert.rejects(upsertMarketTradeObservations(store, {
  teamId: "team_b",
  ownerId: "sales_a",
  campaignId: "campaign_invalid",
  providerId: "un_comtrade",
  observations: [observation()]
}), /不属于当前团队/);
assert.equal(store.marketTradeObservations.length, 5);
assert.equal(persistCount, 6);

console.log("Market trade observation idempotency and tenant visibility tests passed");
