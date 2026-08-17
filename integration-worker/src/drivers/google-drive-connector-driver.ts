import { createHash } from "node:crypto";
import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint } from "../network-policy.js";
import { normalizeToolList } from "../mcp/tool-schema.js";
import type { DriverRuntimeContext } from "./connector-driver.js";
import type { OAuthTransactionContext } from "../oauth/oauth-types.js";
import { googleOfflineAuthorizationUrl } from "./google-workspace-connector-driver.js";
import { OfficialApiConnectorDriver } from "./official-api-connector-driver.js";

const tools: Tool[] = [
  {
    name: "storage.list_files", title: "查询贸易单据",
    description: "分页查询由 GoodJob CRM 归档到 Google Drive 的文件，不读取无关个人文件。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", maxLength: 120 }, crmObjectType: { type: "string", enum: ["lead", "customer", "opportunity", "document", "shipment"] },
      crmObjectId: { type: "string", maxLength: 100 }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string", maxLength: 1000 }
    } }
  },
  {
    name: "storage.get_file_metadata", title: "查看单据元数据",
    description: "按 Google Drive 文件编号读取名称、类型、大小、校验值和 CRM 归属标记。",
    inputSchema: { type: "object", additionalProperties: false, required: ["fileId"], properties: {
      fileId: { type: "string", minLength: 1, maxLength: 200 }
    } }
  },
  {
    name: "storage.create_folder", title: "创建贸易单据目录",
    description: "在 Google Drive 中创建带 CRM 归属标记的目录。",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: {
      name: { type: "string", minLength: 1, maxLength: 180 }, parentFolderId: { type: "string", maxLength: 200 },
      crmObjectType: { type: "string", enum: ["lead", "customer", "opportunity", "document", "shipment"] }, crmObjectId: { type: "string", maxLength: 100 }
    } }
  },
  {
    name: "storage.upload_trade_document", title: "归档贸易单据",
    description: "将冻结的 PI、合同、箱单或报关文件上传至 Google Drive，并返回文件编号与校验值。",
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "contentType", "contentBase64", "crmObjectType", "crmObjectId"], properties: {
      name: { type: "string", minLength: 1, maxLength: 180 }, contentType: { type: "string", minLength: 1, maxLength: 120 },
      contentBase64: { type: "string", minLength: 1, maxLength: 5600000 }, parentFolderId: { type: "string", maxLength: 200 },
      crmObjectType: { type: "string", enum: ["lead", "customer", "opportunity", "document", "shipment"] }, crmObjectId: { type: "string", minLength: 1, maxLength: 100 }
    } }
  },
  {
    name: "storage.share_document", title: "共享贸易单据",
    description: "将固定文件以只读或评论权限共享给指定邮箱，并返回 Google Drive 权限回执。",
    inputSchema: { type: "object", additionalProperties: false, required: ["fileId", "email", "role"], properties: {
      fileId: { type: "string", minLength: 1, maxLength: 200 }, email: { type: "string", format: "email", maxLength: 254 },
      role: { type: "string", enum: ["reader", "commenter"] }, sendNotification: { type: "boolean" }
    } }
  }
];

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(input: Record<string, unknown>, field: string, required = false, max = 200) {
  const value = String(input[field] || "").trim();
  if ((required && !value) || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  return value;
}

function integer(input: Record<string, unknown>, field: string, fallback: number, min: number, max: number) {
  const value = input[field] === undefined ? fallback : Number(input[field]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 超出范围`);
  return value;
}

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

function driveQueryValue(value: string) {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}

function appProperties(input: Record<string, unknown>) {
  const crmObjectType = stringValue(input, "crmObjectType", false, 30);
  const crmObjectId = stringValue(input, "crmObjectId", false, 100);
  return {
    goodjobCrm: "true",
    ...(crmObjectType ? { crmObjectType } : {}),
    ...(crmObjectId ? { crmObjectId } : {})
  };
}

const metadataFields = "id,name,mimeType,size,md5Checksum,sha256Checksum,webViewLink,createdTime,modifiedTime,parents,appProperties,trashed";

export class GoogleDriveConnectorDriver extends OfficialApiConnectorDriver {
  readonly type = "google_drive";
  private readonly discoveredTools = normalizeToolList(tools, 5);

  validateConfiguration(manifest: DriverRuntimeContext["manifest"]) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["google_drive"]
    });
  }

  async prepareAuthorization(manifest: DriverRuntimeContext["manifest"], context: OAuthTransactionContext, redirectUri: string) {
    const prepared = await super.prepareAuthorization(manifest, context, redirectUri);
    return { ...prepared, context: { ...prepared.context, authorizationUrl: googleOfflineAuthorizationUrl(prepared.context.authorizationUrl || "") } };
  }

  private policy(context: DriverRuntimeContext) {
    return {
      allowedHosts: context.manifest.approvedHosts,
      allowedPorts: context.manifest.allowedPorts,
      allowInsecureLoopback: process.env.NODE_ENV === "test" && context.manifest.allowInsecureLoopback === true,
      maxRedirects: 0
    };
  }

  async discoverTools(context: DriverRuntimeContext) {
    if (context.manifest.driver !== "google_drive") throw new Error("INTEGRATION_CONNECTOR_INVALID: Google Drive Driver 配置不匹配");
    await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    return {
      protocolVersion: "official-api/1.0", serverName: "Google Drive Trade Documents", serverVersion: "drive-v3",
      capabilities: { officialApi: true, appCreatedFilesOnly: true, boundedPagination: true, arbitraryEndpoints: false }, tools: this.discoveredTools
    };
  }

  private async request(context: DriverRuntimeContext, path: string, query = new URLSearchParams(), init: RequestInit = {}) {
    if (!context.accessToken) throw new Error("INTEGRATION_REAUTH_REQUIRED: Google Drive access token 不存在");
    const base = await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    const url = new URL(base.origin);
    url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
    url.search = query.toString();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${context.accessToken}`);
    headers.set("accept", "application/json");
    headers.set("x-goog-api-client", "goodjob-crm/1.0");
    if (context.requestId) headers.set("x-goog-request-reason", `GoodJob request ${context.requestId.slice(0, 120)}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await createValidatedFetch(this.policy(context))(url, { ...init, headers, signal: AbortSignal.timeout(context.timeoutMs) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > context.maxResponseBytes) throw new Error("INTEGRATION_RESULT_TOO_LARGE: Google Drive 返回结果超过限制");
    let body: Record<string, unknown> = {};
    if (bytes.length) {
      try { body = record(JSON.parse(bytes.toString("utf8"))); } catch { body = {}; }
    }
    if (!response.ok) {
      const remoteError = record(body.error);
      const remoteCode = String(remoteError.status || "").slice(0, 80);
      if (response.status === 401) throw new Error("INTEGRATION_REAUTH_REQUIRED: Google Drive 授权已失效");
      if (response.status === 403) throw new Error("INTEGRATION_PERMISSION_DENIED: Google Drive 权限不足或配额受限");
      if (response.status === 404) throw new Error("INTEGRATION_REMOTE_NOT_FOUND: Google Drive 文件不存在或当前连接不可见");
      if (response.status === 412) throw new Error("INTEGRATION_VERSION_CONFLICT: Google Drive 文件已被外部修改");
      if (response.status === 429) throw new Error("INTEGRATION_RATE_LIMITED: Google Drive 请求频率受限");
      throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: Google Drive 请求失败 (${response.status}${remoteCode ? `/${remoteCode}` : ""})`);
    }
    return body;
  }

  private fileMetadata(context: DriverRuntimeContext, fileId: string) {
    return this.request(context, `/drive/v3/files/${encodeURIComponent(fileId)}`, new URLSearchParams({ fields: metadataFields }));
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const observedAt = new Date().toISOString();
    if (remoteName === "storage.list_files") {
      const clauses = ["trashed = false", "appProperties has { key='goodjobCrm' and value='true' }"];
      const text = stringValue(input, "query", false, 120);
      const properties = appProperties(input);
      if (text) clauses.push(`name contains '${driveQueryValue(text)}'`);
      if (properties.crmObjectType) clauses.push(`appProperties has { key='crmObjectType' and value='${driveQueryValue(properties.crmObjectType)}' }`);
      if (properties.crmObjectId) clauses.push(`appProperties has { key='crmObjectId' and value='${driveQueryValue(properties.crmObjectId)}' }`);
      const query = new URLSearchParams({
        q: clauses.join(" and "), pageSize: String(integer(input, "pageSize", 25, 1, 100)),
        fields: `nextPageToken,files(${metadataFields})`, orderBy: "modifiedTime desc", spaces: "drive"
      });
      const pageToken = stringValue(input, "pageToken", false, 1000);
      if (pageToken) query.set("pageToken", pageToken);
      const body = await this.request(context, "/drive/v3/files", query);
      return result("已查询 Google Drive 贸易单据", { files: Array.isArray(body.files) ? body.files : [], nextPageToken: body.nextPageToken || "", source: "google-drive://files", observedAt });
    }
    if (remoteName === "storage.get_file_metadata") {
      const fileId = stringValue(input, "fileId", true);
      return result("已读取 Google Drive 单据元数据", { file: await this.fileMetadata(context, fileId), source: `google-drive://files/${encodeURIComponent(fileId)}`, observedAt });
    }
    if (remoteName === "storage.create_folder") {
      const parentFolderId = stringValue(input, "parentFolderId", false);
      const metadata = {
        name: stringValue(input, "name", true, 180), mimeType: "application/vnd.google-apps.folder",
        appProperties: appProperties(input), ...(parentFolderId ? { parents: [parentFolderId] } : {})
      };
      const folder = await this.request(context, "/drive/v3/files", new URLSearchParams({ fields: metadataFields }), { method: "POST", body: JSON.stringify(metadata) });
      const id = String(folder.id || "");
      if (!id) throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: Google Drive 创建结果缺少目录编号");
      return result("Google Drive 贸易单据目录已创建", { createdObjectId: id, externalReceiptId: id, folder, source: `google-drive://files/${encodeURIComponent(id)}`, observedAt });
    }
    if (remoteName === "storage.upload_trade_document") {
      const contentBase64 = stringValue(input, "contentBase64", true, 5_600_000);
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(contentBase64)) throw new Error("INTEGRATION_INPUT_INVALID: contentBase64 格式无效");
      const content = Buffer.from(contentBase64, "base64");
      if (!content.length || content.byteLength > 4 * 1024 * 1024) throw new Error("INTEGRATION_INPUT_INVALID: 单据内容为空或超过 4MB");
      const parentFolderId = stringValue(input, "parentFolderId", false);
      const metadata = {
        name: stringValue(input, "name", true, 180), appProperties: appProperties(input),
        ...(parentFolderId ? { parents: [parentFolderId] } : {})
      };
      const contentType = stringValue(input, "contentType", true, 120);
      const boundary = `goodjob_${createHash("sha256").update(`${context.requestId || "upload"}:${metadata.name}`).digest("hex").slice(0, 24)}`;
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, "utf8"),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
      ]);
      const file = await this.request(context, "/upload/drive/v3/files", new URLSearchParams({ uploadType: "multipart", fields: metadataFields }), {
        method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: multipart as unknown as BodyInit
      });
      const fileId = String(file.id || "");
      if (!fileId) throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: Google Drive 上传结果缺少文件编号");
      const checksum = createHash("sha256").update(content).digest("hex");
      return result("贸易单据已归档到 Google Drive", {
        fileId, createdObjectId: fileId, externalReceiptId: fileId, checksum,
        file, source: `google-drive://files/${encodeURIComponent(fileId)}`, observedAt
      });
    }
    if (remoteName === "storage.share_document") {
      const fileId = stringValue(input, "fileId", true);
      const email = stringValue(input, "email", true, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error("INTEGRATION_INPUT_INVALID: email 无效");
      const role = stringValue(input, "role", true, 20);
      if (!new Set(["reader", "commenter"]).has(role)) throw new Error("INTEGRATION_INPUT_INVALID: role 无效");
      const sendNotification = input.sendNotification !== false;
      const permission = await this.request(context, `/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, new URLSearchParams({
        sendNotificationEmail: String(sendNotification), fields: "id,type,role,emailAddress"
      }), { method: "POST", body: JSON.stringify({ type: "user", role, emailAddress: email }) });
      const permissionId = String(permission.id || "");
      if (!permissionId) throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: Google Drive 共享结果缺少权限回执");
      return result("Google Drive 单据共享已创建", {
        externalReceiptId: permissionId, deliveryAccepted: sendNotification, permissionId,
        fileId, recipient: email, role, source: `google-drive://files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`, observedAt
      });
    }
    throw new Error(`INTEGRATION_TOOL_NOT_FOUND: 未知 Google Drive 工具 ${remoteName}`);
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    const about = await this.request(context, "/drive/v3/about", new URLSearchParams({ fields: "user(displayName,emailAddress),storageQuota(limit,usage)" }));
    return {
      ok: true as const, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(),
      details: { account: record(about.user).emailAddress || "" }, discovery: await this.discoverTools(context)
    };
  }
}
