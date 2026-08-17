import {
  exchangeOAuthCode,
  prepareOAuthAuthorization,
  refreshOAuthCredential,
  revokeOAuthCredential
} from "../oauth/oauth-client.js";
import type { OAuthTransactionContext, StoredOAuthCredential } from "../oauth/oauth-types.js";
import type { WorkerConnectorManifest } from "../repository.js";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ConnectorDriver, DriverDiscoveryResult, DriverRuntimeContext } from "./connector-driver.js";
import type { DriverHealthResult } from "@goodjob/integration-connector-sdk";

export abstract class OfficialApiConnectorDriver implements ConnectorDriver {
  abstract readonly type: "native_mcp" | "microsoft_graph" | "google_workspace" | "google_drive" | "erpnext" | "easypost" | "wecom";
  abstract validateConfiguration(manifest: WorkerConnectorManifest): Promise<void> | void;
  abstract discoverTools(context: DriverRuntimeContext): Promise<DriverDiscoveryResult>;
  abstract invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>): Promise<CallToolResult>;
  abstract healthCheck(context: DriverRuntimeContext): Promise<DriverHealthResult<DriverDiscoveryResult>>;

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

  async closeConnection(_connectionId: string) {}
}
