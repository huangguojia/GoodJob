import type { CallToolResult } from "@modelcontextprotocol/client";
import type {
  ConnectorDriverContract,
  DriverHealthResult
} from "@goodjob/integration-connector-sdk";
import type { DiscoveredToolSnapshot } from "../mcp/tool-schema.js";
import type { OAuthTransactionContext, StoredOAuthCredential } from "../oauth/oauth-types.js";
import type { WorkerConnectorManifest } from "../repository.js";

export interface DriverDiscoveryResult {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  capabilities: Record<string, unknown>;
  tools: DiscoveredToolSnapshot[];
}

export interface DriverRuntimeContext {
  connectionId: string;
  manifest: WorkerConnectorManifest;
  timeoutMs: number;
  maxResponseBytes: number;
  accessToken?: string;
  tokenFingerprint?: string;
  credentials?: Readonly<Record<string, string>>;
  requestId?: string;
}

export interface DriverAuthorizationResult {
  credential: StoredOAuthCredential;
  accountSummary: Record<string, unknown>;
}

export interface DriverWebhookSubscription {
  id: string;
  resource: string;
  changeTypes: string;
  expiresAt: string;
}

export interface DriverWebhookRegistrationInput {
  notificationUrl: string;
  clientState: string;
  resource: string;
  changeTypes: string;
}

export interface ConnectorDriver extends ConnectorDriverContract<DriverRuntimeContext, DriverDiscoveryResult, CallToolResult> {
  readonly type: "native_mcp" | "microsoft_graph" | "google_workspace" | "google_drive" | "erpnext" | "easypost" | "wecom";
  validateConfiguration(manifest: WorkerConnectorManifest): Promise<void> | void;
  healthCheck(context: DriverRuntimeContext): Promise<DriverHealthResult<DriverDiscoveryResult>>;
  prepareAuthorization(
    manifest: WorkerConnectorManifest,
    context: OAuthTransactionContext,
    redirectUri: string
  ): Promise<{ context: OAuthTransactionContext; issuer: string; resourceUri: string }>;
  completeAuthorization(
    manifest: WorkerConnectorManifest,
    context: OAuthTransactionContext,
    redirectUri: string
  ): Promise<DriverAuthorizationResult>;
  refreshCredential(manifest: WorkerConnectorManifest, credential: StoredOAuthCredential): Promise<StoredOAuthCredential>;
  revokeCredential(manifest: WorkerConnectorManifest, credential: StoredOAuthCredential): Promise<{ remoteRevocationSupported: boolean }>;
  discoverTools(context: DriverRuntimeContext): Promise<DriverDiscoveryResult>;
  invokeTool(
    context: DriverRuntimeContext,
    remoteName: string,
    input: Record<string, unknown>
  ): Promise<CallToolResult>;
  registerWebhook?(context: DriverRuntimeContext, input: DriverWebhookRegistrationInput): Promise<DriverWebhookSubscription>;
  renewWebhook?(context: DriverRuntimeContext, subscriptionId: string): Promise<DriverWebhookSubscription>;
  unregisterWebhook?(context: DriverRuntimeContext, subscriptionId: string): Promise<void>;
  closeConnection(connectionId: string): Promise<void>;
}
