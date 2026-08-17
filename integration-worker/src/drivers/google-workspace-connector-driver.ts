import { createHash } from "node:crypto";
import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint } from "../network-policy.js";
import { normalizeToolList } from "../mcp/tool-schema.js";
import type { DriverRuntimeContext } from "./connector-driver.js";
import type { OAuthTransactionContext } from "../oauth/oauth-types.js";
import { OfficialApiConnectorDriver } from "./official-api-connector-driver.js";

const emailArraySchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: { type: "string", format: "email", maxLength: 254 }
};

const optionalEmailArraySchema = {
  type: "array",
  maxItems: 50,
  items: { type: "string", format: "email", maxLength: 254 }
};

const attachmentSchema = {
  type: "array",
  maxItems: 5,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "contentBase64"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 180 },
      contentType: { type: "string", maxLength: 120 },
      contentBase64: { type: "string", minLength: 1, maxLength: 5_600_000 }
    }
  }
};

const tools: Tool[] = [
  {
    name: "mail.list_accounts",
    title: "查看 Google Workspace 邮箱账号",
    description: "返回当前连接授权的 Gmail 账号，不读取其他团队或其他用户连接。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "mail.search_messages",
    title: "搜索 Gmail 邮件",
    description: "在当前授权邮箱中分页搜索邮件，仅返回摘要和客户匹配所需字段。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 200 },
        sender: { type: "string", maxLength: 254 },
        domain: { type: "string", maxLength: 253 },
        folder: { type: "string", enum: ["inbox", "sentitems", "drafts"] },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
        pageToken: { type: "string", maxLength: 1024 }
      }
    }
  },
  {
    name: "mail.get_message",
    title: "查看 Gmail 邮件正文",
    description: "按固定 messageId 读取单封邮件，正文和参与人按长度上限返回。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["messageId"],
      properties: { messageId: { type: "string", minLength: 1, maxLength: 512 } }
    }
  },
  {
    name: "calendar.list_events",
    title: "查看 Google Calendar 日程",
    description: "按 UTC 时间窗口读取主日历必要字段，不返回无关会议正文。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["startUtc", "endUtc"],
      properties: {
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", maxLength: 100 },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
        pageToken: { type: "string", maxLength: 1024 }
      }
    }
  },
  {
    name: "calendar.get_availability",
    title: "查询 Google Calendar 忙闲时间",
    description: "查询指定日历在有限时间窗口内的忙闲状态，不返回会议正文。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["schedules", "startUtc", "endUtc", "timeZone"],
      properties: {
        schedules: emailArraySchema,
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
        intervalMinutes: { type: "integer", minimum: 5, maximum: 1440 }
      }
    }
  },
  {
    name: "mail.create_draft",
    title: "创建 Gmail 草稿",
    description: "在当前授权邮箱创建草稿，不发送邮件。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["to", "subject", "body"],
      properties: {
        to: emailArraySchema, cc: optionalEmailArraySchema,
        subject: { type: "string", minLength: 1, maxLength: 255 },
        body: { type: "string", minLength: 1, maxLength: 50000 },
        bodyType: { type: "string", enum: ["text", "html"] },
        threadId: { type: "string", maxLength: 512 },
        inReplyTo: { type: "string", maxLength: 998 },
        attachments: attachmentSchema
      }
    }
  },
  {
    name: "mail.send_message",
    title: "发送 Gmail 邮件",
    description: "冻结收件人、主题、正文和附件后发送邮件，返回可对账 messageId。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["to", "subject", "body"],
      properties: {
        to: emailArraySchema, cc: optionalEmailArraySchema,
        subject: { type: "string", minLength: 1, maxLength: 255 },
        body: { type: "string", minLength: 1, maxLength: 50000 },
        bodyType: { type: "string", enum: ["text", "html"] },
        threadId: { type: "string", maxLength: 512 },
        inReplyTo: { type: "string", maxLength: 998 },
        attachments: attachmentSchema
      }
    }
  },
  {
    name: "calendar.create_event",
    title: "创建 Google Calendar 会议",
    description: "按冻结的参与人、UTC 时间、时区和主题在主日历创建会议。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["subject", "startUtc", "endUtc", "timeZone", "attendees"],
      properties: {
        subject: { type: "string", minLength: 1, maxLength: 255 },
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
        attendees: emailArraySchema,
        body: { type: "string", maxLength: 20000 },
        onlineMeeting: { type: "boolean" },
        location: { type: "string", maxLength: 255 }
      }
    }
  },
  {
    name: "calendar.update_event",
    title: "更新 Google Calendar 会议",
    description: "使用 eventId 和 etag 并发保护更新会议，防止覆盖外部新版本。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["eventId", "etag"],
      properties: {
        eventId: { type: "string", minLength: 1, maxLength: 512 },
        etag: { type: "string", minLength: 1, maxLength: 512 },
        subject: { type: "string", minLength: 1, maxLength: 255 },
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", maxLength: 100 },
        attendees: optionalEmailArraySchema,
        body: { type: "string", maxLength: 20000 },
        onlineMeeting: { type: "boolean" },
        location: { type: "string", maxLength: 255 }
      }
    }
  }
];

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(input: Record<string, unknown>, field: string, max = 512) {
  const value = String(input[field] || "").trim();
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, field: string, max = 512) {
  const value = String(input[field] || "").trim();
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  }
  return value;
}

function integer(input: Record<string, unknown>, field: string, fallback: number, min: number, max: number) {
  const value = input[field] === undefined ? fallback : Number(input[field]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 超出范围`);
  return value;
}

function emailList(input: Record<string, unknown>, field: string, required = false) {
  const values = Array.isArray(input[field]) ? input[field]!.map(String) : [];
  if ((required && !values.length) || values.length > 50
    || values.some((value) => value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))) {
    throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 邮箱列表无效`);
  }
  return [...new Set(values.map((value) => value.trim().toLowerCase()))];
}

function utcDate(input: Record<string, unknown>, field: string) {
  const value = requiredString(input, field, 64);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 时间无效`);
  return date.toISOString();
}

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string) {
  try { return Buffer.from(value, "base64url").toString("utf8"); } catch { return ""; }
}

function encodeHeader(value: string) {
  return /^[\x20-\x7e]*$/u.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function decodeHeader(value: string) {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/giu, (_match, encoded: string) => {
    try { return Buffer.from(encoded, "base64").toString("utf8"); } catch { return encoded; }
  });
}

function parseAddress(value: string) {
  const match = value.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>$/u);
  const address = String(match?.[2] || value.match(/[^\s<>,;]+@[^\s<>,;]+/u)?.[0] || "").trim().toLowerCase();
  const name = decodeHeader(String(match?.[1] || "").trim().replace(/^"|"$/gu, ""));
  return { emailAddress: { address, name: name || address } };
}

function gmailHeaders(payload: Record<string, unknown>) {
  const headers = Array.isArray(payload.headers) ? payload.headers.map(record) : [];
  return new Map(headers.map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
}

function messageBody(payload: Record<string, unknown>) {
  const found: Array<{ mimeType: string; content: string }> = [];
  const visit = (part: Record<string, unknown>) => {
    const mimeType = String(part.mimeType || "").toLowerCase();
    const body = record(part.body);
    if ((mimeType === "text/plain" || mimeType === "text/html") && body.data) {
      found.push({ mimeType, content: decodeBase64Url(String(body.data)) });
    }
    if (Array.isArray(part.parts)) part.parts.forEach((child) => visit(record(child)));
  };
  visit(payload);
  return found.find((part) => part.mimeType === "text/plain") || found[0] || { mimeType: "text/plain", content: "" };
}

function normalizeMessage(value: Record<string, unknown>, includeBody = false) {
  const payload = record(value.payload);
  const headers = gmailHeaders(payload);
  const timestamp = Number(value.internalDate || 0);
  const fallbackDate = new Date(headers.get("date") || 0);
  const receivedAt = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : Number.isNaN(fallbackDate.getTime()) ? "" : fallbackDate.toISOString();
  const labels = Array.isArray(value.labelIds) ? value.labelIds.map(String) : [];
  const sender = parseAddress(headers.get("from") || "");
  const normalized: Record<string, unknown> = {
    id: value.id,
    threadId: value.threadId,
    conversationId: value.threadId,
    subject: decodeHeader(headers.get("subject") || "(无主题)").slice(0, 500),
    receivedAt,
    sender,
    from: sender,
    toRecipients: (headers.get("to") || "").split(",").map((item) => parseAddress(item)).filter((item) => item.emailAddress.address),
    internetMessageId: headers.get("message-id") || "",
    hasAttachments: labels.includes("ATTACHMENT") || JSON.stringify(payload).includes("attachmentId"),
    isRead: !labels.includes("UNREAD"),
    bodyPreview: String(value.snippet || "").slice(0, 1000)
  };
  if (includeBody) {
    const body = messageBody(payload);
    normalized.body = { contentType: body.mimeType === "text/html" ? "html" : "text", content: body.content.slice(0, 50_000) };
  }
  return normalized;
}

function parseAttachments(input: Record<string, unknown>) {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attachments.length > 5) throw new Error("INTEGRATION_INPUT_INVALID: 附件数量超过限制");
  return attachments.map((item) => {
    const value = record(item);
    const contentBase64 = requiredString(value, "contentBase64", 5_600_000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(contentBase64) || Buffer.from(contentBase64, "base64").byteLength > 4 * 1024 * 1024) {
      throw new Error("INTEGRATION_INPUT_INVALID: 附件内容或大小无效");
    }
    return {
      name: requiredString(value, "name", 180),
      contentType: optionalString(value, "contentType", 120) || "application/octet-stream",
      contentBase64
    };
  });
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/gu)?.join("\r\n") || "";
}

function rawMessage(input: Record<string, unknown>, requestId: string) {
  const to = emailList(input, "to", true);
  const cc = emailList(input, "cc");
  const subject = requiredString(input, "subject", 255);
  const body = requiredString(input, "body", 50_000);
  const bodyType = optionalString(input, "bodyType", 10).toLowerCase() === "html" ? "text/html" : "text/plain";
  const attachments = parseAttachments(input);
  const inReplyTo = optionalString(input, "inReplyTo", 998);
  const headers = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    "MIME-Version: 1.0",
    `X-GoodJob-Request-Id: ${createHash("sha256").update(requestId || "goodjob-integration-call").digest("hex").slice(0, 32)}`
  ];
  if (!attachments.length) {
    return {
      raw: base64Url([...headers, `Content-Type: ${bodyType}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrapBase64(Buffer.from(body).toString("base64"))].join("\r\n")),
      to,
      cc
    };
  }
  const boundary = `goodjob_${createHash("sha256").update(`${requestId}:${subject}`).digest("hex").slice(0, 24)}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: ${bodyType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(body).toString("base64"))
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${encodeHeader(attachment.name)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(attachment.name)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(attachment.contentBase64)
    );
  }
  parts.push(`--${boundary}--`, "");
  return { raw: base64Url(parts.join("\r\n")), to, cc };
}

function eventReceipt(event: Record<string, unknown>, observedAt: string) {
  const conference = record(event.conferenceData);
  const entries = Array.isArray(conference.entryPoints) ? conference.entryPoints.map(record) : [];
  const meetingLink = String(event.hangoutLink || entries.find((entry) => entry.entryPointType === "video")?.uri || event.htmlLink || "");
  return {
    eventId: event.id,
    createdObjectId: event.id,
    externalReceiptId: event.id,
    etag: event.etag,
    meetingLink,
    source: `google-workspace://calendar/events/${encodeURIComponent(String(event.id || ""))}`,
    observedAt
  };
}

export function googleOfflineAuthorizationUrl(value: string) {
  const authorizationUrl = new URL(value);
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("include_granted_scopes", "true");
  authorizationUrl.searchParams.set("prompt", "consent");
  return authorizationUrl.toString();
}

export class GoogleWorkspaceConnectorDriver extends OfficialApiConnectorDriver {
  readonly type = "google_workspace";
  private readonly discoveredTools = normalizeToolList(tools, 9);

  validateConfiguration(manifest: DriverRuntimeContext["manifest"]) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["google_workspace"]
    });
  }

  async discoverTools(context: DriverRuntimeContext) {
    if (context.manifest.driver !== "google_workspace") throw new Error("INTEGRATION_CONNECTOR_INVALID: Google Workspace Driver 配置不匹配");
    await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    return {
      protocolVersion: "official-api/1.0",
      serverName: "Google Workspace",
      serverVersion: "gmail-v1/calendar-v3",
      capabilities: { officialApi: true, boundedPagination: true, arbitraryEndpoints: false },
      tools: this.discoveredTools
    };
  }

  async prepareAuthorization(manifest: DriverRuntimeContext["manifest"], context: OAuthTransactionContext, redirectUri: string) {
    const prepared = await super.prepareAuthorization(manifest, context, redirectUri);
    return {
      ...prepared,
      context: { ...prepared.context, authorizationUrl: googleOfflineAuthorizationUrl(prepared.context.authorizationUrl || "") }
    };
  }

  private policy(context: DriverRuntimeContext) {
    return {
      allowedHosts: context.manifest.approvedHosts,
      allowedPorts: context.manifest.allowedPorts,
      allowInsecureLoopback: process.env.NODE_ENV === "test" && context.manifest.allowInsecureLoopback === true,
      maxRedirects: 0
    };
  }

  private async request(context: DriverRuntimeContext, path: string, query = new URLSearchParams(), init: RequestInit = {}) {
    if (!context.accessToken) throw new Error("INTEGRATION_REAUTH_REQUIRED: Google Workspace access token 不存在");
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
    const response = await createValidatedFetch(this.policy(context))(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(context.timeoutMs)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > context.maxResponseBytes) throw new Error("INTEGRATION_RESULT_TOO_LARGE: Google Workspace 返回结果超过限制");
    let body: Record<string, unknown> = {};
    if (bytes.length) {
      try { body = record(JSON.parse(bytes.toString("utf8"))); } catch { body = {}; }
    }
    if (!response.ok) {
      const remoteError = record(body.error);
      const details = Array.isArray(remoteError.errors) ? record(remoteError.errors[0]) : {};
      const remoteCode = String(details.reason || remoteError.status || "").slice(0, 80);
      if (response.status === 401) throw new Error("INTEGRATION_REAUTH_REQUIRED: Google Workspace 授权已失效");
      if (response.status === 412) throw new Error("INTEGRATION_VERSION_CONFLICT: 日历事件已被外部修改，请刷新后重试");
      if (response.status === 429) throw new Error("INTEGRATION_RATE_LIMITED: Google Workspace 请求频率受限");
      throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: Google Workspace 请求失败 (${response.status}${remoteCode ? `/${remoteCode}` : ""})`);
    }
    return { body, headers: response.headers, status: response.status };
  }

  private async messageDetails(context: DriverRuntimeContext, ids: string[]) {
    const output: Record<string, unknown>[] = [];
    for (let offset = 0; offset < ids.length; offset += 10) {
      const batch = ids.slice(offset, offset + 10);
      const rows = await Promise.all(batch.map((id) => {
        const query = new URLSearchParams({ format: "metadata" });
        for (const header of ["From", "To", "Subject", "Date", "Message-ID"]) query.append("metadataHeaders", header);
        return this.request(context, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, query);
      }));
      output.push(...rows.map((row) => row.body));
    }
    return output;
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const observedAt = new Date().toISOString();
    if (remoteName === "mail.list_accounts") {
      const profile = await this.request(context, "/gmail/v1/users/me/profile");
      return result("已读取当前 Google Workspace 邮箱账号", {
        account: { id: profile.body.emailAddress, name: profile.body.emailAddress, email: profile.body.emailAddress },
        source: "google-workspace://gmail/users/me/profile", observedAt
      });
    }
    if (remoteName === "mail.search_messages") {
      const pageSize = integer(input, "pageSize", 25, 1, 50);
      const folder = optionalString(input, "folder", 20) || "inbox";
      const folderQuery: Record<string, string> = { inbox: "in:inbox", sentitems: "in:sent", drafts: "in:drafts" };
      if (!folderQuery[folder]) throw new Error("INTEGRATION_INPUT_INVALID: folder 无效");
      const terms = [
        folderQuery[folder],
        optionalString(input, "query", 200).replace(/[{}]/gu, " "),
        optionalString(input, "sender", 254) ? `from:${optionalString(input, "sender", 254)}` : "",
        optionalString(input, "domain", 253) ? `from:${optionalString(input, "domain", 253)}` : ""
      ].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
      const query = new URLSearchParams({ maxResults: String(pageSize), q: terms });
      const pageToken = optionalString(input, "pageToken", 1024);
      if (pageToken) query.set("pageToken", pageToken);
      const list = await this.request(context, "/gmail/v1/users/me/messages", query);
      const listed = Array.isArray(list.body.messages) ? list.body.messages.map(record).slice(0, pageSize) : [];
      const detailed = await this.messageDetails(context, listed.map((item) => requiredString(item, "id")));
      const messages = detailed.map((message) => normalizeMessage(message));
      return result(`已读取 ${messages.length} 封 Gmail 邮件摘要`, {
        messages,
        page: { pageSize, nextPageToken: list.body.nextPageToken || null, resultSizeEstimate: list.body.resultSizeEstimate || messages.length },
        source: "google-workspace://gmail/users/me/messages", observedAt
      });
    }
    if (remoteName === "mail.get_message") {
      const messageId = requiredString(input, "messageId");
      const response = await this.request(context, `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`, new URLSearchParams({ format: "full" }));
      return result("已读取单封 Gmail 邮件", {
        message: normalizeMessage(response.body, true),
        source: `google-workspace://gmail/users/me/messages/${encodeURIComponent(messageId)}`, observedAt
      });
    }
    if (remoteName === "calendar.list_events") {
      const startUtc = utcDate(input, "startUtc");
      const endUtc = utcDate(input, "endUtc");
      if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) throw new Error("INTEGRATION_INPUT_INVALID: 日历结束时间必须晚于开始时间");
      const pageSize = integer(input, "pageSize", 25, 1, 50);
      const query = new URLSearchParams({
        timeMin: startUtc, timeMax: endUtc, maxResults: String(pageSize), singleEvents: "true", orderBy: "startTime",
        timeZone: optionalString(input, "timeZone", 100) || "UTC"
      });
      const pageToken = optionalString(input, "pageToken", 1024);
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request(context, "/calendar/v3/calendars/primary/events", query);
      const events = Array.isArray(response.body.items) ? response.body.items.slice(0, pageSize).map((item) => {
        const event = record(item);
        return {
          id: event.id, subject: event.summary, start: event.start, end: event.end,
          attendees: event.attendees, organizer: event.organizer, location: event.location,
          isOnlineMeeting: Boolean(event.hangoutLink || event.conferenceData), onlineMeeting: event.conferenceData,
          webLink: event.htmlLink, isCancelled: event.status === "cancelled", etag: event.etag, updatedAt: event.updated
        };
      }) : [];
      return result(`已读取 ${events.length} 个 Google Calendar 日程`, {
        events, page: { pageSize, nextPageToken: response.body.nextPageToken || null },
        timeZone: query.get("timeZone"), source: "google-workspace://calendar/events", observedAt
      });
    }
    if (remoteName === "calendar.get_availability") {
      const schedules = emailList(input, "schedules", true).slice(0, 20);
      const startUtc = utcDate(input, "startUtc");
      const endUtc = utcDate(input, "endUtc");
      if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) throw new Error("INTEGRATION_INPUT_INVALID: 空闲查询结束时间必须晚于开始时间");
      const timeZone = requiredString(input, "timeZone", 100);
      const intervalMinutes = integer(input, "intervalMinutes", 30, 5, 1440);
      const response = await this.request(context, "/calendar/v3/freeBusy", new URLSearchParams(), {
        method: "POST",
        body: JSON.stringify({ timeMin: startUtc, timeMax: endUtc, timeZone, items: schedules.map((id) => ({ id })) })
      });
      const calendars = record(response.body.calendars);
      const availability = schedules.map((scheduleId) => {
        const calendar = record(calendars[scheduleId]);
        return { scheduleId, busy: Array.isArray(calendar.busy) ? calendar.busy.map(record) : [], errors: calendar.errors || [] };
      });
      return result("已读取 Google Calendar 忙闲状态", {
        availability, timeZone, intervalMinutes,
        source: "google-workspace://calendar/freeBusy", observedAt
      });
    }
    if (remoteName === "mail.create_draft" || remoteName === "mail.send_message") {
      const message = rawMessage(input, context.requestId || "");
      const threadId = optionalString(input, "threadId", 512);
      const payload = { message: { raw: message.raw, ...(threadId ? { threadId } : {}) } };
      const response = remoteName === "mail.create_draft"
        ? await this.request(context, "/gmail/v1/users/me/drafts", new URLSearchParams(), { method: "POST", body: JSON.stringify(payload) })
        : await this.request(context, "/gmail/v1/users/me/messages/send", new URLSearchParams(), { method: "POST", body: JSON.stringify(payload.message) });
      const responseMessage = remoteName === "mail.create_draft" ? record(response.body.message) : response.body;
      const messageId = requiredString(responseMessage, "id");
      if (remoteName === "mail.create_draft") {
        return result("Gmail 草稿已创建，尚未发送", {
          draftId: response.body.id, messageId, createdObjectId: response.body.id || messageId,
          externalReceiptId: response.body.id || messageId, isDraft: true,
          source: `google-workspace://gmail/users/me/drafts/${encodeURIComponent(String(response.body.id || ""))}`, observedAt
        });
      }
      return result("邮件已交给 Gmail 发送", {
        messageId, threadId: responseMessage.threadId, externalReceiptId: messageId,
        deliveryAccepted: true, acceptedRecipients: message.to,
        stateTransition: "message->send_accepted",
        source: `google-workspace://gmail/users/me/messages/${encodeURIComponent(messageId)}`, observedAt
      });
    }
    if (remoteName === "calendar.create_event") {
      const startUtc = utcDate(input, "startUtc");
      const endUtc = utcDate(input, "endUtc");
      if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) throw new Error("INTEGRATION_INPUT_INVALID: 会议结束时间必须晚于开始时间");
      const timeZone = requiredString(input, "timeZone", 100);
      const eventId = createHash("sha256").update(context.requestId || `${startUtc}:${endUtc}`).digest("hex").slice(0, 32);
      const payload: Record<string, unknown> = {
        id: eventId,
        summary: requiredString(input, "subject", 255),
        start: { dateTime: startUtc, timeZone },
        end: { dateTime: endUtc, timeZone },
        attendees: emailList(input, "attendees", true).map((email) => ({ email })),
        description: optionalString(input, "body", 20_000),
        location: optionalString(input, "location", 255),
        extendedProperties: { private: { goodjobRequestId: String(context.requestId || "").slice(0, 120) } }
      };
      if (input.onlineMeeting === true) {
        payload.conferenceData = { createRequest: { requestId: eventId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
      }
      let created;
      try {
        created = await this.request(context, "/calendar/v3/calendars/primary/events", new URLSearchParams({
          sendUpdates: "all", conferenceDataVersion: "1"
        }), { method: "POST", body: JSON.stringify(payload) });
      } catch (error) {
        if (!(error instanceof Error) || !/\(409(?:\/|\))/u.test(error.message)) throw error;
        created = await this.request(context, `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`);
      }
      return result("Google Calendar 会议已创建", {
        ...eventReceipt(created.body, observedAt), stateTransition: "missing->created"
      });
    }
    if (remoteName === "calendar.update_event") {
      const eventId = requiredString(input, "eventId");
      const etag = requiredString(input, "etag");
      const timeZone = optionalString(input, "timeZone", 100) || "UTC";
      const patch: Record<string, unknown> = {};
      if (input.subject !== undefined) patch.summary = requiredString(input, "subject", 255);
      if (input.startUtc !== undefined) patch.start = { dateTime: utcDate(input, "startUtc"), timeZone };
      if (input.endUtc !== undefined) patch.end = { dateTime: utcDate(input, "endUtc"), timeZone };
      if (input.attendees !== undefined) patch.attendees = emailList(input, "attendees").map((email) => ({ email }));
      if (input.body !== undefined) patch.description = optionalString(input, "body", 20_000);
      if (input.location !== undefined) patch.location = optionalString(input, "location", 255);
      if (input.onlineMeeting === true) {
        patch.conferenceData = { createRequest: { requestId: createHash("sha256").update(`${context.requestId}:meeting`).digest("hex").slice(0, 32), conferenceSolutionKey: { type: "hangoutsMeet" } } };
      }
      if (!Object.keys(patch).length) throw new Error("INTEGRATION_INPUT_INVALID: 至少填写一个会议变更字段");
      const response = await this.request(context, `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, new URLSearchParams({
        sendUpdates: "all", conferenceDataVersion: "1"
      }), { method: "PATCH", headers: { "if-match": etag }, body: JSON.stringify(patch) });
      const current = Object.keys(response.body).length
        ? response
        : await this.request(context, `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`);
      return result("Google Calendar 会议已更新", {
        ...eventReceipt(current.body, observedAt), stateTransition: "existing->updated", readAfterWriteMatch: true
      });
    }
    throw new Error("INTEGRATION_TOOL_NOT_APPROVED: Google Workspace 工具不存在");
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    const discovery = await this.discoverTools(context);
    await this.invokeTool({ ...context, requestId: `health:${context.connectionId}` }, "mail.list_accounts", {});
    return { ok: true as const, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), discovery };
  }
}
