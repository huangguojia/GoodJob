import { createHmac, randomUUID } from "node:crypto";
import { decryptValue, encryptValue } from "./credential-vault.js";
import { ConnectorDriverRegistry } from "./drivers/connector-driver-registry.js";
import type { DriverRuntimeContext } from "./drivers/connector-driver.js";
import { canonicalJson, sha256 } from "./mcp/tool-schema.js";
import { IntegrationWorkerRepository } from "./repository.js";
import { sanitizeToolResult } from "./result-sanitizer.js";
import { isInvalidGrant, oauthCredentialExpiresAt } from "./oauth/oauth-client.js";
import type { OAuthTransactionContext, StoredOAuthCredential } from "./oauth/oauth-types.js";

export class IntegrationExecutionService {
  constructor(
    private readonly repository: IntegrationWorkerRepository,
    private readonly drivers: ConnectorDriverRegistry,
    private readonly credentialKey: string,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
    private readonly artifactRetentionDays: number,
    private readonly webhookBaseUrl = ""
  ) {}

  private webhookClientState(context: { teamId: string; ownerId: string; connectionId: string; webhookPublicId?: string }) {
    if (!context.webhookPublicId) throw new Error("INTEGRATION_WEBHOOK_NOT_CONFIGURED: 连接缺少 Webhook 标识");
    return createHmac("sha256", this.credentialKey)
      .update(`goodjob-webhook-v1\n${context.teamId}\n${context.ownerId}\n${context.connectionId}\n${context.webhookPublicId}`)
      .digest("base64url");
  }

  private webhookNotificationUrl(context: { connectorCode?: string; webhookPublicId?: string }) {
    if (!this.webhookBaseUrl || !context.connectorCode || !context.webhookPublicId) {
      throw new Error("INTEGRATION_WEBHOOK_NOT_CONFIGURED: 未配置 Microsoft 365 Webhook 公网地址");
    }
    return new URL(`/api/integrations/webhooks/${encodeURIComponent(context.connectorCode)}/${encodeURIComponent(context.webhookPublicId)}`, `${this.webhookBaseUrl.replace(/\/+$/u, "/")}`).toString();
  }

  private async driverContext(context: Awaited<ReturnType<IntegrationWorkerRepository["loadConnectionContext"]>>): Promise<DriverRuntimeContext> {
    const base: DriverRuntimeContext = {
      connectionId: context.connectionId,
      manifest: context.manifest,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes
    };
    if (!context.manifest.authentication || context.manifest.authentication === "none") return base;
    const credential = await this.repository.loadCredentialByConnection(context.connectionId);
    if (!credential) throw new Error("INTEGRATION_REAUTH_REQUIRED: 连接凭据不存在或已撤销");
    if (context.manifest.authentication === "api_token") {
      if (credential.credentialType !== "api_token") throw new Error("INTEGRATION_REAUTH_REQUIRED: API 凭据类型不匹配");
      const credentials = decryptValue<Record<string, string>>(credential.encryptedValue, this.credentialKey, {
        teamId: credential.teamId,
        ownerId: credential.ownerId,
        connectionId: credential.connectionId,
        artifactType: "api_token"
      });
      return { ...base, credentials: Object.freeze({ ...credentials }), tokenFingerprint: credential.tokenFingerprint };
    }
    if (credential.credentialType !== "oauth_token") throw new Error("INTEGRATION_REAUTH_REQUIRED: OAuth 凭据类型不匹配");
    const stored = decryptValue<StoredOAuthCredential>(credential.encryptedValue, this.credentialKey, {
      teamId: credential.teamId,
      ownerId: credential.ownerId,
      connectionId: credential.connectionId,
      artifactType: "oauth_token"
    });
    return { ...base, accessToken: stored.tokens.access_token, tokenFingerprint: credential.tokenFingerprint };
  }

  async prepareAuthorization(transactionId: string) {
    const transaction = await this.repository.loadAuthTransaction(transactionId);
    if (transaction.transactionStatus !== "created" || transaction.status !== "authorizing") {
      throw new Error("INTEGRATION_OAUTH_STATE_INVALID: 授权事务不能准备");
    }
    if (new Date(transaction.expiresAt).getTime() <= Date.now()) {
      throw new Error("INTEGRATION_OAUTH_STATE_INVALID: 授权事务已过期");
    }
    try {
      const context = decryptValue<OAuthTransactionContext>(transaction.encryptedContext, this.credentialKey, {
        teamId: transaction.teamId,
        ownerId: transaction.ownerId,
        connectionId: transaction.connectionId,
        artifactType: "oauth_transaction"
      });
      const driver = this.drivers.resolve(transaction.manifest);
      const prepared = await driver.prepareAuthorization(transaction.manifest, context, transaction.redirectUri);
      const encryptedContext = encryptValue(prepared.context, this.credentialKey, {
        teamId: transaction.teamId,
        ownerId: transaction.ownerId,
        connectionId: transaction.connectionId,
        artifactType: "oauth_transaction"
      });
      await this.repository.markAuthorizationReady({
        transaction,
        encryptedContext,
        issuer: prepared.issuer,
        resourceUri: prepared.resourceUri
      });
      return { transactionId, status: "authorize_url_ready", authorizationHost: prepared.context.authorizationHost };
    } catch (error) {
      await this.repository.markAuthorizationFailed(transactionId, error);
      throw error;
    }
  }

  async completeAuthorization(transactionId: string) {
    const transaction = await this.repository.loadAuthTransaction(transactionId);
    if (transaction.transactionStatus !== "callback_received" || transaction.status !== "authorizing") {
      throw new Error("INTEGRATION_OAUTH_STATE_INVALID: 授权回调不能完成");
    }
    try {
      const context = decryptValue<OAuthTransactionContext>(transaction.encryptedContext, this.credentialKey, {
        teamId: transaction.teamId,
        ownerId: transaction.ownerId,
        connectionId: transaction.connectionId,
        artifactType: "oauth_transaction"
      });
      const driver = this.drivers.resolve(transaction.manifest);
      const exchanged = await driver.completeAuthorization(transaction.manifest, context, transaction.redirectUri);
      const encryptedCredential = encryptValue(exchanged.credential, this.credentialKey, {
        teamId: transaction.teamId,
        ownerId: transaction.ownerId,
        connectionId: transaction.connectionId,
        artifactType: "oauth_token"
      });
      const scrubbedContext: OAuthTransactionContext = {
        state: "",
        nonce: "",
        connectorCode: context.connectorCode,
        resourceUri: context.resourceUri,
        requestedScopes: context.requestedScopes,
        authorizationHost: context.authorizationHost,
        authorizationServerUrl: context.authorizationServerUrl,
        issuer: context.issuer
      };
      await this.repository.completeAuthorization({
        transaction,
        encryptedTransactionContext: encryptValue(scrubbedContext, this.credentialKey, {
          teamId: transaction.teamId,
          ownerId: transaction.ownerId,
          connectionId: transaction.connectionId,
          artifactType: "oauth_transaction"
        }),
        encryptedCredential,
        tokenFingerprint: sha256(exchanged.credential.tokens.access_token),
        expiresAt: oauthCredentialExpiresAt(exchanged.credential.tokens),
        accountSummary: exchanged.accountSummary
      });
      await this.drivers.closeConnection(transaction.connectionId);
      return { transactionId, status: "completed" };
    } catch (error) {
      await this.repository.markAuthorizationFailed(transactionId, error);
      throw error;
    }
  }

  async refreshCredential(credentialId: string) {
    const leased = await this.repository.withCredentialRefreshLease(credentialId, async () => {
      const credential = await this.repository.loadCredentialById(credentialId);
      if (!credential) return { credentialId, status: "missing" };
      const stored = decryptValue<StoredOAuthCredential>(credential.encryptedValue, this.credentialKey, {
        teamId: credential.teamId,
        ownerId: credential.ownerId,
        connectionId: credential.connectionId,
        artifactType: "oauth_token"
      });
      try {
        const driver = this.drivers.resolve(credential.manifest);
        const refreshed = await driver.refreshCredential(credential.manifest, stored);
        await this.repository.replaceCredential({
          credential,
          encryptedValue: encryptValue(refreshed, this.credentialKey, {
            teamId: credential.teamId,
            ownerId: credential.ownerId,
            connectionId: credential.connectionId,
            artifactType: "oauth_token"
          }),
          tokenFingerprint: sha256(refreshed.tokens.access_token),
          expiresAt: oauthCredentialExpiresAt(refreshed.tokens)
        });
        await this.drivers.closeConnection(credential.connectionId);
        return { credentialId, status: "refreshed" };
      } catch (error) {
        if (isInvalidGrant(error)) {
          await this.repository.markCredentialReauthorizationRequired(credentialId, error);
          await this.drivers.closeConnection(credential.connectionId);
          return { credentialId, status: "reauthorization_required" };
        }
        throw error;
      }
    });
    return leased.acquired ? leased.value : { credentialId, status: "lease_busy" };
  }

  async revokeCredential(connectionId: string) {
    const credential = await this.repository.loadCredentialByConnection(connectionId);
    if (!credential) return { connectionId, status: "missing" };
    if (credential.credentialType === "api_token") {
      await this.repository.markCredentialRevoked(connectionId);
      await this.drivers.closeConnection(connectionId);
      return { connectionId, status: "revoked" };
    }
    const stored = decryptValue<StoredOAuthCredential>(credential.encryptedValue, this.credentialKey, {
      teamId: credential.teamId,
      ownerId: credential.ownerId,
      connectionId: credential.connectionId,
      artifactType: "oauth_token"
    });
    const driver = this.drivers.resolve(credential.manifest);
    await driver.revokeCredential(credential.manifest, stored);
    await this.repository.markCredentialRevoked(connectionId);
    await this.drivers.closeConnection(connectionId);
    return { connectionId, status: "revoked" };
  }

  async expiringCredentialIds() {
    return this.repository.listExpiringCredentialIds(24);
  }

  async healthCheckConnectionIds() {
    return this.repository.listHealthCheckConnectionIds(15);
  }

  async healthCheck(connectionId: string) {
    const startedAt = Date.now();
    const context = await this.repository.loadConnectionContext(connectionId);
    if (!new Set(["active", "degraded"]).has(context.status)) {
      throw new Error("INTEGRATION_CONNECTION_STATE_CONFLICT: 当前连接不能执行健康检查");
    }
    try {
      const runtimeContext = await this.driverContext(context);
      const driver = this.drivers.resolve(context.manifest);
      driver.validateConfiguration(context.manifest);
      const health = await driver.healthCheck(runtimeContext);
      const discovery = health.discovery || await driver.discoverTools(runtimeContext);
      await this.repository.applyDiscovery(context, discovery, "refresh");
      return await this.repository.recordHealthSuccess(connectionId, health.latencyMs || Date.now() - startedAt);
    } catch (error) {
      await this.repository.recordHealthFailure(connectionId, error, Date.now() - startedAt).catch(() => undefined);
      await this.drivers.closeConnection(connectionId);
      throw error;
    }
  }

  async processWebhookEvent(eventId: string, finalAttempt = false) {
    let claimed: Awaited<ReturnType<IntegrationWorkerRepository["claimWebhookEvent"]>> | null = null;
    try {
      claimed = await this.repository.claimWebhookEvent(eventId);
      const envelope = decryptValue<{ rawBody: string; notification: unknown }>(
        claimed.encryptedPayload,
        this.credentialKey,
        {
          teamId: claimed.teamId,
          ownerId: claimed.ownerId,
          connectionId: claimed.connectionId,
          artifactType: "webhook_raw"
        }
      );
      if (sha256(String(envelope.rawBody || "")) !== claimed.payloadHash) {
        throw new Error("INTEGRATION_WEBHOOK_PAYLOAD_TAMPERED: Webhook 原始内容完整性校验失败");
      }
      const notification = envelope.notification && typeof envelope.notification === "object"
        ? envelope.notification as Record<string, unknown> : {};
      let output: Parameters<IntegrationWorkerRepository["completeWebhookEvent"]>[3] = {
        writebackStatus: "not_applicable"
      };
      const summary: Record<string, unknown> = {
        connectorCode: claimed.connectorCode,
        eventType: claimed.eventType,
        externalEventId: claimed.externalEventId,
        normalized: true,
        notificationKeys: Object.keys(notification).slice(0, 30),
        observedAt: new Date().toISOString()
      };
      if (claimed.connectorCode === "microsoft-365" && claimed.eventType === "microsoft.message.created") {
        const resourceData = notification.resourceData && typeof notification.resourceData === "object"
          ? notification.resourceData as Record<string, unknown> : {};
        const messageId = String(resourceData.id || "").trim();
        if (!messageId || messageId.length > 512) {
          throw new Error("INTEGRATION_WEBHOOK_PAYLOAD_INVALID: Microsoft 邮件通知缺少消息编号");
        }
        const context = await this.repository.loadConnectionContext(claimed.connectionId);
        const fetched = await this.drivers.resolve(context.manifest).invokeTool(
          await this.driverContext(context),
          "mail.get_message",
          { messageId }
        );
        const structured = fetched.structuredContent && typeof fetched.structuredContent === "object"
          ? fetched.structuredContent as Record<string, unknown> : {};
        const message = structured.message && typeof structured.message === "object"
          ? structured.message as Record<string, unknown> : {};
        if (String(message.id || "") !== messageId) {
          throw new Error("INTEGRATION_WEBHOOK_MESSAGE_MISMATCH: Graph 返回邮件与通知消息编号不一致");
        }
        const artifactId = `iar_${randomUUID()}`;
        const artifactValue = {
          kind: "microsoft_inbound_message",
          message,
          source: String(structured.source || `microsoft-graph://me/messages/${messageId}`),
          observedAt: String(structured.observedAt || new Date().toISOString())
        };
        output = {
          writebackStatus: "pending",
          artifact: {
            id: artifactId,
            teamId: claimed.teamId,
            ownerId: claimed.ownerId,
            connectionId: claimed.connectionId,
            encryptedValue: encryptValue(artifactValue, this.credentialKey, {
              teamId: claimed.teamId,
              ownerId: claimed.ownerId,
              connectionId: claimed.connectionId,
              artifactType: "webhook_result"
            }),
            contentHash: sha256(canonicalJson(artifactValue)),
            expiresAt: new Date(Date.now() + this.artifactRetentionDays * 86_400_000).toISOString()
          }
        };
        summary.messageId = messageId;
        summary.businessWriteback = "pending";
      }
      await this.repository.completeWebhookEvent(eventId, claimed.leaseId, summary, output);
      return { eventId, status: "processed" };
    } catch (cause) {
      if (claimed) await this.repository.failWebhookEvent(eventId, claimed.leaseId, cause, finalAttempt);
      if (!finalAttempt) throw cause;
      return { eventId, status: "dead_letter" };
    }
  }

  async syncWebhookSubscription(connectionId: string) {
    const leased = await this.repository.withWebhookSubscriptionLease(connectionId, async () => {
      const context = await this.repository.loadConnectionContext(connectionId);
      if (context.manifest.driver !== "microsoft_graph" || !new Set(["active", "degraded"]).has(context.status)) {
        return { connectionId, status: "skipped" };
      }
      const resource = "me/mailFolders('Inbox')/messages";
      try {
        const driver = this.drivers.resolve(context.manifest);
        if (!driver.registerWebhook || !driver.renewWebhook) {
          throw new Error("INTEGRATION_WEBHOOK_UNSUPPORTED: 当前连接器不支持 Microsoft 订阅");
        }
        const clientState = this.webhookClientState(context);
        const current = await this.repository.loadWebhookSubscription(connectionId, resource);
        const runtimeContext = await this.driverContext(context);
        const refreshed = current && current.status === "active" && current.remoteSubscriptionId
          && current.expiresAt && new Date(current.expiresAt).getTime() > Date.now() + 24 * 60 * 60 * 1_000
          ? current
          : current?.remoteSubscriptionId
            ? await driver.renewWebhook(runtimeContext, current.remoteSubscriptionId)
            : await driver.registerWebhook(runtimeContext, {
              notificationUrl: this.webhookNotificationUrl(context),
              clientState,
              resource,
              changeTypes: "created"
            });
        const saved = await this.repository.upsertWebhookSubscription({
          connectionId,
          teamId: context.teamId,
          provider: "microsoft_graph",
          remoteSubscriptionId: refreshed.id,
          resource,
          changeTypes: refreshed.changeTypes,
          clientStateHash: sha256(clientState),
          expiresAt: refreshed.expiresAt
        });
        return { connectionId, status: current?.remoteSubscriptionId === refreshed.id ? "renewed" : "active", expiresAt: saved?.expiresAt || refreshed.expiresAt };
      } catch (error) {
        await this.repository.recordWebhookSubscriptionFailure({
          connectionId,
          teamId: context.teamId,
          provider: "microsoft_graph",
          resource,
          cause: error
        });
        throw error;
      }
    });
    return leased.acquired ? leased.value : { connectionId, status: "lease_busy" };
  }

  async subscriptionSyncConnectionIds() {
    return this.repository.listWebhookSubscriptionSyncConnectionIds(24);
  }

  async unregisterWebhookSubscription(connectionId: string) {
    const leased = await this.repository.withWebhookSubscriptionLease(connectionId, async () => {
      const context = await this.repository.loadConnectionContext(connectionId);
      const resource = "me/mailFolders('Inbox')/messages";
      const current = await this.repository.loadWebhookSubscription(connectionId, resource);
      if (!current || current.status === "deleted" || !current.remoteSubscriptionId) {
        return { connectionId, status: "missing" };
      }
      const driver = this.drivers.resolve(context.manifest);
      if (!driver.unregisterWebhook) throw new Error("INTEGRATION_WEBHOOK_UNSUPPORTED: 当前连接器不支持注销订阅");
      try {
        await driver.unregisterWebhook(await this.driverContext(context), current.remoteSubscriptionId);
        await this.repository.markWebhookSubscriptionDeleted(connectionId, resource);
        return { connectionId, status: "deleted" };
      } catch (error) {
        await this.repository.markWebhookSubscriptionFailed(connectionId, resource, error);
        throw error;
      } finally {
        await this.drivers.closeConnection(connectionId);
      }
    });
    return leased.acquired ? leased.value : { connectionId, status: "lease_busy" };
  }

  async discover(connectionId: string, mode: "initial" | "refresh") {
    const context = await this.repository.loadConnectionContext(connectionId);
    if (mode === "initial" && context.status !== "discovering") {
      throw new Error("INTEGRATION_CONNECTION_STATE_CONFLICT: 连接未进入工具发现状态");
    }
    if (mode === "refresh" && !new Set(["active", "degraded", "pending_review"]).has(context.status)) {
      throw new Error("INTEGRATION_CONNECTION_STATE_CONFLICT: 当前连接不能刷新工具");
    }
    try {
      const driver = this.drivers.resolve(context.manifest);
      const discovery = await driver.discoverTools(await this.driverContext(context));
      return await this.repository.applyDiscovery(context, discovery, mode);
    } catch (error) {
      await this.drivers.closeConnection(connectionId);
      await this.repository.markDiscoveryFailed(connectionId, mode, error);
      throw error;
    }
  }

  async executeReadCall(callId: string) {
    let claimed: Awaited<ReturnType<IntegrationWorkerRepository["claimCall"]>> | null = null;
    let remoteInvocationStarted = false;
    let remoteResponseReceived = false;
    try {
      claimed = await this.repository.claimCall(callId);
      const input = decryptValue<Record<string, unknown>>(
        claimed.encryptedInput,
        this.credentialKey,
        {
          teamId: claimed.teamId,
          ownerId: claimed.ownerId,
          connectionId: claimed.connectionId,
          artifactType: "tool_input"
        }
      );
      if (sha256(canonicalJson(input)) !== await this.repository.getCallInputHash(callId)) {
        throw new Error("INTEGRATION_INPUT_INVALID: 调用参数 hash 校验失败");
      }
      const driver = this.drivers.resolve(claimed.manifest);
      const runtimeContext = { ...(await this.driverContext(claimed)), requestId: claimed.requestId };
      const discovery = await driver.discoverTools(runtimeContext);
      const currentTool = discovery.tools.find((tool) => tool.remoteName === claimed!.remoteName);
      if (!currentTool || currentTool.schemaHash !== claimed.schemaHash) {
        await this.repository.applyDiscovery(claimed, discovery, "refresh");
        throw new Error("INTEGRATION_TOOL_SCHEMA_CHANGED: 远程工具 Schema 已变化，已自动隔离");
      }
      remoteInvocationStarted = true;
      const raw = await driver.invokeTool(runtimeContext, claimed.remoteName, input);
      remoteResponseReceived = true;
      let review: Record<string, unknown> = {};
      try { review = JSON.parse(claimed.reviewJson || "{}") as Record<string, unknown>; } catch { review = {}; }
      const sanitized = sanitizeToolResult(raw, {
        riskLevel: claimed.riskLevel,
        completionEvidence: Array.isArray(review.completionEvidence) ? review.completionEvidence.map(String) : []
      });
      const outputHash = sha256(canonicalJson(sanitized.value));
      const outputBytes = Buffer.byteLength(canonicalJson(sanitized.value), "utf8");
      const artifactId = `iar_${randomUUID()}`;
      const expiresAt = new Date(Date.now() + this.artifactRetentionDays * 86_400_000).toISOString();
      await this.repository.completeCallSuccess({
        call: claimed,
        outputHash,
        outputSummary: sanitized.summary,
        externalReceipt: sanitized.externalReceipt,
        evidence: sanitized.evidence,
        outputBytes,
        artifact: {
          id: artifactId,
          encryptedValue: encryptValue(sanitized.value, this.credentialKey, {
            teamId: claimed.teamId,
            ownerId: claimed.ownerId,
            connectionId: claimed.connectionId,
            artifactType: "tool_result"
          }),
          contentHash: outputHash,
          keyVersion: "v1",
          expiresAt
        }
      });
      return { callId, status: "succeeded", evidence: sanitized.evidence };
    } catch (error) {
      if (claimed && claimed.riskLevel >= 3 && remoteInvocationStarted && !remoteResponseReceived) {
        await this.repository.completeCallUnknownOutcome(claimed, error);
        return { callId, status: "unknown_outcome", evidence: {} };
      }
      if (claimed) await this.repository.completeCallFailure(claimed, error);
      throw error;
    }
  }

  async terminateConnection(connectionId: string) {
    await this.unregisterWebhookSubscription(connectionId);
    await this.drivers.closeConnection(connectionId);
  }

  async disconnectConnection(connectionId: string) {
    await this.unregisterWebhookSubscription(connectionId);
    return this.revokeCredential(connectionId);
  }
}
