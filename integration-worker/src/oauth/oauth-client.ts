import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthTokens
} from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint, type EndpointPolicy } from "../network-policy.js";
import type { WorkerConnectorManifest } from "../repository.js";
import type { OAuthTransactionContext, StoredOAuthCredential } from "./oauth-types.js";

function canonicalResource(value: string | URL) {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function endpointPolicy(manifest: WorkerConnectorManifest): EndpointPolicy {
  return {
    allowedHosts: manifest.approvedHosts,
    allowedPorts: manifest.allowedPorts,
    allowInsecureLoopback: process.env.NODE_ENV === "test" && manifest.allowInsecureLoopback === true,
    maxRedirects: 2
  };
}

function clientInformation(manifest: WorkerConnectorManifest): OAuthClientInformationMixed {
  const oauth = manifest.oauth;
  if (!oauth?.clientId) throw new Error("INTEGRATION_CONNECTOR_INVALID: OAuth clientId 未配置");
  let clientSecret = "";
  if (oauth.clientSecretEnv) {
    if (!/^INTEGRATION_OAUTH_[A-Z0-9_]{3,100}$/u.test(oauth.clientSecretEnv)) {
      throw new Error("INTEGRATION_CONNECTOR_INVALID: OAuth secret 环境变量名不合法");
    }
    clientSecret = String(process.env[oauth.clientSecretEnv] || "");
    if (!clientSecret) throw new Error("INTEGRATION_CONNECTOR_INVALID: OAuth client secret 未配置");
  }
  return {
    client_id: oauth.clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    token_endpoint_auth_method: clientSecret ? "client_secret_post" : "none"
  } as OAuthClientInformationMixed;
}

function validateResourceBinding(resourceUri: string, discoveredResource?: string) {
  if (discoveredResource && canonicalResource(discoveredResource) !== canonicalResource(resourceUri)) {
    throw new Error("INTEGRATION_OAUTH_RESOURCE_MISMATCH: OAuth protected resource 与连接器目标不一致");
  }
}

function validateJwtAudience(accessToken: string, resourceUri: string) {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("INTEGRATION_OAUTH_TOKEN_INVALID: JWT access token 无法解析");
  }
  if (!payload.aud) return;
  const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
  const resource = new URL(resourceUri);
  const accepted = new Set([canonicalResource(resource), resource.origin]);
  if (!audience.some((value) => accepted.has(canonicalResource(value)))) {
    throw new Error("INTEGRATION_OAUTH_RESOURCE_MISMATCH: access token audience 不属于目标 MCP 资源");
  }
}

function validateJwtAudienceForManifest(accessToken: string, resourceUri: string, manifest: WorkerConnectorManifest) {
  const acceptedAudiences = manifest.oauth?.acceptedAudiences || [];
  if (!acceptedAudiences.length) {
    validateJwtAudience(accessToken, resourceUri);
    return;
  }
  const parts = accessToken.split(".");
  if (parts.length !== 3) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("INTEGRATION_OAUTH_TOKEN_INVALID: JWT access token 无法解析");
  }
  if (!payload.aud) return;
  const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
  if (!audience.some((value) => acceptedAudiences.includes(value))) {
    throw new Error("INTEGRATION_OAUTH_RESOURCE_MISMATCH: access token audience 不属于连接器固定资源");
  }
}

async function fixedOidcMetadata(manifest: WorkerConnectorManifest, fetchFn: typeof fetch) {
  const oauth = manifest.oauth;
  if (!oauth?.authorizationServerUrl || !oauth.metadataUrl) {
    throw new Error("INTEGRATION_CONNECTOR_INVALID: 固定 OIDC metadata 未配置");
  }
  await validateMcpEndpoint(oauth.authorizationServerUrl, endpointPolicy(manifest));
  await validateMcpEndpoint(oauth.metadataUrl, endpointPolicy(manifest));
  const response = await fetchFn(oauth.metadataUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new Error(`INTEGRATION_OAUTH_METADATA_INVALID: OIDC metadata 获取失败 (${response.status})`);
  }
  const metadata = await response.json() as AuthorizationServerMetadata;
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint || !metadata.issuer) {
    throw new Error("INTEGRATION_OAUTH_METADATA_INVALID: 授权服务器 metadata 不完整");
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, String((metadata as Record<string, unknown>).userinfo_endpoint || "")].filter(Boolean)) {
    await validateMcpEndpoint(endpoint, endpointPolicy(manifest));
  }
  return { metadata, authorizationServerUrl: oauth.authorizationServerUrl };
}

async function accountSummary(
  metadata: AuthorizationServerMetadata,
  tokens: OAuthTokens,
  fetchFn: typeof fetch,
  issuer: string,
  resourceUri: string
) {
  const endpoint = String((metadata as Record<string, unknown>).userinfo_endpoint || "");
  let profile: Record<string, unknown> = {};
  if (endpoint) {
    const response = await fetchFn(endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" }
    });
    if (response.ok) {
      const value = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value)) profile = value as Record<string, unknown>;
    } else {
      await response.text().catch(() => "");
    }
  }
  return {
    authorizationIssuer: issuer,
    resourceUri,
    account: {
      id: String(profile.sub || ""),
      name: String(profile.name || profile.preferred_username || ""),
      email: String(profile.email || ""),
      organization: String(profile.organization || profile.hd || profile.tenant || "")
    },
    grantedScopes: String(tokens.scope || "").split(/\s+/u).filter(Boolean)
  };
}

export interface PreparedAuthorization {
  context: OAuthTransactionContext;
  issuer: string;
  resourceUri: string;
}

export async function prepareOAuthAuthorization(
  manifest: WorkerConnectorManifest,
  context: OAuthTransactionContext,
  redirectUri: string
): Promise<PreparedAuthorization> {
  if (manifest.authentication !== "oauth2") throw new Error("INTEGRATION_OAUTH_NOT_SUPPORTED: 连接器不使用 OAuth");
  const policy = endpointPolicy(manifest);
  const endpoint = await validateMcpEndpoint(manifest.endpoint, policy);
  const fetchFn = createValidatedFetch(policy);
  const fixedOidc = manifest.oauth?.profile === "fixed_oidc";
  const serverInfo = fixedOidc ? null : await discoverOAuthServerInfo(endpoint, { fetchFn });
  const fixed = fixedOidc ? await fixedOidcMetadata(manifest, fetchFn) : null;
  const metadata = fixed?.metadata || serverInfo?.authorizationServerMetadata;
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("INTEGRATION_OAUTH_METADATA_INVALID: 授权服务器 metadata 不完整");
  }
  if (serverInfo) validateResourceBinding(context.resourceUri, serverInfo.resourceMetadata?.resource);
  const authorizationServerUrl = fixed?.authorizationServerUrl || serverInfo!.authorizationServerUrl;
  const issuer = metadata.issuer || authorizationServerUrl;
  const resource = manifest.oauth?.useResourceParameter === false ? undefined : endpoint;
  const started = await startAuthorization(authorizationServerUrl, {
    metadata,
    clientInformation: clientInformation(manifest),
    redirectUrl: redirectUri,
    scope: context.requestedScopes.join(" ") || undefined,
    state: context.state,
    ...(resource ? { resource } : {})
  });
  await validateMcpEndpoint(started.authorizationUrl, policy);
  started.authorizationUrl.searchParams.set("nonce", context.nonce);
  return {
    issuer,
    resourceUri: canonicalResource(endpoint),
    context: {
      ...context,
      authorizationUrl: started.authorizationUrl.toString(),
      authorizationHost: started.authorizationUrl.host,
      codeVerifier: started.codeVerifier,
      authorizationServerUrl,
      issuer,
      metadata: metadata as unknown as Record<string, unknown>
    }
  };
}

export async function exchangeOAuthCode(
  manifest: WorkerConnectorManifest,
  context: OAuthTransactionContext,
  redirectUri: string
) {
  if (!context.authorizationCode || !context.codeVerifier || !context.authorizationServerUrl || !context.metadata) {
    throw new Error("INTEGRATION_OAUTH_STATE_INVALID: 授权事务缺少代码交换上下文");
  }
  const policy = endpointPolicy(manifest);
  const fetchFn = createValidatedFetch(policy);
  const metadata = context.metadata as unknown as AuthorizationServerMetadata;
  const tokens = await exchangeAuthorization(context.authorizationServerUrl, {
    metadata,
    clientInformation: clientInformation(manifest),
    authorizationCode: context.authorizationCode,
    iss: context.callbackIssuer || undefined,
    codeVerifier: context.codeVerifier,
    redirectUri,
    ...(manifest.oauth?.useResourceParameter === false ? {} : { resource: new URL(context.resourceUri) }),
    fetchFn
  });
  validateJwtAudienceForManifest(tokens.access_token, context.resourceUri, manifest);
  const issuer = metadata.issuer || context.issuer || context.authorizationServerUrl;
  const summary = await accountSummary(metadata, tokens, fetchFn, issuer, context.resourceUri);
  const credential: StoredOAuthCredential = {
    tokens,
    authorizationServerUrl: context.authorizationServerUrl,
    issuer,
    resourceUri: context.resourceUri,
    clientId: manifest.oauth!.clientId,
    scopes: context.requestedScopes,
    metadata: context.metadata
  };
  return { credential, accountSummary: summary };
}

export async function refreshOAuthCredential(manifest: WorkerConnectorManifest, credential: StoredOAuthCredential) {
  const refreshToken = credential.tokens.refresh_token;
  if (!refreshToken) throw new Error("invalid_grant: OAuth 凭据没有 refresh token");
  const fetchFn = createValidatedFetch(endpointPolicy(manifest));
  const tokens = await refreshAuthorization(credential.authorizationServerUrl, {
    metadata: credential.metadata as unknown as AuthorizationServerMetadata,
    clientInformation: clientInformation(manifest),
    refreshToken,
    ...(manifest.oauth?.useResourceParameter === false ? {} : { resource: new URL(credential.resourceUri) }),
    fetchFn
  });
  validateJwtAudienceForManifest(tokens.access_token, credential.resourceUri, manifest);
  return { ...credential, tokens } satisfies StoredOAuthCredential;
}

export async function revokeOAuthCredential(manifest: WorkerConnectorManifest, credential: StoredOAuthCredential) {
  const metadata = credential.metadata as Record<string, unknown>;
  const endpoint = String(metadata.revocation_endpoint || "");
  if (!endpoint) return { remoteRevocationSupported: false };
  const client = clientInformation(manifest) as Record<string, unknown>;
  const token = credential.tokens.refresh_token || credential.tokens.access_token;
  const body = new URLSearchParams({
    token,
    token_type_hint: credential.tokens.refresh_token ? "refresh_token" : "access_token",
    client_id: String(client.client_id || "")
  });
  if (client.client_secret) body.set("client_secret", String(client.client_secret));
  const response = await createValidatedFetch(endpointPolicy(manifest))(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new Error(`INTEGRATION_OAUTH_REVOKE_FAILED: OAuth 撤销失败 (${response.status})`);
  }
  await response.text().catch(() => "");
  return { remoteRevocationSupported: true };
}

export function oauthCredentialExpiresAt(tokens: OAuthTokens) {
  const seconds = Number(tokens.expires_in || 0);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1_000).toISOString() : null;
}

export function isInvalidGrant(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid_grant|refresh token.*(?:invalid|expired|revoked)|unauthorized_client/iu.test(message);
}
