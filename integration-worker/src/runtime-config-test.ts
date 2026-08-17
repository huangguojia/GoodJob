import assert from "node:assert/strict";
import {
  loadIntegrationWorkerConfig,
  redisConnectionOptions,
  validateIntegrationRedisUrl
} from "./runtime-config.js";

const disabled = loadIntegrationWorkerConfig({});
assert.equal(disabled.enabled, false);
assert.equal(disabled.host, "127.0.0.1");

const enabled = loadIntegrationWorkerConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  DATABASE_URL: "mysql://crm:secret@127.0.0.1:3306/goodjob",
  REDIS_URL: "rediss://worker:secret@redis.internal:6380/2",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters"
});
assert.equal(enabled.enabled, true);
assert.equal(enabled.workerEnabled, true);
assert.equal(enabled.credentialKeyConfigured, true);
assert.equal(enabled.queueName, "goodjob:integration:tool-calls");
assert.equal(enabled.controlQueueName, "goodjob:integration:control");
assert.equal(enabled.eventQueueName, "goodjob:integration:events");

const redis = redisConnectionOptions(enabled.redisUrl);
assert.equal(redis.host, "redis.internal");
assert.equal(redis.port, 6380);
assert.equal(redis.db, 2);
assert.ok(redis.tls);

assert.throws(() => loadIntegrationWorkerConfig({ INTEGRATION_ENABLED: "true" }), /WORKER_ENABLED/u);
assert.throws(() => loadIntegrationWorkerConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  DATABASE_URL: "sqlite:///tmp/crm.db",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters"
}), /MySQL/u);
assert.throws(() => loadIntegrationWorkerConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  DATABASE_URL: "mysql://crm:secret@127.0.0.1:3306/goodjob",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  INTEGRATION_CREDENTIAL_KEY: "short"
}), /32/u);
assert.throws(() => validateIntegrationRedisUrl("https://redis.internal"), /redis/u);
assert.throws(() => validateIntegrationRedisUrl("redis://127.0.0.1/1/2"), /路径/u);

console.log(JSON.stringify({
  ok: true,
  disabledByDefault: true,
  mysqlRequired: true,
  redisRequired: true,
  credentialKeyRequired: true,
  loopbackOnly: enabled.host === "127.0.0.1"
}, null, 2));
