import assert from "node:assert/strict";
import {
  readProviderResponseCache,
  writeProviderResponseCache,
  type ProviderResponseCacheKey
} from "./provider-response-cache.js";
import {
  providerRequestFingerprint,
  recordProviderCacheHit,
  withProviderRequestLogging
} from "./provider-request-logging.js";
import { getStore } from "./store.js";
import type { ProviderRequestLog } from "./types.js";

getStore().providerResponseCache.splice(0);

const key: ProviderResponseCacheKey = {
  providerId: "un_comtrade",
  providerVersion: "1.0.0",
  requestFingerprint: providerRequestFingerprint({
    reporterCodes: ["842"],
    partnerCodes: ["0"],
    flow: "import",
    commodityCodes: ["940542"],
    periods: ["2023"],
    frequency: "annual"
  }),
  licenseScope: "public_api"
};
const payload = {
  observations: [{
    reporterCountry: "USA",
    partnerCountry: "WORLD",
    tradeFlow: "IMPORT",
    classification: "HS2017",
    commodityCode: "940542",
    period: "2023",
    tradeValueUsd: 2061149344
  }],
  warnings: ["HS2022->HS2017"]
};

const metadata = await writeProviderResponseCache(key, payload, {
  fetchedAt: "2026-07-13T08:00:00.000Z",
  expiresAt: "2026-07-14T08:00:00.000Z"
});
assert.match(metadata.id, /^prc_[a-f0-9]{48}$/);
assert.equal(getStore().providerResponseCache.length, 1);
const stored = getStore().providerResponseCache[0]!;
assert.match(stored.payloadEncrypted, /^cache-v1\./);
assert.equal(stored.payloadEncrypted.includes("USA"), false);
assert.equal(stored.payloadEncrypted.includes("2061149344"), false);
assert.equal("teamId" in stored, false);
assert.equal("ownerId" in stored, false);

const hit = await readProviderResponseCache<typeof payload>(
  key,
  new Date("2026-07-13T12:00:00.000Z")
);
assert.deepEqual(hit?.payload, payload);
assert.equal(hit?.fetchedAt, "2026-07-13T08:00:00.000Z");

const versionMiss = await readProviderResponseCache({
  ...key,
  providerVersion: "2.0.0"
}, new Date("2026-07-13T12:00:00.000Z"));
assert.equal(versionMiss, null);

const licenseMiss = await readProviderResponseCache({
  ...key,
  licenseScope: "restricted"
}, new Date("2026-07-13T12:00:00.000Z"));
assert.equal(licenseMiss, null);

const restrictedKey: ProviderResponseCacheKey = {
  ...key,
  licenseScope: "restricted"
};
const restrictedPayload = {
  observations: [],
  warnings: ["restricted-scope"]
};
await writeProviderResponseCache(restrictedKey, restrictedPayload, {
  fetchedAt: "2026-07-13T08:30:00.000Z",
  expiresAt: "2026-07-14T08:30:00.000Z"
});
assert.equal(getStore().providerResponseCache.length, 2);
assert.deepEqual(
  (await readProviderResponseCache<typeof payload>(
    key,
    new Date("2026-07-13T12:00:00.000Z")
  ))?.payload,
  payload
);
assert.deepEqual(
  (await readProviderResponseCache<typeof restrictedPayload>(
    restrictedKey,
    new Date("2026-07-13T12:00:00.000Z")
  ))?.payload,
  restrictedPayload
);

const expired = await readProviderResponseCache(
  key,
  new Date("2026-07-15T00:00:00.000Z")
);
assert.equal(expired, null);

await assert.rejects(writeProviderResponseCache(key, {
  observations: [],
  teamId: "team_a"
}, {
  fetchedAt: "2026-07-13T08:00:00.000Z",
  expiresAt: "2026-07-14T08:00:00.000Z"
}), /禁止保存租户业务上下文字段/);

const tamperIndex = Math.floor(stored.payloadEncrypted.length / 2);
const encryptedByte = stored.payloadEncrypted[tamperIndex];
stored.payloadEncrypted = `${stored.payloadEncrypted.slice(0, tamperIndex)}${encryptedByte === "A" ? "B" : "A"}${stored.payloadEncrypted.slice(tamperIndex + 1)}`;
const tampered = await readProviderResponseCache(
  key,
  new Date("2026-07-13T12:00:00.000Z")
);
assert.equal(tampered, null);
assert.equal(stored.status, "invalid");

await writeProviderResponseCache(key, payload, {
  fetchedAt: "2026-07-13T09:00:00.000Z",
  expiresAt: "2026-07-14T09:00:00.000Z"
});
assert.equal(getStore().providerResponseCache.length, 2);
assert.equal(stored.status, "active");
assert.equal(stored.fetchedAt, "2026-07-13T09:00:00.000Z");

const logs: ProviderRequestLog[] = [];
await withProviderRequestLogging({
  teamId: "team_a",
  ownerId: "owner_a",
  providerId: "un_comtrade",
  connectionId: "",
  runId: "run_cache_test",
  runShardId: "run_cache_test_un_comtrade",
  requestFingerprint: key.requestFingerprint,
  endpointCode: "trade_cache"
}, async () => {
  recordProviderCacheHit("2026-07-13T09:01:00.000Z");
}, (items) => logs.push(...items));
assert.equal(logs.length, 1);
assert.equal(logs[0]?.quotaUnits, 0);
assert.equal(logs[0]?.teamId, "team_a");
assert.equal(logs[0]?.ownerId, "owner_a");
assert.equal(JSON.stringify(logs).includes("2061149344"), false);

getStore().providerResponseCache.splice(0);
console.log("Provider response cache tests passed");
