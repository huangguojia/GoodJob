import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  canonicalManifestJson,
  connectorManifestHash,
  validateConnectorManifest
} from "@goodjob/integration-connector-sdk";
import { createRequire } from "node:module";
import { assertObjectScope, authorize, resolveDataScope, type DataScope } from "../authorization.js";
import { canSeeOwner, hasIamPermission, hasIamScope, isPlatformIdentity, publicUser } from "../auth.js";
import { getStore } from "../store.js";
import type { SessionUser } from "../types.js";
import { decryptIntegrationValue, encryptIntegrationValue } from "./integration-credential-vault.js";
import type {
  GrantInput,
  MysqlIntegrationControlRepository,
  ToolReviewInput
} from "./integration-control-repository.js";
import type { IntegrationQueueDispatcher } from "./integration-queue.js";
import type { ConnectionScope, ConnectorDefinition, IntegrationConnectorReview, ToolSnapshot } from "./integration-types.js";
import { deriveWebhookSecret, normalizeVerifiedWebhook } from "./integration-webhook.js";

const Ajv = createRequire(import.meta.url)("ajv") as new (options: Record<string, unknown>) => {
  compile(schema: unknown): ((value: unknown) => boolean) & { errors?: unknown };
  errorsText(errors: unknown, options?: { separator?: string }): string;
};
const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: false });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface OAuthTransactionContext {
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function error(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, status });
}

function scopeRequest(scope: ConnectionScope, teamId = "") {
  if (scope === "platform") return { type: "platform" as const };
  if (scope === "team") return { type: "team" as const, teamId };
  return { type: "personal" as const };
}

function publicManifest(raw: string) {
  try {
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    return {
      stage: String(manifest.stage || (manifest.endpoint ? "available" : "planned")),
      authentication: String(manifest.authentication || "future"),
      approvedHosts: Array.isArray(manifest.approvedHosts) ? manifest.approvedHosts : [],
      credentialFields: Array.isArray(manifest.credentialFields)
        ? manifest.credentialFields.map((field) => {
          const item = field && typeof field === "object" ? field as Record<string, unknown> : {};
          return {
            key: String(item.key || ""), label: String(item.label || ""),
            minLength: Number(item.minLength || 1), maxLength: Number(item.maxLength || 500),
            help: String(item.help || "")
          };
        }).filter((field) => field.key && field.label)
        : []
    };
  } catch {
    return { stage: "invalid", authentication: "unknown", approvedHosts: [] };
  }
}

function parsedManifest(raw: string) {
  try {
    return validateConnectorManifest(JSON.parse(raw), {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"
    });
  } catch {
    error("INTEGRATION_CONNECTOR_INVALID", "连接器配置无效或未通过安全校验", 503);
  }
}

function apiCredentialInput(manifest: ReturnType<typeof validateConnectorManifest>, raw: unknown) {
  if (manifest.authentication !== "api_token") return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error("INTEGRATION_CREDENTIAL_INVALID", "请填写连接器所需的 API 凭据", 400);
  }
  const input = raw as Record<string, unknown>;
  const fields = manifest.credentialFields || [];
  const expected = new Set(fields.map((field) => field.key));
  const unexpected = Object.keys(input).filter((key) => !expected.has(key));
  if (unexpected.length) error("INTEGRATION_CREDENTIAL_INVALID", "凭据包含未支持字段", 400);
  return Object.fromEntries(fields.map((field) => {
    const value = typeof input[field.key] === "string" ? String(input[field.key]).trim() : "";
    if (value.length < field.minLength || value.length > field.maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
      error("INTEGRATION_CREDENTIAL_INVALID", `${field.label} 格式或长度无效`, 400);
    }
    return [field.key, value];
  }));
}

function fieldFilteredInput(tool: ToolSnapshot, input: Record<string, unknown>) {
  const review = parsedReview(tool);
  const allowlist = Array.isArray(review.fieldAllowlist) ? review.fieldAllowlist.map(String) : [];
  if (!allowlist.length) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowlist.includes(key)));
}

function parsedReview(tool: ToolSnapshot) {
  try { return JSON.parse(tool.reviewJson || "{}") as Record<string, unknown>; } catch { return {} as Record<string, unknown>; }
}

type DataClassification = "public" | "business" | "personal" | "sensitive" | "secret";

function classifyField(field: string): DataClassification {
  const normalized = field.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (/(password|passwd|secret|token|apikey|privatekey|credential|sessioncookie)/u.test(normalized)) return "secret";
  if (/(attachment|bank|accountnumber|passport|identity|idcard|contract|price|amount|body|content)/u.test(normalized)) return "sensitive";
  if (/(email|phone|mobile|address|recipient|contact|name)/u.test(normalized)) return "personal";
  if (/(company|product|subject|country|quantity|currency|date|status|reference)/u.test(normalized)) return "business";
  return "public";
}

function nestedSecretPaths(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 8 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((item, index) => nestedSecretPaths(item, `${prefix}[${index}]`, depth + 1));
  return Object.entries(value as Record<string, unknown>).slice(0, 200).flatMap(([field, item]) => {
    const path = prefix ? `${prefix}.${field}` : field;
    return classifyField(field) === "secret" ? [path] : nestedSecretPaths(item, path, depth + 1);
  });
}

function egressDecision(tool: ToolSnapshot, input: Record<string, unknown>) {
  const review = parsedReview(tool);
  const policy = (review.dataEgressPolicy || {}) as Record<string, unknown>;
  const allowed = new Set((Array.isArray(policy.allowedClassifications)
    ? policy.allowedClassifications.map(String)
    : ["public", "business", "personal"]) as string[]);
  const configured = (policy.fieldClassifications || {}) as Record<string, unknown>;
  const fields = Object.keys(input).sort().map((field) => ({
    field,
    classification: (String(configured[field] || classifyField(field)) as DataClassification)
  }));
  const denied = fields.filter((item) => item.classification === "secret" || !allowed.has(item.classification));
  for (const path of nestedSecretPaths(input)) {
    if (!denied.some((item) => item.field === path)) denied.push({ field: path, classification: "secret" });
  }
  return { fields, denied, allowedClassifications: [...allowed] };
}

function safeApprovalPreview(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).slice(0, 100).map(([field, value]) => {
    if (typeof value === "string") return [field, value.slice(0, 2_000)];
    if (typeof value === "number" || typeof value === "boolean" || value === null) return [field, value];
    if (Array.isArray(value)) return [field, value.slice(0, 50)];
    return [field, "[结构化数据]"];
  }));
}

function inputSummary(input: Record<string, unknown>) {
  return {
    fields: Object.keys(input).sort(),
    valueTypes: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? "array" : value === null ? "null" : typeof value]))
  };
}

export class IntegrationControlPlaneService {
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly repository: MysqlIntegrationControlRepository,
    private readonly queue: IntegrationQueueDispatcher,
    private readonly credentialKey: string,
    private readonly oauthCallbackBaseUrl = "",
    readonly oauthSuccessRedirectUrl = ""
  ) {}

  private async permissionHolders(permissionCode: string, teamId = "") {
    const store = getStore();
    const candidates = store.users.filter((user) => user.status === "active" && (!teamId || user.teamId === teamId));
    const rows = await Promise.all(candidates.map(async (user) => ({
      user,
      snapshot: await store.getIamCapabilitySnapshot?.(publicUser(user))
    })));
    return rows.filter(({ user, snapshot }) => Boolean(
      snapshot?.permissions[permissionCode]?.length
      && (teamId ? snapshot.source !== "platform" && snapshot.tenantId === teamId : snapshot.source === "platform")
    )).map(({ user }) => user);
  }

  private async createNotification(input: {
    recipientId: string;
    teamId: string;
    subject: string;
    content: string;
    relatedType: "integration_approval" | "integration_call" | "integration_connection" | "integration_event" | "integration_connector";
    relatedId: string;
  }) {
    const store = getStore();
    if (!store.users.some((user) => user.id === input.recipientId && user.status === "active")) return;
    if (store.internalMessages.some((message) => message.relatedType === input.relatedType
      && message.relatedId === input.relatedId && message.recipientId === input.recipientId
      && message.subject === input.subject)) return;
    const now = new Date().toISOString();
    store.internalMessages.unshift({
      id: `msg_${randomUUID()}`,
      threadId: `integration_${input.relatedId}`.slice(0, 64),
      senderId: "system",
      recipientId: input.recipientId,
      teamId: input.teamId,
      type: "system",
      subject: input.subject,
      content: input.content.slice(0, 5_000),
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      readAt: "",
      createdAt: now,
      updatedAt: now
    });
    await store.persist();
  }

  private async notifyApprovers(actor: SessionUser, approvalId: string, toolName: string, riskLevel: number) {
    let recipients = await this.permissionHolders("integration.approval.act", actor.teamId);
    const others = recipients.filter((user) => user.id !== actor.id);
    if (others.length) recipients = others;
    await Promise.all(recipients.map((recipient) => this.createNotification({
      recipientId: recipient.id,
      teamId: actor.teamId,
      subject: `外部操作待审批：${toolName}`,
      content: `${actor.name} 发起了 R${riskLevel} 外部操作，请核对目标、发送字段和最终参数。`,
      relatedType: "integration_approval",
      relatedId: approvalId
    })));
  }

  private async notifyQuotaExceeded(actor: SessionUser, tool: ToolSnapshot, dailyCallLimit: number) {
    const managers = await this.permissionHolders("integration.manage", actor.teamId);
    const recipients = managers.length ? managers : [actor];
    const date = new Date().toISOString().slice(0, 10);
    await Promise.all(recipients.map((recipient) => this.createNotification({
      recipientId: recipient.id,
      teamId: actor.teamId,
      subject: `集成工具今日配额已用尽：${tool.displayName || tool.remoteName}（${date}）`,
      content: `每日调用上限为 ${dailyCallLimit} 次。系统已阻止新的外部调用，已运行任务不受影响；调整预算需要管理员重新审核工具。`,
      relatedType: "integration_connection",
      relatedId: tool.connectionId
    })));
  }

  startMaintenance() {
    if (this.maintenanceTimer) return;
    const sweep = async () => {
      await this.repository.recoverStaleRunningCalls(5);
      const expired = await this.repository.expireApprovals();
      await this.processBusinessWritebacks();
      await this.processInboundWebhookWritebacks();
      await Promise.all(expired.map((item) => this.createNotification({
        recipientId: item.ownerId,
        teamId: item.teamId,
        subject: "外部操作审批已过期",
        content: "冻结参数审批在有效期内未处理，本次操作已取消；需要执行时请重新发起。",
        relatedType: "integration_approval",
        relatedId: item.approvalId
      })));
      const usageDate = new Date().toISOString().slice(0, 10);
      const [unknownCalls, connections, usage, tools] = await Promise.all([
        this.repository.listCalls({ type: "platform" }, 200),
        this.repository.listConnections({ type: "platform" }, { limit: 100, offset: 0 }),
        this.repository.listDailyUsage({ type: "platform" }, usageDate),
        this.repository.listTools({ type: "platform" })
      ]);
      const holderCache = new Map<string, ReturnType<IntegrationControlPlaneService["permissionHolders"]>>();
      const holders = (permissionCode: string, teamId: string) => {
        const key = `${permissionCode}:${teamId}`;
        const existing = holderCache.get(key);
        if (existing) return existing;
        const pending = this.permissionHolders(permissionCode, teamId);
        holderCache.set(key, pending);
        return pending;
      };
      await Promise.all(unknownCalls.filter((call) => ["unknown_outcome", "reconciliation_required"].includes(call.status)).map(async (call) => {
        const managers = await holders("integration.manage", call.teamId);
        const recipients = new Set([call.ownerId, ...managers.map((user) => user.id)]);
        await Promise.all([...recipients].map((recipientId) => this.createNotification({
          recipientId,
          teamId: call.teamId,
          subject: "外部操作结果待人工对账",
          content: "请求已经发送，但远端结果无法确认。请勿重复执行，先在集成中心回查外部回执。",
          relatedType: "integration_call",
          relatedId: call.id
        })));
      }));
      await Promise.all(connections.filter((connection) => connection.status === "reauthorization_required").map((connection) =>
        this.createNotification({
          recipientId: connection.ownerId,
          teamId: connection.teamId,
          subject: `外部连接需要重新授权：${connection.displayName}`,
          content: "OAuth 凭据已失效，连接已停止新调用。请进入集成中心重新授权。",
          relatedType: "integration_connection",
          relatedId: connection.id
        })
      ));
      const alertDate = new Date().toISOString().slice(0, 10);
      await Promise.all(connections.filter((connection) => connection.status === "degraded").map(async (connection) => {
        const managers = await holders("integration.manage", connection.teamId);
        const recipients = new Set([connection.ownerId, ...managers.map((user) => user.id)]);
        await Promise.all([...recipients].map((recipientId) => this.createNotification({
          recipientId,
          teamId: connection.teamId,
          subject: `外部连接健康异常：${connection.displayName}（${alertDate}）`,
          content: `${connection.lastErrorMessage || "连续健康检查未通过"}。系统已暂时阻止新调用，并会自动进行恢复检查。`,
          relatedType: "integration_connection",
          relatedId: connection.id
        })));
      }));
      const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
      const toolById = new Map(tools.map((tool) => [tool.id, tool]));
      await Promise.all(usage.map(async (item) => {
        const tool = toolById.get(item.toolSnapshotId);
        const connection = connectionById.get(item.connectionId);
        if (!tool || !connection) return;
        const limit = Math.max(1, Math.min(10_000, Number(parsedReview(tool).dailyCallLimit || 100)));
        if (item.callCount < Math.ceil(limit * 0.8) || item.callCount >= limit) return;
        const managers = await holders("integration.manage", item.teamId);
        const recipients = managers.length ? managers.map((user) => user.id) : [connection.ownerId];
        await Promise.all(recipients.map((recipientId) => this.createNotification({
          recipientId,
          teamId: item.teamId,
          subject: `集成工具调用量接近上限：${tool.displayName || tool.remoteName}（${usageDate}）`,
          content: `今日已调用 ${item.callCount}/${limit} 次。达到上限后系统会阻止新调用，已运行任务不会中断。`,
          relatedType: "integration_connection",
          relatedId: connection.id
        })));
      }));
    };
    this.maintenanceTimer = setInterval(() => void sweep().catch(() => undefined), 60_000);
    this.maintenanceTimer.unref();
    void sweep().catch(() => undefined);
  }

  resolveScope(actor: SessionUser, requestedTeamId = "", permissionCode = "integration.read"): DataScope {
    return requestedTeamId
      ? resolveDataScope(actor, { type: "team", teamId: requestedTeamId }, permissionCode)
      : resolveDataScope(actor, {}, permissionCode);
  }

  async catalog(actor: SessionUser) {
    authorize({ actor, resource: "integration.connector", action: "read" });
    const connectors = await this.repository.listCatalog(actor.teamId, {
      includeReview: hasIamPermission(actor, "integration.manage"),
      platform: false
    });
    return connectors.map((connector) => ({
      id: connector.id,
      code: connector.code,
      name: connector.name,
      version: connector.version,
      type: connector.type,
      trust: connector.trust,
      status: connector.status,
      teamId: connector.teamId,
      description: connector.description,
      createdBy: connector.createdBy,
      manifestHash: connector.manifestHash,
      manifest: publicManifest(connector.manifestJson)
    }));
  }

  async registerPrivateConnector(actor: SessionUser, input: {
    name: string;
    code: string;
    version: string;
    description: string;
    teamId?: string;
    manifest: Record<string, unknown>;
  }) {
    authorize({ actor, resource: "integration.connector", action: "create" });
    if (isPlatformIdentity(actor) || !hasIamPermission(actor, "integration.manage")) error("INTEGRATION_PERMISSION_DENIED", "当前账号不能提交私有连接器", 403);
    const requestedTeamId = String(input.teamId || "").trim();
    if (requestedTeamId && requestedTeamId !== actor.teamId) {
      error("INTEGRATION_PERMISSION_DENIED", "不能为其他团队提交连接器", 403);
    }
    const teamId = actor.teamId;
    if (!teamId || !getStore().users.some((user) => user.status === "active" && user.teamId === teamId)) {
      error("INTEGRATION_INPUT_INVALID", "目标团队不存在或没有可用成员");
    }
    const code = input.code.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,99}$/u.test(code)) error("INTEGRATION_INPUT_INVALID", "连接器代码格式无效");
    if (await this.repository.findTeamConnectorByCode(teamId, code)) {
      error("INTEGRATION_CONNECTOR_CONFLICT", "当前团队已经存在同代码连接器", 409);
    }
    const environment = process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development";
    let manifest;
    try {
      manifest = validateConnectorManifest(input.manifest, {
        environment,
        requireSchemaVersion: true,
        allowedDrivers: ["native_mcp"]
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Connector Manifest 无效";
      error("INTEGRATION_CONNECTOR_MANIFEST_INVALID", message, 400);
    }
    if (manifest.stage !== "available" || manifest.driver !== "native_mcp") {
      error("INTEGRATION_CONNECTOR_MANIFEST_INVALID", "私有连接器必须提供可用的 Native MCP 配置");
    }
    const manifestJson = canonicalManifestJson(manifest, {
      environment,
      requireSchemaVersion: true,
      allowedDrivers: ["native_mcp"]
    });
    const manifestHash = connectorManifestHash(manifest, {
      environment,
      requireSchemaVersion: true,
      allowedDrivers: ["native_mcp"]
    });
    const now = new Date().toISOString();
    const connector: ConnectorDefinition = {
      id: `icn_private_${randomUUID()}`,
      code,
      version: input.version.trim() || "1.0.0",
      type: "native_mcp",
      trust: "private",
      status: "review",
      teamId,
      name: input.name.trim(),
      description: input.description.trim(),
      manifestJson,
      manifestHash,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now
    };
    if (!connector.name || connector.name.length > 160 || connector.version.length > 40 || connector.description.length > 1000) {
      error("INTEGRATION_INPUT_INVALID", "连接器名称、版本或说明超出限制");
    }
    const review: IntegrationConnectorReview = {
      id: `icr_${randomUUID()}`,
      connectorId: connector.id,
      teamId,
      status: "pending",
      manifestHash,
      submittedBy: actor.id,
      reviewedBy: "",
      reviewNote: "",
      createdAt: now,
      updatedAt: now
    };
    try {
      await this.repository.createPrivateConnectorReview(connector, review);
    } catch (cause) {
      if ((cause as { code?: string }).code === "ER_DUP_ENTRY") {
        error("INTEGRATION_CONNECTOR_CONFLICT", "当前团队已经存在同代码连接器", 409);
      }
      throw cause;
    }
    const reviewers = await this.permissionHolders("platform.integration.connector.review");
    await Promise.all(reviewers.map((reviewer) => this.createNotification({
      recipientId: reviewer.id,
      teamId: reviewer.teamId,
      subject: `私有连接器待审核：${connector.name}`,
      content: `团队 ${teamId} 提交了 ${connector.name}。系统仅保存 Manifest 与端点配置，不下载或运行第三方连接器代码。`,
      relatedType: "integration_connector",
      relatedId: connector.id
    })));
    return { connector: { ...connector, manifestJson: undefined }, review };
  }

  async connectorReviews(actor: SessionUser, status = "") {
    const platformReview = isPlatformIdentity(actor) && hasIamPermission(actor, "platform.integration.connector.review");
    if (!platformReview && !hasIamPermission(actor, "integration.manage")) error("INTEGRATION_PERMISSION_DENIED", "当前账号不能查看连接器审核", 403);
    if (status && !new Set(["pending", "approved", "rejected"]).has(status)) {
      error("INTEGRATION_INPUT_INVALID", "连接器审核状态无效");
    }
    const reviews = await this.repository.listConnectorReviews(status, platformReview ? "" : actor.teamId);
    const items = await Promise.all(reviews.map(async (review) => {
      const connector = await this.repository.getConnector(review.connectorId, review.teamId, platformReview);
      return connector ? {
        ...review,
        connector: {
          id: connector.id,
          code: connector.code,
          version: connector.version,
          name: connector.name,
          description: connector.description,
          type: connector.type,
          trust: connector.trust,
          status: connector.status,
          teamId: connector.teamId,
          createdBy: connector.createdBy,
          manifestHash: connector.manifestHash,
          manifest: JSON.parse(connector.manifestJson)
        }
      } : null;
    }));
    return items.filter(Boolean);
  }

  async reviewPrivateConnector(actor: SessionUser, connectorId: string, input: {
    decision: "approved" | "rejected";
    note: string;
  }) {
    if (!isPlatformIdentity(actor) || !hasIamPermission(actor, "platform.integration.connector.review")) {
      error("INTEGRATION_PERMISSION_DENIED", "当前平台账号没有连接器审核权限", 403);
    }
    authorize({ actor, resource: "integration.connector", action: "review", requestedScope: { type: "platform" } });
    const result = await this.repository.decideConnectorReview(connectorId, actor.id, input.decision, input.note.trim());
    await this.createNotification({
      recipientId: result.review.submittedBy,
      teamId: result.review.teamId,
      subject: input.decision === "approved" ? `私有连接器已通过：${result.connector.name}` : `私有连接器未通过：${result.connector.name}`,
      content: input.decision === "approved"
        ? "连接器已进入可连接状态。创建连接后仍需完成工具发现、逐项审核和权限授权。"
        : `连接器已隔离且不可创建连接。${input.note.trim() ? `审核意见：${input.note.trim()}` : "请核对端点安全、认证配置与用途说明后重新提交新版本。"}`,
      relatedType: "integration_connector",
      relatedId: result.connector.id
    });
    return result;
  }

  async connections(actor: SessionUser, requestedTeamId = "") {
    const scope = this.resolveScope(actor, requestedTeamId);
    authorize({ actor, resource: "integration.connection", action: "read", requestedScope: scope });
    return this.repository.listConnections(scope);
  }

  async connection(actor: SessionUser, id: string, requestedTeamId = "") {
    const scope = this.resolveScope(actor, requestedTeamId);
    authorize({ actor, resource: "integration.connection", action: "read", requestedScope: scope });
    const connection = await this.repository.getConnection(id, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    return connection;
  }

  async validateWebhookEndpoint(connectorCode: string, webhookPublicId: string) {
    const endpoint = await this.repository.getWebhookEndpoint(connectorCode, webhookPublicId);
    if (!endpoint) error("INTEGRATION_WEBHOOK_NOT_FOUND", "Webhook 入口不存在或连接不可用", 404);
    return endpoint;
  }

  async receiveWebhook(input: {
    connectorCode: string;
    webhookPublicId: string;
    body: unknown;
    rawBody: Buffer;
    signatureHeader?: string;
    nonce?: string;
    eventId?: string;
    eventType?: string;
  }) {
    if (!input.rawBody.length || input.rawBody.length > 1_048_576) {
      error("INTEGRATION_WEBHOOK_PAYLOAD_INVALID", "Webhook 内容为空或超过 1 MB", 413);
    }
    const endpoint = await this.validateWebhookEndpoint(input.connectorCode, input.webhookPublicId);
    const secret = deriveWebhookSecret(this.credentialKey, endpoint);
    const normalized = normalizeVerifiedWebhook({ ...input, secret });
    const receivedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const accepted: Array<{ eventId: string; duplicate: boolean }> = [];
    for (const notification of normalized.notifications) {
      const id = `iev_${randomUUID()}`;
      const artifactId = `iar_${randomUUID()}`;
      const encryptedValue = encryptIntegrationValue({
        rawBody: input.rawBody.toString("utf8"),
        notification: notification.payload
      }, this.credentialKey, {
        teamId: endpoint.teamId,
        ownerId: endpoint.ownerId,
        connectionId: endpoint.connectionId,
        artifactType: "webhook_raw"
      });
      const created = await this.repository.createWebhookEvent({
        id,
        connectionId: endpoint.connectionId,
        teamId: endpoint.teamId,
        ownerId: endpoint.ownerId,
        externalEventId: notification.externalEventId,
        eventType: notification.eventType,
        payloadHash: normalized.payloadHash,
        artifact: { id: artifactId, encryptedValue, contentHash: normalized.payloadHash, expiresAt },
        receivedAt
      });
      if (new Set(["queued", "replayed"]).has(created.event.status)) {
        await this.queue.enqueueWebhookEvent(created.event.id);
      }
      accepted.push({ eventId: created.event.id, duplicate: created.duplicate });
    }
    return { accepted: accepted.length, duplicateCount: accepted.filter((item) => item.duplicate).length, events: accepted };
  }

  async webhookEvents(actor: SessionUser, status = "") {
    const scope = this.resolveScope(actor);
    authorize({ actor, resource: "integration.event", action: "read", requestedScope: scope });
    if (status && !new Set(["received", "verified", "queued", "processing", "processed", "ignored", "dead_letter", "replayed"]).has(status)) {
      error("INTEGRATION_INPUT_INVALID", "Webhook 事件状态无效");
    }
    return this.repository.listWebhookEvents(scope, status);
  }

  async replayWebhookEvent(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor, "", "integration.execute");
    authorize({ actor, resource: "integration.event", action: "execute", requestedScope: scope });
    const event = await this.repository.replayWebhookEvent(id, scope);
    await this.queue.enqueueWebhookEvent(event.id);
    return event;
  }

  async linkWebhookEventCustomer(actor: SessionUser, id: string, customerId: string) {
    const scope = this.resolveScope(actor, "", "integration.execute");
    authorize({ actor, resource: "integration.event", action: "update", requestedScope: scope });
    const customer = this.businessCustomer(actor, customerId);
    const event = await this.repository.linkWebhookEventCustomer(id, scope, customer.id);
    await this.processInboundWebhookWritebacks();
    return (await this.repository.getWebhookEvent(event.id)) || event;
  }

  async createConnection(actor: SessionUser, input: {
    connectorId: string;
    scope: ConnectionScope;
    teamId?: string;
    displayName: string;
    credentials?: Record<string, unknown>;
  }) {
    const requested = scopeRequest(input.scope, input.teamId || "");
    const decision = authorize({ actor, resource: "integration.connection", action: "create", requestedScope: requested });
    if (input.scope === "team" && !hasIamScope(actor, "integration.connect", ["tenant"])) error("INTEGRATION_PERMISSION_DENIED", "当前权限范围不能创建团队连接", 403);
    if (input.scope === "platform") error("INTEGRATION_PERMISSION_DENIED", "平台连接只能通过平台配置流程创建", 403);
    const connector = await this.repository.getConnector(input.connectorId, decision.scope.teamId || actor.teamId, false);
    if (!connector || connector.status !== "active") error("INTEGRATION_CONNECTION_NOT_FOUND", "连接器尚未开放连接", 404);
    const manifest = parsedManifest(connector.manifestJson);
    const credentials = apiCredentialInput(manifest, input.credentials);
    const id = `icx_${randomUUID()}`;
    const connection = await this.repository.createConnection({
      id,
      connectorId: connector.id,
      teamId: decision.scope.teamId || actor.teamId,
      ownerId: actor.id,
      scope: input.scope,
      scopeId: input.scope === "team" ? decision.scope.teamId! : actor.id,
      status: "draft",
      displayName: input.displayName.trim() || connector.name
    });
    const scope: DataScope = input.scope === "team"
      ? { type: "team", teamId: connection.teamId }
      : { type: "personal", teamId: connection.teamId, ownerId: actor.id };
    const authorizing = await this.repository.transitionConnection(id, scope, "draft", "authorizing");
    if (String(manifest.authentication || "none") === "oauth2") return authorizing;
    if (manifest.authentication === "api_token") {
      await this.repository.saveApiCredential({
        connectionId: id,
        teamId: connection.teamId,
        encryptedValue: encryptIntegrationValue(credentials, this.credentialKey, {
          teamId: connection.teamId,
          ownerId: connection.ownerId,
          connectionId: id,
          artifactType: "api_token"
        }),
        fingerprint: sha256(canonicalJson(credentials))
      });
    }
    await this.repository.transitionConnection(id, scope, "authorizing", "pending_confirmation");
    const discovering = await this.repository.transitionConnection(id, scope, "pending_confirmation", "discovering");
    try {
      await this.queue.enqueueDiscovery(id, "initial");
    } catch (queueError) {
      await this.repository.transitionConnection(id, scope, "discovering", "failed");
      throw queueError;
    }
    return discovering;
  }

  private transactionContext(transaction: { encryptedContext: string; teamId: string; ownerId: string; connectionId: string }) {
    return decryptIntegrationValue<OAuthTransactionContext>(transaction.encryptedContext, this.credentialKey, {
      teamId: transaction.teamId,
      ownerId: transaction.ownerId,
      connectionId: transaction.connectionId,
      artifactType: "oauth_transaction"
    });
  }

  private publicAuthTransaction(transaction: Awaited<ReturnType<MysqlIntegrationControlRepository["getAuthTransaction"]>>) {
    if (!transaction) error("INTEGRATION_AUTH_TRANSACTION_NOT_FOUND", "授权事务不存在或无权访问", 404);
    const context = this.transactionContext(transaction);
    return {
      id: transaction.id,
      connectionId: transaction.connectionId,
      status: transaction.status,
      authorizationUrl: transaction.status === "authorize_url_ready" ? context.authorizationUrl || "" : "",
      authorizationHost: context.authorizationHost || "",
      requestedScopes: context.requestedScopes,
      issuer: transaction.issuer || context.issuer || "",
      resourceUri: transaction.resourceUri,
      expiresAt: transaction.expiresAt,
      account: undefined
    };
  }

  async startAuthorization(actor: SessionUser, connectionId: string) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(connectionId, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "update", requestedScope: scope, object: connection });
    if (connection.status !== "authorizing") error("INTEGRATION_CONNECTION_STATE_CONFLICT", "连接未处于授权状态", 409);
    const existing = await this.repository.latestAuthTransaction(connectionId, scope);
    if (existing && !["failed", "expired", "consumed"].includes(existing.status) && new Date(existing.expiresAt).getTime() > Date.now()) {
      return this.publicAuthTransaction(existing);
    }
    if (!this.oauthCallbackBaseUrl) error("INTEGRATION_OAUTH_NOT_CONFIGURED", "服务器尚未配置 OAuth 回调地址", 503);
    const connector = await this.repository.getConnector(connection.connectorId, connection.teamId, connection.scope === "platform");
    if (!connector) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接器不存在", 404);
    const manifest = parsedManifest(connector.manifestJson);
    if (String(manifest.authentication || "none") !== "oauth2") {
      error("INTEGRATION_OAUTH_NOT_SUPPORTED", "该连接器不使用 OAuth 授权", 409);
    }
    const oauth = (manifest.oauth || {}) as Record<string, unknown>;
    const resourceUri = String(manifest.endpoint || "");
    if (!resourceUri || !String(oauth.clientId || "")) error("INTEGRATION_CONNECTOR_INVALID", "OAuth 连接器缺少资源地址或客户端标识", 503);
    const callbackBase = new URL(this.oauthCallbackBaseUrl);
    const redirectUri = new URL(`/api/integrations/oauth/callback/${encodeURIComponent(connector.code)}`, callbackBase).toString();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const transaction = {
      id: `iat_${randomUUID()}`,
      connectionId,
      teamId: connection.teamId,
      ownerId: connection.ownerId,
      status: "created" as const,
      stateHash: sha256(state),
      nonceHash: sha256(nonce),
      encryptedContext: encryptIntegrationValue({
        state,
        nonce,
        connectorCode: connector.code,
        resourceUri,
        requestedScopes: Array.isArray(oauth.scopes) ? oauth.scopes.map(String) : []
      }, this.credentialKey, {
        teamId: connection.teamId,
        ownerId: connection.ownerId,
        connectionId,
        artifactType: "oauth_transaction"
      }),
      redirectUri,
      issuer: "",
      resourceUri,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      consumedAt: "",
      createdAt: now,
      updatedAt: now
    };
    await this.repository.createAuthTransaction(transaction);
    try {
      await this.queue.enqueueAuthorizationPrepare(transaction.id);
    } catch (queueError) {
      await this.repository.failAuthTransaction(transaction.id);
      throw queueError;
    }
    return this.publicAuthTransaction(transaction);
  }

  async authTransaction(actor: SessionUser, transactionId: string) {
    const scope = this.resolveScope(actor);
    authorize({ actor, resource: "integration.connection", action: "read", requestedScope: scope });
    return this.publicAuthTransaction(await this.repository.getAuthTransaction(transactionId, scope));
  }

  async receiveOAuthCallback(connectorCode: string, input: { state: string; code?: string; iss?: string; oauthError?: string }) {
    if (!/^[A-Za-z0-9_-]{40,100}$/u.test(input.state)) error("INTEGRATION_OAUTH_STATE_INVALID", "OAuth state 无效", 400);
    const transaction = await this.repository.findAuthTransactionForCallback(sha256(input.state), connectorCode);
    if (!transaction) error("INTEGRATION_OAUTH_STATE_INVALID", "OAuth state 无效或已过期", 400);
    if (new Date(transaction.expiresAt).getTime() <= Date.now()) {
      await this.repository.failAuthTransaction(transaction.id);
      error("INTEGRATION_OAUTH_STATE_INVALID", "OAuth 授权已过期", 409);
    }
    const context = this.transactionContext(transaction);
    const supplied = Buffer.from(input.state);
    const expected = Buffer.from(context.state);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || context.connectorCode !== connectorCode) {
      error("INTEGRATION_OAUTH_STATE_INVALID", "OAuth 回调绑定校验失败", 400);
    }
    if (input.oauthError) {
      await this.repository.failAuthTransaction(transaction.id);
      error("INTEGRATION_OAUTH_DENIED", "外部账号未完成授权", 400);
    }
    if (!input.code || input.code.length > 2_048) error("INTEGRATION_OAUTH_CODE_INVALID", "OAuth 授权码缺失或无效", 400);
    if (input.iss && context.issuer && input.iss !== context.issuer) {
      await this.repository.failAuthTransaction(transaction.id);
      error("INTEGRATION_OAUTH_ISSUER_MISMATCH", "OAuth issuer 与授权事务不匹配", 400);
    }
    const encryptedContext = encryptIntegrationValue({
      ...context,
      authorizationCode: input.code,
      callbackIssuer: input.iss || ""
    }, this.credentialKey, {
      teamId: transaction.teamId,
      ownerId: transaction.ownerId,
      connectionId: transaction.connectionId,
      artifactType: "oauth_transaction"
    });
    await this.repository.markAuthCallbackReceived(transaction.id, encryptedContext);
    await this.queue.enqueueAuthorizationComplete(transaction.id);
    return { transactionId: transaction.id, connectionId: transaction.connectionId };
  }

  async confirmAuthorization(actor: SessionUser, connectionId: string, transactionId = "") {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(connectionId, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "update", requestedScope: scope, object: connection });
    if (connection.status !== "pending_confirmation") error("INTEGRATION_CONNECTION_STATE_CONFLICT", "连接尚未完成外部授权", 409);
    const transaction = transactionId
      ? await this.repository.getAuthTransaction(transactionId, scope)
      : await this.repository.latestAuthTransaction(connectionId, scope);
    if (!transaction || transaction.connectionId !== connectionId || transaction.status !== "completed") {
      error("INTEGRATION_OAUTH_STATE_INVALID", "授权事务尚未完成", 409);
    }
    await this.repository.consumeAuthTransaction(transaction.id, connectionId);
    const discovering = await this.repository.transitionConnection(connectionId, scope, "pending_confirmation", "discovering");
    try {
      await this.queue.enqueueDiscovery(connectionId, "initial");
    } catch (queueError) {
      await this.repository.transitionConnection(connectionId, scope, "discovering", "failed");
      throw queueError;
    }
    return discovering;
  }

  async reauthorizeConnection(actor: SessionUser, connectionId: string) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(connectionId, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "update", requestedScope: scope, object: connection });
    if (!new Set(["reauthorization_required", "failed"]).has(connection.status)) {
      error("INTEGRATION_CONNECTION_STATE_CONFLICT", "当前连接不需要重新授权", 409);
    }
    const connector = await this.repository.getConnector(connection.connectorId, connection.teamId, connection.scope === "platform");
    if (!connector) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接器不存在", 404);
    if (parsedManifest(connector.manifestJson).authentication === "api_token") {
      error("INTEGRATION_API_CREDENTIAL_REQUIRED", "该连接器需要重新填写 API 凭据", 409);
    }
    await this.repository.transitionConnection(connectionId, scope, connection.status, "authorizing");
    return this.startAuthorization(actor, connectionId);
  }

  async replaceApiCredentials(actor: SessionUser, connectionId: string, rawCredentials: Record<string, unknown>) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(connectionId, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "update", requestedScope: scope, object: connection });
    if (connection.status !== "reauthorization_required") {
      error("INTEGRATION_CONNECTION_STATE_CONFLICT", "只有凭据失效的连接可以更新 API 凭据", 409);
    }
    const connector = await this.repository.getConnector(connection.connectorId, connection.teamId, connection.scope === "platform");
    if (!connector) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接器不存在", 404);
    const manifest = parsedManifest(connector.manifestJson);
    if (manifest.authentication !== "api_token") error("INTEGRATION_API_CREDENTIAL_NOT_SUPPORTED", "该连接器不使用 API 凭据", 409);
    const credentials = apiCredentialInput(manifest, rawCredentials);
    await this.repository.transitionConnection(connectionId, scope, "reauthorization_required", "authorizing");
    await this.repository.saveApiCredential({
      connectionId,
      teamId: connection.teamId,
      encryptedValue: encryptIntegrationValue(credentials, this.credentialKey, {
        teamId: connection.teamId, ownerId: connection.ownerId, connectionId, artifactType: "api_token"
      }),
      fingerprint: sha256(canonicalJson(credentials))
    });
    await this.repository.transitionConnection(connectionId, scope, "authorizing", "pending_confirmation");
    const discovering = await this.repository.transitionConnection(connectionId, scope, "pending_confirmation", "discovering");
    try {
      await this.queue.enqueueDiscovery(connectionId, "initial");
    } catch (queueError) {
      await this.repository.transitionConnection(connectionId, scope, "discovering", "failed");
      throw queueError;
    }
    return discovering;
  }

  async tools(actor: SessionUser, connectionId = "", requestedTeamId = "") {
    const scope = this.resolveScope(actor, requestedTeamId);
    authorize({ actor, resource: "integration.tool", action: "read", requestedScope: scope });
    return this.repository.listTools(scope, connectionId);
  }

  async approveTool(actor: SessionUser, toolId: string, input: {
    stableAlias: string;
    riskLevel: number;
    permissionCode: string;
    fieldAllowlist: string[];
    dailyCallLimit: number;
    allowedDataClasses?: string[];
    approvalPolicy?: "risk_based" | "always";
    completionEvidence?: string[];
  }) {
    const scope = this.resolveScope(actor, "", "integration.manage");
    authorize({ actor, resource: "integration.tool", action: "review", requestedScope: scope });
    if (!/^[a-z][a-z0-9._:-]{2,119}$/u.test(input.stableAlias)) error("INTEGRATION_INPUT_INVALID", "稳定工具别名格式无效");
    if (!Number.isInteger(input.riskLevel) || input.riskLevel < 0 || input.riskLevel > 5) {
      error("INTEGRATION_INPUT_INVALID", "风险等级必须在 R0-R5 之间");
    }
    const toolForPolicy = await this.repository.getTool(toolId, scope);
    if (!toolForPolicy) error("INTEGRATION_TOOL_NOT_APPROVED", "工具不存在或无权访问", 404);
    const minimumRisk: Record<string, number> = {
      "mail.list_accounts": 1,
      "mail.search_messages": 2,
      "mail.get_message": 2,
      "calendar.list_events": 2,
      "calendar.get_availability": 2,
      "mail.create_draft": 3,
      "mail.send_message": 4,
      "calendar.create_event": 4,
      "calendar.update_event": 4,
      "erp.customers.search": 2,
      "erp.quotations.search": 2,
      "erp.quotations.get": 2,
      "erp.quotations.create": 4,
      "erp.sales_orders.search": 2,
      "erp.sales_orders.get": 2,
      "erp.sales_orders.create": 4,
      "erp.inventory.get_balance": 1,
      "erp.invoices.search": 2,
      "logistics.search_trackers": 2,
      "logistics.get_tracking": 2,
      "logistics.create_tracking": 3,
      "storage.list_files": 2,
      "storage.get_file_metadata": 2,
      "storage.create_folder": 3,
      "storage.upload_trade_document": 4,
      "storage.share_document": 4,
      "wecom.departments.list": 1,
      "wecom.members.list": 2,
      "wecom.external_contacts.list": 2,
      "wecom.external_contacts.get": 2,
      "wecom.app_message.send_text": 4
    };
    const requiredRisk = minimumRisk[toolForPolicy.remoteName] || 0;
    if (input.riskLevel < requiredRisk) {
      error("INTEGRATION_INPUT_INVALID", `${toolForPolicy.displayName || toolForPolicy.remoteName} 最低必须配置为 R${requiredRisk}`);
    }
    const schema = JSON.parse(toolForPolicy.inputSchemaJson || "{}") as { properties?: Record<string, unknown> };
    const schemaFields = Object.keys(schema.properties || {});
    const fieldAllowlist = [...new Set(input.fieldAllowlist)].filter((field) => schemaFields.includes(field));
    const allowedDataClasses = [...new Set(input.allowedDataClasses || ["public", "business", "personal"])]
      .filter((value) => ["public", "business", "personal", "sensitive"].includes(value));
    const writeEvidence = [...new Set(input.completionEvidence || [])].filter((value) => [
      "created_object_id", "external_receipt_id", "state_transition", "read_after_write_match",
      "delivery_acceptance", "file_artifact"
    ].includes(value));
    if (input.riskLevel >= 3 && !writeEvidence.length) {
      error("INTEGRATION_INPUT_INVALID", "写入工具至少需要一种可验证的完成证据");
    }
    const evidenceByTool: Record<string, string[]> = {
      "mail.create_draft": ["created_object_id"],
      "mail.send_message": ["external_receipt_id", "delivery_acceptance"],
      "calendar.create_event": ["created_object_id"],
      "calendar.update_event": ["state_transition", "read_after_write_match"],
      "erp.quotations.create": ["created_object_id", "read_after_write_match"],
      "erp.sales_orders.create": ["created_object_id", "read_after_write_match"],
      "logistics.create_tracking": ["created_object_id", "read_after_write_match"],
      "storage.create_folder": ["created_object_id"],
      "storage.upload_trade_document": ["created_object_id", "file_artifact"],
      "storage.share_document": ["external_receipt_id", "delivery_acceptance"],
      "wecom.app_message.send_text": ["external_receipt_id", "delivery_acceptance"]
    };
    const missingEvidence = (evidenceByTool[toolForPolicy.remoteName] || []).filter((item) => !writeEvidence.includes(item));
    if (missingEvidence.length) {
      error("INTEGRATION_INPUT_INVALID", `该工具必须启用完成证据：${missingEvidence.join("、")}`);
    }
    const review: ToolReviewInput = {
      status: "active",
      stableAlias: input.stableAlias,
      riskLevel: input.riskLevel,
      permissionCode: input.permissionCode,
      reviewerId: actor.id,
      review: {
        allowedDataScopes: ["self", "team"],
        fieldAllowlist,
        approvalPolicy: input.riskLevel >= 4 ? "always" : input.approvalPolicy || "risk_based",
        dailyCallLimit: Math.max(1, Math.min(10_000, input.dailyCallLimit)),
        automationAllowed: false,
        completionEvidence: input.riskLevel >= 3 ? writeEvidence : ["source", "observedAt"],
        dataEgressPolicy: {
          allowedClassifications: allowedDataClasses.length ? allowedDataClasses : ["public", "business"],
          fieldClassifications: Object.fromEntries(schemaFields.map((field) => [field, classifyField(field)])),
          secretFieldsDenied: true
        }
      }
    };
    const tool = await this.repository.reviewTool(toolId, scope, review);
    const grants: GrantInput[] = [{
      subjectType: "team",
      subjectId: tool.teamId,
      permissionCode: input.permissionCode,
      constraints: { dailyCallLimit: review.review.dailyCallLimit, fieldAllowlist }
    }];
    await this.repository.replaceGrants(tool, actor.id, grants);
    const pending = await this.repository.countPendingReviewTools(tool.connectionId);
    const active = await this.repository.countActiveTools(tool.connectionId);
    const connectionStatus = await this.repository.connectionStatuses(tool.connectionId);
    if (pending === 0 && active > 0 && connectionStatus === "pending_review") {
      await this.repository.transitionConnection(tool.connectionId, { type: "team", teamId: tool.teamId }, "pending_review", "active");
      await this.queue.enqueueWebhookSync(tool.connectionId);
    }
    return tool;
  }

  async rejectTool(actor: SessionUser, toolId: string, note = "") {
    const scope = this.resolveScope(actor, "", "integration.manage");
    authorize({ actor, resource: "integration.tool", action: "review", requestedScope: scope });
    const tool = await this.repository.reviewTool(toolId, scope, {
      status: "rejected",
      stableAlias: "",
      riskLevel: 0,
      permissionCode: "",
      reviewerId: actor.id,
      review: { note: note.slice(0, 500) }
    });
    const pending = await this.repository.countPendingReviewTools(tool.connectionId);
    const active = await this.repository.countActiveTools(tool.connectionId);
    const connectionStatus = await this.repository.connectionStatuses(tool.connectionId);
    if (pending === 0 && active > 0 && connectionStatus === "pending_review") {
      await this.repository.transitionConnection(tool.connectionId, { type: "team", teamId: tool.teamId }, "pending_review", "active");
      await this.queue.enqueueWebhookSync(tool.connectionId);
    }
    return tool;
  }

  async pauseConnection(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(id, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "pause", requestedScope: scope, object: connection });
    if (!new Set(["active", "pending_review"]).has(connection.status)) error("INTEGRATION_CONNECTION_STATE_CONFLICT", "当前状态不能暂停", 409);
    await this.queue.enqueueTerminate(id);
    await this.repository.cancelConnectionApprovals(id, "连接已暂停");
    return this.repository.transitionConnection(id, scope, connection.status, "paused");
  }

  async resumeConnection(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(id, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "pause", requestedScope: scope, object: connection });
    if (connection.status !== "paused") error("INTEGRATION_CONNECTION_STATE_CONFLICT", "连接不是暂停状态", 409);
    if (await this.repository.countActiveTools(id) < 1) error("INTEGRATION_TOOL_NOT_APPROVED", "至少审核一个只读工具后才能恢复", 409);
    const resumed = await this.repository.transitionConnection(id, scope, "paused", "active");
    await this.queue.enqueueWebhookSync(id);
    return resumed;
  }

  async refreshTools(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(id, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "update", requestedScope: scope, object: connection });
    if (!new Set(["active", "degraded", "pending_review"]).has(connection.status)) {
      error("INTEGRATION_CONNECTION_STATE_CONFLICT", "当前连接不能刷新工具", 409);
    }
    await this.queue.enqueueDiscovery(id, "refresh");
    return connection;
  }

  async disconnectConnection(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor, "", "integration.connect");
    const connection = await this.repository.getConnection(id, scope);
    if (!connection) error("INTEGRATION_CONNECTION_NOT_FOUND", "连接不存在或无权访问", 404);
    authorize({ actor, resource: "integration.connection", action: "disconnect", requestedScope: scope, object: connection });
    if (!new Set(["authorizing", "pending_confirmation", "active", "degraded", "reauthorization_required", "paused", "failed"]).has(connection.status)) {
      error("INTEGRATION_CONNECTION_STATE_CONFLICT", "当前状态不能解绑", 409);
    }
    const directDisconnect = new Set(["authorizing", "pending_confirmation", "failed"]).has(connection.status);
    const disconnecting = directDisconnect
      ? await this.repository.transitionConnection(id, scope, connection.status, "disconnected")
      : await this.repository.transitionConnection(id, scope, connection.status, "disconnecting");
    await this.queue.enqueueDisconnect(id);
    await this.repository.cancelConnectionApprovals(id, "连接已解绑");
    return disconnecting.status === "disconnected"
      ? disconnecting
      : this.repository.transitionConnection(id, scope, "disconnecting", "disconnected");
  }

  async createReadOnlyCall(actor: SessionUser, stableAlias: string, rawInput: Record<string, unknown>, requestId = `req_${randomUUID()}`) {
    const scope = resolveDataScope(actor, {}, "integration.execute");
    authorize({ actor, resource: "integration.tool", action: "execute", requestedScope: scope });
    const tool = await this.repository.findActiveToolByAlias(stableAlias, scope);
    if (!tool) error("INTEGRATION_TOOL_NOT_APPROVED", "工具不存在、未审核或连接不可用", 404);
    return this.createToolCall(actor, tool, rawInput, requestId);
  }

  private async createToolCall(
    actor: SessionUser,
    tool: ToolSnapshot,
    rawInput: Record<string, unknown>,
    requestId: string,
    businessContext?: Record<string, unknown>,
    businessLink?: {
      objectType: "customer";
      objectId: string;
      operation: "mail_send" | "calendar_create" | "calendar_update";
      externalThreadId: string;
      nextActionAt: string;
      metadata: Record<string, unknown>;
    }
  ) {
    const scope = resolveDataScope(actor, {}, "integration.execute");
    if (!await this.repository.hasActiveGrant(tool, actor)) error("INTEGRATION_TOOL_GRANT_DENIED", "当前账号没有此工具授权", 403);
    const input = fieldFilteredInput(tool, rawInput);
    const egress = egressDecision(tool, input);
    if (egress.denied.length) {
      error("INTEGRATION_DATA_EGRESS_DENIED", `以下字段不允许发送到外部服务：${egress.denied.map((item) => item.field).join("、")}`, 403);
    }
    const validate = ajv.compile(JSON.parse(tool.inputSchemaJson));
    if (!validate(input)) error("INTEGRATION_INPUT_INVALID", ajv.errorsText(validate.errors, { separator: "; " }));
    const canonical = canonicalJson(input);
    const inputHash = sha256(canonical);
    const replay = await this.repository.getCallByRequestId(requestId, scope);
    if (replay) {
      if (replay.inputHash !== inputHash || replay.toolSnapshotId !== tool.id || replay.actorId !== actor.id) {
        error("INTEGRATION_IDEMPOTENCY_CONFLICT", "相同 requestId 已绑定不同参数或工具", 409);
      }
      return replay;
    }
    const callId = `icl_${randomUUID()}`;
    const artifactId = `iar_${randomUUID()}`;
    const now = new Date().toISOString();
    const artifactExpiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const review = parsedReview(tool);
    const dailyCallLimit = Math.max(1, Math.min(10_000, Number(review.dailyCallLimit || 100)));
    const approvalRequired = tool.riskLevel >= 4 || review.approvalPolicy === "always";
    const baseInput = {
      id: callId,
      requestId,
      teamId: actor.teamId,
      ownerId: actor.id,
      actorId: actor.id,
      actorAuthVersion: Number(actor.authVersion || 1),
      connectionId: tool.connectionId,
      toolSnapshotId: tool.id,
      riskLevel: tool.riskLevel,
      inputHash,
      dailyCallLimit,
      inputBytes: Buffer.byteLength(canonical, "utf8"),
      inputSummary: {
        ...inputSummary(input),
        ...(businessContext ? { businessContext } : {}),
        dataEgress: {
          destination: tool.connectionId,
          fields: egress.fields,
          allowedClassifications: egress.allowedClassifications
        },
        approval: {
          policyHash: sha256(canonicalJson(review)),
          schemaHash: tool.schemaHash,
          previewFields: Object.keys(safeApprovalPreview(input))
        }
      },
      idempotencyKeyHash: sha256(`${actor.teamId}\n${tool.id}\n${requestId}\n${inputHash}`),
      artifact: {
        id: artifactId,
        encryptedValue: encryptIntegrationValue(input, this.credentialKey, {
          teamId: actor.teamId,
          ownerId: actor.id,
          connectionId: tool.connectionId,
          artifactType: "tool_input"
        }),
        contentHash: inputHash,
        keyVersion: "v1",
        expiresAt: artifactExpiresAt
      },
      createdAt: now,
      ...(businessLink ? { businessLink: { id: `ibl_${randomUUID()}`, ...businessLink } } : {})
    };
    try {
      if (approvalRequired) {
        const approvalId = `iap_${randomUUID()}`;
        await this.repository.createApprovalCall({
          ...baseInput,
          approval: {
            id: approvalId,
            singleUseNonceHash: sha256(randomBytes(32).toString("base64url")),
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
          }
        });
        await this.notifyApprovers(actor, approvalId, tool.displayName || tool.remoteName, tool.riskLevel);
        return this.repository.getCall(callId, scope);
      }
      const call = await this.repository.createReadCall(baseInput);
      await this.queue.enqueueToolCall(callId);
      return call;
    } catch (cause) {
      if ((cause as { code?: string }).code === "INTEGRATION_DAILY_QUOTA_EXCEEDED") {
        await this.notifyQuotaExceeded(actor, tool, dailyCallLimit).catch(() => undefined);
      }
      throw cause;
    }
  }

  private async workspaceTool(actor: SessionUser, remoteName: string, connectorCode: "microsoft-365" | "google-workspace", connectorName: string) {
    authorize({ actor, resource: "integration.tool", action: "execute", requestedScope: resolveDataScope(actor, {}, "integration.execute") });
    const tool = await this.repository.findActivePersonalToolByRemoteName(remoteName, actor, connectorCode);
    if (!tool) error("INTEGRATION_TOOL_NOT_APPROVED", `请先连接并审核本人的 ${connectorName} 对应工具`, 404);
    return tool;
  }

  private businessCustomer(actor: SessionUser, customerId: string) {
    const customer = getStore().customers.find((item) => item.id === customerId && item.poolStatus !== "public");
    if (!customer) error("INTEGRATION_BUSINESS_OBJECT_NOT_FOUND", "客户不存在或已进入公海", 404);
    if (!canSeeOwner(actor, customer.ownerId, customer.teamId)) {
      error("INTEGRATION_BUSINESS_OBJECT_NOT_FOUND", "客户不存在或不属于当前授权范围", 404);
    }
    return customer;
  }

  private async executeWorkspaceRead(
    actor: SessionUser,
    remoteName: string,
    input: Record<string, unknown>,
    requestId: string,
    connectorCode: "microsoft-365" | "google-workspace",
    connectorName: string
  ) {
    const tool = await this.workspaceTool(actor, remoteName, connectorCode, connectorName);
    if (tool.riskLevel > 2) error("INTEGRATION_TOOL_POLICY_INVALID", "只读工具风险配置异常，请管理员重新审核", 409);
    const call = await this.createToolCall(actor, tool, input, requestId);
    if (!call) error("INTEGRATION_CALL_NOT_FOUND", "工具调用未创建", 500);
    return this.waitForReadOnlyCall(actor, call.id, 30_000);
  }

  private resultStructured(result: unknown) {
    const envelope = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const toolResult = envelope.result && typeof envelope.result === "object" ? envelope.result as Record<string, unknown> : {};
    const structured = toolResult.structuredContent;
    return structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured as Record<string, unknown> : {};
  }

  private async workspaceMailSearch(
    actor: SessionUser,
    input: Record<string, unknown>,
    requestId: string,
    connectorCode: "microsoft-365" | "google-workspace",
    connectorName: string
  ) {
    const completed = await this.executeWorkspaceRead(actor, "mail.search_messages", input, requestId, connectorCode, connectorName);
    const structured = this.resultStructured(completed);
    const messages = Array.isArray(structured.messages) ? structured.messages.map((item) => item as Record<string, unknown>) : [];
    const threadIds = messages.map((message) => String(message.conversationId || "")).filter(Boolean);
    const threadLinks = await this.repository.listBusinessThreadLinks(actor.teamId, actor.id, threadIds);
    const threadCustomer = new Map(threadLinks.map((link) => [link.externalThreadId, link.objectId]));
    const scope = resolveDataScope(actor, {}, "integration.execute");
    const customers = getStore().customers.filter((customer) => {
      if (customer.poolStatus === "public") return false;
      try { assertObjectScope(actor, scope, customer); return true; } catch { return false; }
    });
    const commonDomains = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "qq.com", "163.com", "126.com"]);
    const extractEmails = (value: string) => [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)].map((match) => match[0]!.toLowerCase());
    const senderAddress = (message: Record<string, unknown>) => {
      const sender = message.sender && typeof message.sender === "object" ? message.sender as Record<string, unknown> : {};
      const from = message.from && typeof message.from === "object" ? message.from as Record<string, unknown> : {};
      const source = Object.keys(sender).length ? sender : from;
      const emailAddress = source.emailAddress && typeof source.emailAddress === "object" ? source.emailAddress as Record<string, unknown> : {};
      return String(emailAddress.address || "").trim().toLowerCase();
    };
    const matchedMessages = messages.map((message) => {
      const sender = senderAddress(message);
      const domain = sender.split("@")[1] || "";
      const linkedCustomerId = threadCustomer.get(String(message.conversationId || "")) || "";
      const candidates = customers.map((customer) => {
        const emails = extractEmails(`${customer.email || ""} ${customer.documentContact || ""} ${customer.contact || ""}`);
        const domains = new Set(emails.map((email) => email.split("@")[1]).filter(Boolean));
        let score = 0;
        const evidence: string[] = [];
        if (linkedCustomerId === customer.id) { score += 160; evidence.push("历史会话已关联"); }
        if (sender && emails.includes(sender)) { score += 120; evidence.push("联系人邮箱一致"); }
        if (domain && !commonDomains.has(domain) && domains.has(domain)) { score += 60; evidence.push("企业邮箱域名一致"); }
        return { customerId: customer.id, company: customer.company, contact: customer.contact, score, evidence };
      }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score).slice(0, 3);
      const top = candidates[0];
      const unambiguous = Boolean(top && top.score >= 100 && (!candidates[1] || candidates[1].score < top.score));
      return { ...message, crmMatch: { status: unambiguous ? "matched" : candidates.length ? "ambiguous" : "unmatched", customer: unambiguous ? top : null, candidates } };
    });
    return { ...completed, messages: matchedMessages, page: structured.page || {}, source: structured.source, observedAt: structured.observedAt };
  }

  async microsoftMailSearch(actor: SessionUser, input: Record<string, unknown>, requestId: string) {
    return this.workspaceMailSearch(actor, input, requestId, "microsoft-365", "Microsoft 365");
  }

  async googleMailSearch(actor: SessionUser, input: Record<string, unknown>, requestId: string) {
    return this.workspaceMailSearch(actor, input, requestId, "google-workspace", "Google Workspace");
  }

  async microsoftMessage(actor: SessionUser, messageId: string, requestId: string) {
    return this.executeWorkspaceRead(actor, "mail.get_message", { messageId }, requestId, "microsoft-365", "Microsoft 365");
  }

  async googleMessage(actor: SessionUser, messageId: string, requestId: string) {
    return this.executeWorkspaceRead(actor, "mail.get_message", { messageId }, requestId, "google-workspace", "Google Workspace");
  }

  async microsoftCalendarEvents(actor: SessionUser, input: Record<string, unknown>, requestId: string) {
    return this.executeWorkspaceRead(actor, "calendar.list_events", input, requestId, "microsoft-365", "Microsoft 365");
  }

  async googleCalendarEvents(actor: SessionUser, input: Record<string, unknown>, requestId: string) {
    return this.executeWorkspaceRead(actor, "calendar.list_events", input, requestId, "google-workspace", "Google Workspace");
  }

  async microsoftCalendarAvailability(actor: SessionUser, input: Record<string, unknown>, requestId: string) {
    return this.executeWorkspaceRead(actor, "calendar.get_availability", input, requestId, "microsoft-365", "Microsoft 365");
  }

  async googleCalendarAvailability(actor: SessionUser, input: Record<string, unknown>, requestId: string) {
    return this.executeWorkspaceRead(actor, "calendar.get_availability", input, requestId, "google-workspace", "Google Workspace");
  }

  private async createWorkspaceBusinessWrite(actor: SessionUser, input: {
    remoteName: "mail.send_message" | "calendar.create_event" | "calendar.update_event";
    connectorCode: "microsoft-365" | "google-workspace";
    connectorName: string;
    customerId: string;
    toolInput: Record<string, unknown>;
    operation: "mail_send" | "calendar_create" | "calendar_update";
    externalThreadId?: string;
    nextActionAt?: string;
    metadata: Record<string, unknown>;
    requestId: string;
  }) {
    const customer = this.businessCustomer(actor, input.customerId);
    const tool = await this.workspaceTool(actor, input.remoteName, input.connectorCode, input.connectorName);
    const businessContext = { objectType: "customer", objectId: customer.id, operation: input.operation };
    const call = await this.createToolCall(actor, tool, input.toolInput, input.requestId, businessContext, {
      objectType: "customer",
      objectId: customer.id,
      operation: input.operation,
      externalThreadId: input.externalThreadId || "",
      nextActionAt: input.nextActionAt || "",
      metadata: input.metadata
    });
    if (!call) error("INTEGRATION_CALL_NOT_FOUND", "业务调用未创建", 500);
    return { call, approvalRequired: call.status === "awaiting_approval", customer: { id: customer.id, company: customer.company } };
  }

  async microsoftSendMail(actor: SessionUser, input: {
    customerId: string; to: string[]; cc?: string[]; subject: string; body: string;
    bodyType?: "text" | "html"; attachments?: unknown[]; conversationId?: string; nextFollowAt?: string;
  }, requestId: string) {
    return this.createWorkspaceBusinessWrite(actor, {
      remoteName: "mail.send_message",
      connectorCode: "microsoft-365",
      connectorName: "Microsoft 365",
      customerId: input.customerId,
      toolInput: { to: input.to, cc: input.cc || [], subject: input.subject, body: input.body, bodyType: input.bodyType || "text", attachments: input.attachments || [] },
      operation: "mail_send",
      externalThreadId: input.conversationId || "",
      nextActionAt: input.nextFollowAt || "",
      metadata: { providerName: "Microsoft 365", subject: input.subject, recipients: input.to },
      requestId
    });
  }

  async googleSendMail(actor: SessionUser, input: {
    customerId: string; to: string[]; cc?: string[]; subject: string; body: string;
    bodyType?: "text" | "html"; attachments?: unknown[]; conversationId?: string; inReplyTo?: string; nextFollowAt?: string;
  }, requestId: string) {
    return this.createWorkspaceBusinessWrite(actor, {
      remoteName: "mail.send_message",
      connectorCode: "google-workspace",
      connectorName: "Google Workspace",
      customerId: input.customerId,
      toolInput: {
        to: input.to, cc: input.cc || [], subject: input.subject, body: input.body,
        bodyType: input.bodyType || "text", attachments: input.attachments || [],
        ...(input.conversationId ? { threadId: input.conversationId } : {}),
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {})
      },
      operation: "mail_send",
      externalThreadId: input.conversationId || "",
      nextActionAt: input.nextFollowAt || "",
      metadata: { providerName: "Google Workspace", subject: input.subject, recipients: input.to },
      requestId
    });
  }

  async microsoftCreateEvent(actor: SessionUser, input: {
    customerId: string; subject: string; startUtc: string; endUtc: string; timeZone: string;
    attendees: string[]; body?: string; onlineMeeting?: boolean; location?: string; nextFollowAt?: string;
  }, requestId: string) {
    return this.createWorkspaceBusinessWrite(actor, {
      remoteName: "calendar.create_event",
      connectorCode: "microsoft-365",
      connectorName: "Microsoft 365",
      customerId: input.customerId,
      toolInput: { subject: input.subject, startUtc: input.startUtc, endUtc: input.endUtc, timeZone: input.timeZone,
        attendees: input.attendees, body: input.body || "", onlineMeeting: input.onlineMeeting === true, location: input.location || "" },
      operation: "calendar_create",
      nextActionAt: input.nextFollowAt || "",
      metadata: { providerName: "Microsoft 365", subject: input.subject, startUtc: input.startUtc, endUtc: input.endUtc, timeZone: input.timeZone },
      requestId
    });
  }

  async googleCreateEvent(actor: SessionUser, input: {
    customerId: string; subject: string; startUtc: string; endUtc: string; timeZone: string;
    attendees: string[]; body?: string; onlineMeeting?: boolean; location?: string; nextFollowAt?: string;
  }, requestId: string) {
    return this.createWorkspaceBusinessWrite(actor, {
      remoteName: "calendar.create_event",
      connectorCode: "google-workspace",
      connectorName: "Google Workspace",
      customerId: input.customerId,
      toolInput: { subject: input.subject, startUtc: input.startUtc, endUtc: input.endUtc, timeZone: input.timeZone,
        attendees: input.attendees, body: input.body || "", onlineMeeting: input.onlineMeeting === true, location: input.location || "" },
      operation: "calendar_create",
      nextActionAt: input.nextFollowAt || "",
      metadata: { providerName: "Google Workspace", subject: input.subject, startUtc: input.startUtc, endUtc: input.endUtc, timeZone: input.timeZone },
      requestId
    });
  }

  async microsoftUpdateEvent(actor: SessionUser, input: {
    customerId: string; eventId: string; etag: string; subject?: string; startUtc?: string; endUtc?: string;
    timeZone?: string; attendees?: string[]; body?: string; onlineMeeting?: boolean; location?: string; nextFollowAt?: string;
  }, requestId: string) {
    const toolInput = Object.fromEntries(Object.entries({
      eventId: input.eventId, etag: input.etag, subject: input.subject, startUtc: input.startUtc,
      endUtc: input.endUtc, timeZone: input.timeZone, attendees: input.attendees,
      body: input.body, onlineMeeting: input.onlineMeeting, location: input.location
    }).filter(([, value]) => value !== undefined));
    return this.createWorkspaceBusinessWrite(actor, {
      remoteName: "calendar.update_event",
      connectorCode: "microsoft-365",
      connectorName: "Microsoft 365",
      customerId: input.customerId,
      toolInput,
      operation: "calendar_update",
      nextActionAt: input.nextFollowAt || "",
      metadata: { providerName: "Microsoft 365", subject: input.subject || "会议", eventId: input.eventId },
      requestId
    });
  }

  async googleUpdateEvent(actor: SessionUser, input: {
    customerId: string; eventId: string; etag: string; subject?: string; startUtc?: string; endUtc?: string;
    timeZone?: string; attendees?: string[]; body?: string; onlineMeeting?: boolean; location?: string; nextFollowAt?: string;
  }, requestId: string) {
    const toolInput = Object.fromEntries(Object.entries({
      eventId: input.eventId, etag: input.etag, subject: input.subject, startUtc: input.startUtc,
      endUtc: input.endUtc, timeZone: input.timeZone, attendees: input.attendees,
      body: input.body, onlineMeeting: input.onlineMeeting, location: input.location
    }).filter(([, value]) => value !== undefined));
    return this.createWorkspaceBusinessWrite(actor, {
      remoteName: "calendar.update_event",
      connectorCode: "google-workspace",
      connectorName: "Google Workspace",
      customerId: input.customerId,
      toolInput,
      operation: "calendar_update",
      nextActionAt: input.nextFollowAt || "",
      metadata: { providerName: "Google Workspace", subject: input.subject || "会议", eventId: input.eventId },
      requestId
    });
  }

  async processBusinessWritebacks() {
    const links = await this.repository.listPendingBusinessWritebacks(100);
    for (const link of links) {
      const store = getStore();
      const customer = store.customers.find((item) => item.id === link.objectId && item.teamId === link.teamId);
      if (!customer) {
        await this.repository.failBusinessWriteback(link.id, new Error("CRM 客户已不存在，不能回写"));
        continue;
      }
      try {
        const artifact = await this.repository.getCallResultArtifact(link.callId, { type: "personal", teamId: link.teamId, ownerId: link.ownerId });
        if (!artifact) continue;
        const result = decryptIntegrationValue<Record<string, unknown>>(artifact.encryptedValue, this.credentialKey, {
          teamId: artifact.teamId, ownerId: artifact.ownerId, connectionId: artifact.connectionId, artifactType: "tool_result"
        });
        const structured = result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent as Record<string, unknown> : {};
        const call = await this.repository.getCall(link.callId, { type: "personal", teamId: link.teamId, ownerId: link.ownerId });
        const externalObjectId = String(structured.messageId || structured.eventId || structured.externalReceiptId || call?.externalReceipt || "");
        if (!externalObjectId) throw new Error("外部写入结果缺少对象编号");
        const digest = sha256(link.callId).slice(0, 36);
        const activityId = `ca_int_${digest}`.slice(0, 64);
        const subject = String(link.metadata.subject || "外部业务操作").slice(0, 255);
        const isMail = link.operation === "mail_send";
        const providerName = String(link.metadata.providerName || "Microsoft 365").slice(0, 80);
        const meetingLink = String(structured.meetingLink || "");
        if (!store.customerActivities.some((activity) => activity.id === activityId)) {
          store.customerActivities.unshift({
            id: activityId,
            customerId: customer.id,
            type: isMail ? "email" : "meeting",
            content: isMail ? `${providerName} 邮件已发送：${subject}` : `${providerName} 会议${link.operation === "calendar_update" ? "已更新" : "已创建"}：${subject}${meetingLink ? `（${meetingLink}）` : ""}`,
            operatorId: link.ownerId,
            nextReminder: link.nextActionAt,
            createdAt: String(structured.observedAt || new Date().toISOString())
          });
        }
        if (link.nextActionAt) {
          customer.nextReminder = link.nextActionAt;
          const todoId = `t_int_${digest}`.slice(0, 64);
          if (!store.todos.some((todo) => todo.id === todoId)) {
            store.todos.unshift({
              id: todoId, title: isMail ? `跟进邮件：${customer.company}` : `跟进会议：${customer.company}`,
              type: "customer", priority: "medium", status: "pending", dueAt: link.nextActionAt,
              ownerId: link.ownerId, teamId: link.teamId, related: customer.company, customerId: customer.id,
              done: false, triggerKey: `integration:${link.callId}`, createdAt: new Date().toISOString()
            });
          }
        }
        await store.persist();
        await this.repository.completeBusinessWriteback(link.id, externalObjectId, link.externalThreadId || String(structured.conversationId || ""));
      } catch {
        // 保持 pending，由下一轮维护任务重试；确定性 ID 保证不会重复回写。
      }
    }
    return links.length;
  }

  async processInboundWebhookWritebacks() {
    const events = await this.repository.listPendingWebhookWritebacks(100);
    for (const event of events) {
      try {
        const artifact = decryptIntegrationValue<Record<string, unknown>>(event.encryptedValue, this.credentialKey, {
          teamId: event.teamId,
          ownerId: event.ownerId,
          connectionId: event.connectionId,
          artifactType: "webhook_result"
        });
        if (sha256(canonicalJson(artifact)) !== event.contentHash) {
          throw new Error("Webhook 结果 Artifact 完整性校验失败");
        }
        const message = artifact.message && typeof artifact.message === "object"
          ? artifact.message as Record<string, unknown> : {};
        const messageId = String(message.id || "");
        if (!messageId || event.eventType !== "microsoft.message.created") {
          throw new Error("Webhook 结果缺少 Microsoft 邮件编号或事件类型无效");
        }
        const senderNode = message.sender && typeof message.sender === "object"
          ? message.sender as Record<string, unknown>
          : message.from && typeof message.from === "object" ? message.from as Record<string, unknown> : {};
        const addressNode = senderNode.emailAddress && typeof senderNode.emailAddress === "object"
          ? senderNode.emailAddress as Record<string, unknown> : {};
        const sender = String(addressNode.address || "").trim().toLowerCase();
        const domain = sender.split("@")[1] || "";
        const conversationId = String(message.conversationId || "");
        const threadLinks = conversationId
          ? await this.repository.listBusinessThreadLinks(event.teamId, event.ownerId, [conversationId])
          : [];
        const linkedCustomerId = event.linkedObjectId || threadLinks[0]?.objectId || "";
        const commonDomains = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "qq.com", "163.com", "126.com"]);
        const extractEmails = (value: string) => [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)]
          .map((match) => match[0]!.toLowerCase());
        const store = getStore();
        const manuallyLinkedCustomer = event.linkedObjectId
          ? store.customers.find((customer) => customer.id === event.linkedObjectId
            && customer.teamId === event.teamId && customer.poolStatus !== "public") || null
          : null;
        const customers = store.customers.filter((customer) =>
          customer.teamId === event.teamId && customer.ownerId === event.ownerId && customer.poolStatus !== "public"
        );
        const candidates = customers.map((customer) => {
          const emails = extractEmails(`${customer.email || ""} ${customer.documentContact || ""} ${customer.contact || ""}`);
          const domains = new Set(emails.map((email) => email.split("@")[1]).filter(Boolean));
          let score = 0;
          if (linkedCustomerId === customer.id) score += 160;
          if (sender && emails.includes(sender)) score += 120;
          if (domain && !commonDomains.has(domain) && domains.has(domain)) score += 60;
          return { customer, score };
        }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score).slice(0, 3);
        const top = candidates[0];
        const automaticallyMatchedCustomer = top && top.score >= 100 && (!candidates[1] || candidates[1].score < top.score)
          ? top.customer : null;
        const matched = manuallyLinkedCustomer || automaticallyMatchedCustomer;
        const subject = String(message.subject || "（无主题）").slice(0, 255);
        if (!matched) {
          const suggestions = candidates.map((item) => item.customer.company).join("、");
          await this.createNotification({
            recipientId: event.ownerId,
            teamId: event.teamId,
            subject: `新邮件待关联客户：${subject}`,
            content: `发件人：${sender || "未知"}${suggestions ? `；候选客户：${suggestions}` : "；当前没有明确匹配的客户"}。`,
            relatedType: "integration_event",
            relatedId: event.eventId
          });
          await this.repository.completeWebhookWriteback(event.eventId, "needs_match");
          continue;
        }
        const digest = sha256(event.eventId).slice(0, 36);
        const activityId = `ca_iwe_${digest}`.slice(0, 64);
        if (!store.customerActivities.some((activity) => activity.id === activityId)) {
          store.customerActivities.unshift({
            id: activityId,
            customerId: matched.id,
            type: "email",
            content: `收到 Microsoft 365 邮件：${subject}${sender ? `（${sender}）` : ""}`,
            operatorId: event.ownerId,
            nextReminder: "",
            createdAt: String(message.receivedDateTime || artifact.observedAt || new Date().toISOString())
          });
          await store.persist();
        }
        await this.createNotification({
          recipientId: event.ownerId,
          teamId: event.teamId,
          subject: `客户新邮件：${matched.company}`,
          content: `${sender || "客户"} 发来邮件“${subject}”，已自动写入客户跟进记录。`,
          relatedType: "integration_event",
          relatedId: event.eventId
        });
        await this.repository.completeWebhookWriteback(event.eventId, "completed", matched.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/完整性|缺少 Microsoft 邮件编号|事件类型无效/u.test(message)) {
          await this.repository.failWebhookWriteback(event.eventId, error);
        }
        // Transient database and storage failures remain pending for the next maintenance pass.
      }
    }
    return events.length;
  }

  private async workspaceBusinessCall(actor: SessionUser, callId: string) {
    const scope = resolveDataScope(actor, {}, "integration.read");
    authorize({ actor, resource: "integration.call", action: "read", requestedScope: scope });
    await this.processBusinessWritebacks();
    const call = await this.repository.getCall(callId, scope);
    if (!call) error("INTEGRATION_CALL_NOT_FOUND", "调用不存在或无权访问", 404);
    const link = await this.repository.getBusinessLinkByCall(callId, scope);
    return { call, writeback: link ? { status: link.writebackStatus, externalObjectId: link.externalObjectId, lastError: link.lastError } : null };
  }

  async microsoftBusinessCall(actor: SessionUser, callId: string) {
    return this.workspaceBusinessCall(actor, callId);
  }

  async googleBusinessCall(actor: SessionUser, callId: string) {
    return this.workspaceBusinessCall(actor, callId);
  }

  async agentToolCatalog(actor: SessionUser) {
    const scope = resolveDataScope(actor, {}, "integration.execute");
    authorize({ actor, resource: "integration.tool", action: "execute", requestedScope: scope });
    const [tools, connections] = await Promise.all([
      this.repository.listTools(scope),
      this.repository.listConnections(scope)
    ]);
    const activeConnections = new Set(connections.filter((connection) => connection.status === "active").map((connection) => connection.id));
    const granted = await Promise.all(tools.map(async (tool) => ({
      tool,
      allowed: tool.status === "active" && Boolean(tool.stableAlias) && tool.riskLevel <= 5
        && activeConnections.has(tool.connectionId) && await this.repository.hasActiveGrant(tool, actor)
    })));
    return granted.filter((item) => item.allowed).map(({ tool }) => ({
      stableAlias: tool.stableAlias,
      displayName: tool.displayName,
      description: tool.description,
      riskLevel: tool.riskLevel,
      permissionCode: tool.permissionCode,
      inputSchema: JSON.parse(tool.inputSchemaJson) as Record<string, unknown>,
      completionEvidence: Array.isArray(parsedReview(tool).completionEvidence)
        ? parsedReview(tool).completionEvidence
        : ["source", "observedAt"],
      approvalRequired: tool.riskLevel >= 4 || parsedReview(tool).approvalPolicy === "always"
    }));
  }

  private publicApproval(detail: NonNullable<Awaited<ReturnType<MysqlIntegrationControlRepository["getApprovalDetail"]>>>) {
    const input = decryptIntegrationValue<Record<string, unknown>>(detail.encryptedInput, this.credentialKey, {
      teamId: detail.approval.teamId,
      ownerId: detail.approval.ownerId,
      connectionId: detail.approval.connectionId,
      artifactType: "tool_input"
    });
    return {
      ...detail.approval,
      requestId: detail.requestId,
      callStatus: detail.callStatus,
      tool: {
        remoteName: detail.toolRemoteName,
        displayName: detail.toolDisplayName,
        stableAlias: detail.toolStableAlias,
        schemaHash: detail.toolSchemaHash
      },
      connectionName: detail.connectionDisplayName,
      inputSummary: JSON.parse(detail.inputSummaryJson || "{}") as Record<string, unknown>,
      frozenInput: safeApprovalPreview(input)
    };
  }

  async approvals(actor: SessionUser, status = "") {
    const scope = this.resolveScope(actor);
    authorize({ actor, resource: "integration.approval", action: "read", requestedScope: scope });
    const normalizedStatus = ["pending", "consumed", "rejected", "expired", "cancelled"].includes(status) ? status : "";
    const details = await this.repository.listApprovalDetails(scope, normalizedStatus);
    return details.map((detail) => this.publicApproval(detail));
  }

  async approval(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor);
    authorize({ actor, resource: "integration.approval", action: "read", requestedScope: scope });
    const detail = await this.repository.getApprovalDetail(id, scope);
    if (!detail) error("INTEGRATION_APPROVAL_NOT_FOUND", "审批不存在或无权访问", 404);
    return this.publicApproval(detail);
  }

  async approveExecution(actor: SessionUser, id: string) {
    const scope = this.resolveScope(actor, "", "integration.approval.act");
    authorize({ actor, resource: "integration.approval", action: "approve", requestedScope: scope });
    const detail = await this.repository.getApprovalDetail(id, scope);
    if (!detail) error("INTEGRATION_APPROVAL_NOT_FOUND", "审批不存在或无权访问", 404);
    const call = await this.repository.consumeApproval(id, scope, actor.id);
    if (!call) error("INTEGRATION_CALL_NOT_FOUND", "审批已消费但调用不存在", 409);
    await this.queue.enqueueToolCall(call.id);
    await this.createNotification({
      recipientId: detail.approval.ownerId,
      teamId: detail.approval.teamId,
      subject: `外部操作已批准：${detail.toolDisplayName}`,
      content: `${actor.name} 已批准冻结参数，操作已进入安全执行队列。`,
      relatedType: "integration_call",
      relatedId: call.id
    });
    return call;
  }

  async rejectExecution(actor: SessionUser, id: string, note = "") {
    const scope = this.resolveScope(actor, "", "integration.approval.act");
    authorize({ actor, resource: "integration.approval", action: "approve", requestedScope: scope });
    const detail = await this.repository.getApprovalDetail(id, scope);
    if (!detail) error("INTEGRATION_APPROVAL_NOT_FOUND", "审批不存在或无权访问", 404);
    const rejected = await this.repository.rejectApproval(id, scope, actor.id, note);
    await this.createNotification({
      recipientId: detail.approval.ownerId,
      teamId: detail.approval.teamId,
      subject: `外部操作未批准：${detail.toolDisplayName}`,
      content: note.trim() || `${actor.name} 拒绝了本次外部操作。`,
      relatedType: "integration_approval",
      relatedId: id
    });
    return rejected ? this.publicApproval(rejected) : null;
  }

  async waitForReadOnlyCall(actor: SessionUser, callId: string, timeoutMs = 30_000) {
    const scope = resolveDataScope(actor, {}, "integration.execute");
    const deadline = Date.now() + Math.max(1_000, Math.min(60_000, timeoutMs));
    while (Date.now() <= deadline) {
      const call = await this.repository.getCall(callId, scope);
      if (!call) error("INTEGRATION_CALL_NOT_FOUND", "调用不存在或无权访问", 404);
      if (call.status === "awaiting_approval") {
        return {
          callId: call.id,
          status: call.status,
          approvalId: call.approvalId,
          message: "外部操作已冻结参数，等待有权限的经理或管理员审批"
        };
      }
      if (call.status === "succeeded") {
        const artifact = await this.repository.getCallResultArtifact(callId, scope);
        if (!artifact) error("INTEGRATION_COMPLETION_EVIDENCE_MISSING", "调用成功但结果凭据不完整", 409);
        const evidence = JSON.parse(call.evidenceJson || "{}") as Record<string, unknown>;
        const writeEvidenceComplete = call.riskLevel >= 3
          && ["write_completion", "manual_reconciliation"].includes(String(evidence.type || ""))
          && Boolean(evidence.observedAt);
        if (call.riskLevel <= 2 && (!evidence.source || !evidence.observedAt)) {
          error("INTEGRATION_COMPLETION_EVIDENCE_MISSING", "外部工具缺少来源或观测时间", 409);
        }
        if (call.riskLevel >= 3 && !writeEvidenceComplete) {
          error("INTEGRATION_COMPLETION_EVIDENCE_MISSING", "外部写入缺少可验证的完成证据", 409);
        }
        return {
          callId: call.id,
          status: call.status,
          result: decryptIntegrationValue<Record<string, unknown>>(artifact.encryptedValue, this.credentialKey, {
            teamId: artifact.teamId,
            ownerId: artifact.ownerId,
            connectionId: artifact.connectionId,
            artifactType: "tool_result"
          }),
          evidence,
          externalReceipt: call.externalReceipt,
          outputSummary: JSON.parse(call.outputSummaryJson || "{}") as Record<string, unknown>
        };
      }
      if (["failed", "cancelled", "unknown_outcome", "reconciliation_required"].includes(call.status)) {
        error(call.errorCode || "INTEGRATION_REMOTE_UNAVAILABLE", call.errorMessage || `外部工具调用未完成：${call.status}`, 502);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    error("INTEGRATION_CALL_TIMEOUT", "外部工具仍在执行，未在本次 Agent 时限内返回", 504);
  }

  async testTool(actor: SessionUser, toolId: string) {
    const scope = this.resolveScope(actor, "", "integration.execute");
    authorize({ actor, resource: "integration.tool", action: "execute", requestedScope: scope });
    const tool = await this.repository.getTool(toolId, scope);
    if (!tool || tool.status !== "active" || !tool.stableAlias) {
      error("INTEGRATION_TOOL_NOT_APPROVED", "工具尚未完成审核", 409);
    }
    if (tool.riskLevel !== 0) error("INTEGRATION_PERMISSION_DENIED", "人工测试只允许 R0 无参数只读工具", 403);
    const schema = JSON.parse(tool.inputSchemaJson) as { required?: unknown[] };
    if (Array.isArray(schema.required) && schema.required.length) {
      error("INTEGRATION_INPUT_INVALID", "人工测试工具不能要求管理员填写远程参数", 409);
    }
    return this.createReadOnlyCall(actor, tool.stableAlias, {});
  }

  async calls(actor: SessionUser, requestedTeamId = "") {
    const scope = this.resolveScope(actor, requestedTeamId);
    authorize({ actor, resource: "integration.call", action: "read", requestedScope: scope });
    return this.repository.listCalls(scope);
  }

  async dailyUsage(actor: SessionUser, usageDate = new Date().toISOString().slice(0, 10)) {
    const scope = this.resolveScope(actor);
    authorize({ actor, resource: "integration.call", action: "read", requestedScope: scope });
    return this.repository.listDailyUsage(scope, usageDate);
  }

  async call(actor: SessionUser, id: string, requestedTeamId = "") {
    const scope = this.resolveScope(actor, requestedTeamId);
    authorize({ actor, resource: "integration.call", action: "read", requestedScope: scope });
    const call = await this.repository.getCall(id, scope);
    if (!call) error("INTEGRATION_CALL_NOT_FOUND", "调用不存在或无权访问", 404);
    return call;
  }

  async reconcileExecution(actor: SessionUser, id: string, input: {
    outcome: "succeeded" | "failed";
    note: string;
    externalReceipt: string;
  }) {
    const scope = this.resolveScope(actor, "", "integration.manage");
    authorize({ actor, resource: "integration.approval", action: "manage", requestedScope: scope });
    const call = await this.repository.getCall(id, scope);
    if (!call) error("INTEGRATION_CALL_NOT_FOUND", "调用不存在或无权访问", 404);
    if (!new Set(["unknown_outcome", "reconciliation_required"]).has(call.status)) {
      error("INTEGRATION_RECONCILIATION_STATE_CONFLICT", "只有结果未知的外部写入可以对账", 409);
    }
    if (input.outcome === "succeeded" && !input.externalReceipt.trim()) {
      error("INTEGRATION_COMPLETION_EVIDENCE_MISSING", "确认执行成功时必须填写外部回执编号");
    }
    if (!input.note.trim()) error("INTEGRATION_INPUT_INVALID", "请填写人工回查说明");
    const observedAt = new Date().toISOString();
    const evidence = {
      type: "manual_reconciliation",
      source: input.externalReceipt.trim() || `manual-reconciliation://${call.id}`,
      externalReceipt: input.externalReceipt.trim(),
      note: input.note.trim().slice(0, 1_000),
      reconciledBy: actor.id,
      observedAt
    };
    const output = { reconciliation: evidence, status: input.outcome };
    const outputHash = sha256(canonicalJson(output));
    const artifact = input.outcome === "succeeded" ? {
      id: `iar_${randomUUID()}`,
      encryptedValue: encryptIntegrationValue(output, this.credentialKey, {
        teamId: call.teamId,
        ownerId: call.ownerId,
        connectionId: call.connectionId,
        artifactType: "tool_result"
      }),
      contentHash: outputHash,
      keyVersion: "v1",
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString()
    } : undefined;
    const reconciled = await this.repository.reconcileCall({
      callId: call.id,
      actorId: actor.id,
      outcome: input.outcome,
      note: input.note,
      externalReceipt: input.externalReceipt.trim(),
      outputHash,
      evidence,
      artifact
    }, scope);
    await this.createNotification({
      recipientId: call.ownerId,
      teamId: call.teamId,
      subject: `外部操作已完成对账：${input.outcome === "succeeded" ? "确认成功" : "确认未执行"}`,
      content: input.note.trim(),
      relatedType: "integration_call",
      relatedId: call.id
    });
    return reconciled;
  }

  async close() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    await this.queue.close();
  }
}
