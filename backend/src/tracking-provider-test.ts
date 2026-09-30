import assert from "node:assert/strict";
import { buildTrackingUpdate, getTrackingProvider, isSyncable } from "./tracking-provider.js";

process.env.NODE_ENV = "test";
delete process.env.TRACKING_17TRACK_TOKEN;

const provider = getTrackingProvider("dhl");
assert.equal(provider.name, "mock-carrier");
const snapshot = await provider.query({
  courier: "dhl",
  trackingCode: "TEST-TRACKING-001",
  shippedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
});
assert.equal(snapshot.source, "carrier");
assert.match(snapshot.provider, /^mock:/u);
assert.ok(snapshot.events.length >= 2);
assert.ok(snapshot.events.at(-1)?.location);

assert.equal(isSyncable("draft", "  TEST-TRACKING-001  "), true);
assert.equal(isSyncable("shipped", "   "), false);
assert.equal(isSyncable("delivered", "TEST-TRACKING-001"), false);

const update = buildTrackingUpdate({ estimatedArrival: "2026-09-10" }, snapshot);
assert.equal(update.statusSource, "carrier");
assert.equal(update.syncError, "");
assert.equal(update.trackingEvents.length, snapshot.events.length);

process.env.NODE_ENV = "production";
const realProvider = getTrackingProvider("dhl");
await assert.rejects(
  () => realProvider.query({ courier: "dhl", trackingCode: "TEST-TRACKING-001" }),
  /未配置真实物流查询 Token/u
);

console.log("tracking provider tests: OK");
