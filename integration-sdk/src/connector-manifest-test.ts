import assert from "node:assert/strict";
import {
  assertConnectorDriverContract,
  canonicalManifestJson,
  connectorManifestHash,
  validateConnectorManifest
} from "./connector-manifest.js";

const manifest = validateConnectorManifest({
  schemaVersion: "1.0",
  stage: "available",
  driver: "native_mcp",
  endpoint: "https://mcp.example.test/mcp",
  approvedHosts: ["mcp.example.test"],
  allowedPorts: [443],
  authentication: "none",
  maxTools: 100
}, { requireSchemaVersion: true });
assert.equal(manifest.endpoint, "https://mcp.example.test/mcp");
assert.equal(connectorManifestHash(manifest).length, 64);
assert.equal(canonicalManifestJson({ ...manifest, approvedHosts: [...manifest.approvedHosts] }), canonicalManifestJson(manifest));
assert.throws(() => validateConnectorManifest({ ...manifest, unexpected: true }), /未支持字段/u);
assert.throws(() => validateConnectorManifest({ ...manifest, endpoint: "http://mcp.example.test/mcp" }), /HTTPS/u);
assert.throws(() => validateConnectorManifest({ ...manifest, endpoint: "https://other.example.test/mcp" }), /approvedHosts/u);
assert.throws(() => validateConnectorManifest({ ...manifest, allowInsecureLoopback: true }), /生产环境/u);
assert.throws(() => validateConnectorManifest({ ...manifest, authentication: "none", oauth: { clientId: "secret" } }), /不能提供 oauth/u);
assert.doesNotThrow(() => validateConnectorManifest({
  schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443]
}, { requireSchemaVersion: true }));
assert.equal(validateConnectorManifest({
  schemaVersion: "1.0",
  stage: "available",
  driver: "google_workspace",
  endpoint: "https://www.googleapis.com/",
  approvedHosts: ["www.googleapis.com", "accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com"],
  allowedPorts: [443],
  authentication: "oauth2",
  oauth: {
    profile: "fixed_oidc",
    clientId: "google-client-id",
    scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
    authorizationServerUrl: "https://accounts.google.com/",
    metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
    acceptedAudiences: ["google-client-id"],
    useResourceParameter: false
  },
  maxTools: 9
}, { requireSchemaVersion: true }).driver, "google_workspace");
assert.equal(validateConnectorManifest({
  schemaVersion: "1.0",
  stage: "available",
  driver: "easypost",
  endpoint: "https://api.easypost.com/v2/",
  approvedHosts: ["api.easypost.com"],
  allowedPorts: [443],
  authentication: "api_token",
  credentialFields: [{ key: "apiKey", label: "API Key", secret: true, minLength: 8, maxLength: 500 }],
  maxTools: 3
}, { requireSchemaVersion: true }).authentication, "api_token");
assert.throws(() => validateConnectorManifest({
  ...manifest,
  authentication: "api_token",
  credentialFields: [{ key: "apiKey", label: "API Key", secret: false, minLength: 8, maxLength: 500 }]
}), /敏感字段/u);
assert.doesNotThrow(() => assertConnectorDriverContract({
  type: "native_mcp",
  validateConfiguration() {},
  async discoverTools() {},
  async invokeTool() {},
  async healthCheck() { return { ok: true, latencyMs: 1, checkedAt: new Date().toISOString() }; },
  async closeConnection() {}
}));

console.log(JSON.stringify({
  ok: true,
  strictManifest: true,
  canonicalHash: true,
  endpointAllowlist: true,
  productionLoopbackDenied: true,
  driverContractValidated: true,
  googleWorkspaceManifestValidated: true,
  apiTokenManifestValidated: true
}, null, 2));
