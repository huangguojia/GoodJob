import assert from "node:assert/strict";
import { IntegrationWorkerRepository } from "../src/repository.js";

const now = Date.now();
const row = {
  event_id: "iev_lease_test",
  connection_id: "icx_lease_test",
  connector_code: "example-api",
  team_id: "team_lease_test",
  owner_id: "owner_lease_test",
  event_type: "customer.updated",
  external_event_id: "evt_lease_test",
  payload_hash: "a".repeat(64),
  artifact_id: "iar_lease_test",
  encrypted_payload: "encrypted",
  attempt_count: 2,
  event_status: "processing",
  connection_status: "active",
  processing_lease_expires_at: new Date(now - 1_000),
  updated_at: new Date(now - 180_000)
};

const connection = {
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
  async query() { return [[row], []]; },
  async execute(_sql: string, values: unknown[]) {
    if (String(values[values.length - 1]) === "stale-lease") return [{ affectedRows: 0 }, []];
    row.event_status = "processing";
    row.processing_lease_expires_at = new Date(now + 120_000);
    return [{ affectedRows: 1 }, []];
  }
};

const repository = new IntegrationWorkerRepository({
  async getConnection() { return connection; },
  async execute(_sql: string, values: unknown[]) {
    return connection.execute(_sql, values);
  }
} as never);

const claimed = await repository.claimWebhookEvent(row.event_id);
assert.equal(claimed.attemptCount, 3);
assert.match(claimed.leaseId, /^iwl_/u);

await assert.rejects(
  () => repository.completeWebhookEvent(row.event_id, "stale-lease", { normalized: true }),
  /状态冲突/u
);

console.log(JSON.stringify({
  ok: true,
  expiredProcessingReclaimed: true,
  leaseTokenRequiredForCompletion: true,
  staleWorkerCannotOverwrite: true
}, null, 2));
