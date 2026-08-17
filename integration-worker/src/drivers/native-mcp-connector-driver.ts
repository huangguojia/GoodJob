import type { NativeMcpClientOptions } from "../mcp/native-mcp-client.js";
import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import { McpSessionManager } from "../mcp/mcp-session-manager.js";
import {
  exchangeOAuthCode,
  prepareOAuthAuthorization,
  refreshOAuthCredential,
  revokeOAuthCredential
} from "../oauth/oauth-client.js";
import type { OAuthTransactionContext, StoredOAuthCredential } from "../oauth/oauth-types.js";
import type { WorkerConnectorManifest } from "../repository.js";
import type { ConnectorDriver, DriverRuntimeContext } from "./connector-driver.js";

export class NativeMcpConnectorDriver implements ConnectorDriver {
  readonly type = "native_mcp";

  constructor(private readonly sessions: McpSessionManager) {}

  validateConfiguration(manifest: WorkerConnectorManifest) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["native_mcp"]
    });
  }

  private clientOptions(context: DriverRuntimeContext): NativeMcpClientOptions {
    return {
      endpoint: context.manifest.endpoint,
      endpointPolicy: {
        allowedHosts: context.manifest.approvedHosts,
        allowedPorts: context.manifest.allowedPorts,
        allowInsecureLoopback: process.env.NODE_ENV === "test" && context.manifest.allowInsecureLoopback === true,
        maxRedirects: 2
      },
      timeoutMs: context.timeoutMs,
      maxResponseBytes: context.maxResponseBytes,
      accessToken: context.accessToken,
      tokenFingerprint: context.tokenFingerprint
    };
  }

  prepareAuthorization(manifest: WorkerConnectorManifest, context: OAuthTransactionContext, redirectUri: string) {
    return prepareOAuthAuthorization(manifest, context, redirectUri);
  }

  completeAuthorization(manifest: WorkerConnectorManifest, context: OAuthTransactionContext, redirectUri: string) {
    return exchangeOAuthCode(manifest, context, redirectUri);
  }

  refreshCredential(manifest: WorkerConnectorManifest, credential: StoredOAuthCredential) {
    return refreshOAuthCredential(manifest, credential);
  }

  revokeCredential(manifest: WorkerConnectorManifest, credential: StoredOAuthCredential) {
    return revokeOAuthCredential(manifest, credential);
  }

  async discoverTools(context: DriverRuntimeContext) {
    const client = await this.sessions.get(context.connectionId, this.clientOptions(context));
    return client.discoverTools();
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const client = await this.sessions.get(context.connectionId, this.clientOptions(context));
    return client.callTool(remoteName, input);
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    const discovery = await this.discoverTools(context);
    return { ok: true as const, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), discovery };
  }

  closeConnection(connectionId: string) {
    return this.sessions.closeConnection(connectionId);
  }
}
