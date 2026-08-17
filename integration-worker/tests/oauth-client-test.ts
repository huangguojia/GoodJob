import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  exchangeOAuthCode,
  isInvalidGrant,
  oauthCredentialExpiresAt,
  prepareOAuthAuthorization,
  refreshOAuthCredential,
  revokeOAuthCredential
} from "../src/oauth/oauth-client.js";
import type { OAuthTransactionContext } from "../src/oauth/oauth-types.js";
import type { WorkerConnectorManifest } from "../src/repository.js";

let baseUrl = "";
let expectedChallenge = "";
let refreshCalls = 0;
let revokeCalls = 0;
const json = (response: import("node:http").ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const jwt = (audience: string, subject = "buyer-123") => [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ aud: audience, sub: subject })).toString("base64url"),
  "test-signature"
].join(".");

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", baseUrl || "http://127.0.0.1");
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    json(response, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], scopes_supported: ["mcp.tools.read"] });
    return;
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    json(response, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      revocation_endpoint: `${baseUrl}/revoke`,
      userinfo_endpoint: `${baseUrl}/userinfo`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp.tools.read"]
    });
    return;
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (body.get("grant_type") === "authorization_code") {
      const verifier = body.get("code_verifier") || "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      assert.equal(challenge, expectedChallenge);
      assert.equal(body.get("code"), "fake-code");
      assert.equal(body.get("resource"), `${baseUrl}/mcp`);
      json(response, {
        access_token: jwt(`${baseUrl}/mcp`),
        refresh_token: "refresh-one",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp.tools.read"
      });
      return;
    }
    if (body.get("grant_type") === "refresh_token") {
      refreshCalls += 1;
      assert.equal(body.get("refresh_token"), "refresh-one");
      json(response, {
        access_token: jwt(`${baseUrl}/mcp`, "buyer-456"),
        token_type: "Bearer",
        expires_in: 7200,
        scope: "mcp.tools.read"
      });
      return;
    }
  }
  if (url.pathname === "/userinfo") {
    json(response, { sub: "buyer-123", name: "Test Buyer", email: "buyer@example.test", organization: "Example Trading" });
    return;
  }
  if (url.pathname === "/revoke" && request.method === "POST") {
    revokeCalls += 1;
    response.writeHead(200);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fake OAuth server failed");
baseUrl = `http://127.0.0.1:${address.port}`;
const manifest: WorkerConnectorManifest = {
  endpoint: `${baseUrl}/mcp`,
  approvedHosts: ["127.0.0.1"],
  allowedPorts: [address.port],
  allowInsecureLoopback: true,
  authentication: "oauth2",
  oauth: { clientId: "goodjob-test-client", scopes: ["mcp.tools.read"] }
};
const context: OAuthTransactionContext = {
  state: "state-test-value",
  nonce: "nonce-test-value",
  connectorCode: "fake-oauth-mcp",
  resourceUri: manifest.endpoint,
  requestedScopes: ["mcp.tools.read"]
};

try {
  const prepared = await prepareOAuthAuthorization(manifest, context, "https://crm.example.test/api/integrations/oauth/callback/fake-oauth-mcp");
  const authorizationUrl = new URL(prepared.context.authorizationUrl!);
  assert.equal(authorizationUrl.origin, baseUrl);
  assert.equal(authorizationUrl.searchParams.get("state"), context.state);
  assert.equal(authorizationUrl.searchParams.get("nonce"), context.nonce);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  expectedChallenge = authorizationUrl.searchParams.get("code_challenge") || "";
  assert.ok(expectedChallenge);

  const exchanged = await exchangeOAuthCode(manifest, {
    ...prepared.context,
    authorizationCode: "fake-code",
    callbackIssuer: baseUrl
  }, "https://crm.example.test/api/integrations/oauth/callback/fake-oauth-mcp");
  assert.equal((exchanged.accountSummary.account as Record<string, unknown>).email, "buyer@example.test");
  assert.equal(exchanged.credential.tokens.refresh_token, "refresh-one");
  assert.ok(oauthCredentialExpiresAt(exchanged.credential.tokens));

  const refreshed = await refreshOAuthCredential(manifest, exchanged.credential);
  assert.equal(refreshCalls, 1);
  assert.equal(refreshed.tokens.refresh_token, "refresh-one");
  assert.notEqual(refreshed.tokens.access_token, exchanged.credential.tokens.access_token);
  const revoked = await revokeOAuthCredential(manifest, refreshed);
  assert.equal(revoked.remoteRevocationSupported, true);
  assert.equal(revokeCalls, 1);
  assert.equal(isInvalidGrant(new Error("invalid_grant")), true);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(JSON.stringify({
  ok: true,
  metadataDiscovery: true,
  pkceS256Verified: true,
  issuerAndResourceBound: true,
  authorizationCodeExchange: true,
  accountConfirmationSummary: true,
  refreshTokenRotationPreserved: true,
  remoteRevocation: true
}, null, 2));
