import assert from "node:assert/strict";
import { validateIntegrationControlPlaneConfig } from "./integration-runtime-config.js";

assert.deepEqual(validateIntegrationControlPlaneConfig({}, false), {
  enabled: false,
  workerEnabled: false,
  oauthCallbackBaseUrl: "",
  oauthSuccessRedirectUrl: ""
});
assert.throws(() => validateIntegrationControlPlaneConfig({
  INTEGRATION_WORKER_ENABLED: "true"
}, true), /控制面关闭/u);
assert.throws(() => validateIntegrationControlPlaneConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters"
}, false), /MySQL/u);
assert.throws(() => validateIntegrationControlPlaneConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters"
}, true), /REDIS_URL/u);
assert.throws(() => validateIntegrationControlPlaneConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  REDIS_URL: "https://redis.internal",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters"
}, true), /redis/u);
assert.deepEqual(validateIntegrationControlPlaneConfig({
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  REDIS_URL: "rediss://redis.internal:6380/2",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters"
}, true), { enabled: true, workerEnabled: true, oauthCallbackBaseUrl: "", oauthSuccessRedirectUrl: "" });
assert.throws(() => validateIntegrationControlPlaneConfig({
  NODE_ENV: "production",
  INTEGRATION_ENABLED: "true",
  INTEGRATION_WORKER_ENABLED: "true",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  INTEGRATION_CREDENTIAL_KEY: "integration-test-key-with-at-least-32-characters",
  INTEGRATION_OAUTH_CALLBACK_BASE_URL: "http://crm.example.test"
}, true), /HTTPS/u);

console.log(JSON.stringify({
  ok: true,
  featureFlagDefaultOff: true,
  mysqlFailClosed: true,
  redisFailClosed: true,
  credentialFailClosed: true
}, null, 2));
