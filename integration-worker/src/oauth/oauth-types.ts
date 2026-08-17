import type { OAuthTokens } from "@modelcontextprotocol/client";

export interface OAuthTransactionContext {
  state: string;
  nonce: string;
  connectorCode: string;
  resourceUri: string;
  requestedScopes: string[];
  authorizationUrl?: string;
  authorizationHost?: string;
  codeVerifier?: string;
  authorizationServerUrl?: string;
  issuer?: string;
  metadata?: Record<string, unknown>;
  authorizationCode?: string;
  callbackIssuer?: string;
}

export interface StoredOAuthCredential {
  tokens: OAuthTokens;
  authorizationServerUrl: string;
  issuer: string;
  resourceUri: string;
  clientId: string;
  scopes: string[];
  metadata: Record<string, unknown>;
}
