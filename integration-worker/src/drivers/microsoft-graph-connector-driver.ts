import { createHash } from "node:crypto";
import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint } from "../network-policy.js";
import { normalizeToolList } from "../mcp/tool-schema.js";
import type { DriverRuntimeContext, DriverWebhookRegistrationInput, DriverWebhookSubscription } from "./connector-driver.js";
import { OfficialApiConnectorDriver } from "./official-api-connector-driver.js";

const recipientSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: { type: "string", format: "email", maxLength: 254 }
};

const optionalRecipientSchema = {
  type: "array",
  maxItems: 50,
  items: { type: "string", format: "email", maxLength: 254 }
};

const attachmentsSchema = {
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
    title: "查看 Microsoft 365 邮箱账号",
    description: "返回当前连接授权的邮箱账号，不读取其他团队或其他用户连接。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "mail.search_messages",
    title: "搜索邮件",
    description: "在当前授权邮箱中分页搜索邮件，仅返回摘要和匹配所需字段。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 200 },
        sender: { type: "string", maxLength: 254 },
        domain: { type: "string", maxLength: 253 },
        folder: { type: "string", enum: ["inbox", "sentitems", "drafts"] },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 10000 }
      }
    }
  },
  {
    name: "mail.get_message",
    title: "查看邮件正文",
    description: "按固定 messageId 读取单封邮件，正文和参与人按长度上限返回。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["messageId"],
      properties: { messageId: { type: "string", minLength: 1, maxLength: 512 } }
    }
  },
  {
    name: "calendar.list_events",
    title: "查看日历事件",
    description: "按 UTC 时间窗口读取必要日程字段，不返回无关会议正文。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["startUtc", "endUtc"],
      properties: {
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", maxLength: 100 },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 10000 }
      }
    }
  },
  {
    name: "calendar.get_availability",
    title: "查询会议空闲时间",
    description: "查询指定邮箱在有限时间窗口内的忙闲状态，不返回会议正文。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["schedules", "startUtc", "endUtc", "timeZone"],
      properties: {
        schedules: recipientSchema,
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
        intervalMinutes: { type: "integer", minimum: 5, maximum: 1440 }
      }
    }
  },
  {
    name: "mail.create_draft",
    title: "创建邮件草稿",
    description: "在当前授权邮箱创建草稿，不发送邮件。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["to", "subject", "body"],
      properties: {
        to: recipientSchema, cc: optionalRecipientSchema,
        subject: { type: "string", minLength: 1, maxLength: 255 },
        body: { type: "string", minLength: 1, maxLength: 50000 },
        bodyType: { type: "string", enum: ["text", "html"] },
        attachments: attachmentsSchema
      }
    }
  },
  {
    name: "mail.send_message",
    title: "发送邮件",
    description: "冻结收件人、主题、正文和附件后创建并发送邮件，返回可对账 messageId。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["to", "subject", "body"],
      properties: {
        to: recipientSchema, cc: optionalRecipientSchema,
        subject: { type: "string", minLength: 1, maxLength: 255 },
        body: { type: "string", minLength: 1, maxLength: 50000 },
        bodyType: { type: "string", enum: ["text", "html"] },
        attachments: attachmentsSchema
      }
    }
  },
  {
    name: "calendar.create_event",
    title: "创建会议",
    description: "按冻结的参与人、UTC 时间、时区、主题和会议方式创建日历事件。",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["subject", "startUtc", "endUtc", "timeZone", "attendees"],
      properties: {
        subject: { type: "string", minLength: 1, maxLength: 255 },
        startUtc: { type: "string", format: "date-time" },
        endUtc: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
        attendees: recipientSchema,
        body: { type: "string", maxLength: 20000 },
        onlineMeeting: { type: "boolean" },
        location: { type: "string", maxLength: 255 }
      }
    }
  },
  {
    name: "calendar.update_event",
    title: "更新会议",
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
        attendees: optionalRecipientSchema,
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

function graphRecipients(emails: string[]) {
  return emails.map((address) => ({ emailAddress: { address } }));
}

function parseAttachments(input: Record<string, unknown>) {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attachments.length > 5) throw new Error("INTEGRATION_INPUT_INVALID: 附件数量超过限制");
  return attachments.map((item) => {
    const value = record(item);
    const contentBytes = requiredString(value, "contentBase64", 5_600_000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(contentBytes) || Buffer.from(contentBytes, "base64").byteLength > 4 * 1024 * 1024) {
      throw new Error("INTEGRATION_INPUT_INVALID: 附件内容或大小无效");
    }
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: requiredString(value, "name", 180),
      contentType: optionalString(value, "contentType", 120) || "application/octet-stream",
      contentBytes
    };
  });
}

function fixedRequestId(value = "") {
  const hex = createHash("sha256").update(value || "goodjob-integration-call").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

export class MicrosoftGraphConnectorDriver extends OfficialApiConnectorDriver {
  readonly type = "microsoft_graph";
  private readonly discoveredTools = normalizeToolList(tools, 9);

  validateConfiguration(manifest: DriverRuntimeContext["manifest"]) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["microsoft_graph"]
    });
  }

  async discoverTools(context: DriverRuntimeContext) {
    if (context.manifest.driver !== "microsoft_graph") throw new Error("INTEGRATION_CONNECTOR_INVALID: Graph Driver 配置不匹配");
    await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    return {
      protocolVersion: "official-api/1.0",
      serverName: "Microsoft Graph",
      serverVersion: "v1.0",
      capabilities: { officialApi: true, boundedPagination: true, arbitraryEndpoints: false },
      tools: this.discoveredTools
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

  private async request(
    context: DriverRuntimeContext,
    path: string,
    init: RequestInit = {}
  ): Promise<{ body: Record<string, unknown>; headers: Headers; status: number }> {
    if (!context.accessToken) throw new Error("INTEGRATION_REAUTH_REQUIRED: Microsoft 365 access token 不存在");
    const base = await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    const relative = new URL(path, "https://graph-relative.invalid");
    const url = new URL(base.origin);
    url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${relative.pathname.replace(/^\/+/, "")}`;
    url.search = relative.search;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${context.accessToken}`);
    headers.set("accept", "application/json");
    headers.set("user-agent", "GoodJob-Integration-Worker/1.0");
    if (context.requestId) {
      headers.set("client-request-id", fixedRequestId(context.requestId));
      headers.set("return-client-request-id", "true");
    }
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await createValidatedFetch(this.policy(context))(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(context.timeoutMs)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > context.maxResponseBytes) throw new Error("INTEGRATION_RESULT_TOO_LARGE: Microsoft Graph 返回结果超过限制");
    let body: Record<string, unknown> = {};
    if (bytes.length) {
      try { body = record(JSON.parse(bytes.toString("utf8"))); } catch { body = {}; }
    }
    if (!response.ok) {
      const graphError = record(body.error);
      const remoteCode = String(graphError.code || "").slice(0, 80);
      if (response.status === 401) throw new Error("INTEGRATION_REAUTH_REQUIRED: Microsoft 365 授权已失效");
      if (response.status === 412) throw new Error("INTEGRATION_VERSION_CONFLICT: 日历事件已被外部修改，请刷新后重试");
      if (response.status === 429) throw new Error("INTEGRATION_RATE_LIMITED: Microsoft Graph 请求频率受限");
      throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: Microsoft Graph 请求失败 (${response.status}${remoteCode ? `/${remoteCode}` : ""})`);
    }
    return { body, headers: response.headers, status: response.status };
  }

  private async graph(context: DriverRuntimeContext, path: string, query: URLSearchParams, init: RequestInit = {}) {
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(context, `${path}${suffix}`, init);
  }

  private subscriptionExpiration() {
    return new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString();
  }

  async registerWebhook(context: DriverRuntimeContext, input: DriverWebhookRegistrationInput): Promise<DriverWebhookSubscription> {
    const notificationUrl = new URL(input.notificationUrl);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(notificationUrl.hostname);
    if (notificationUrl.protocol !== "https:" && !(context.manifest.allowInsecureLoopback && loopback)) {
      throw new Error("INTEGRATION_WEBHOOK_URL_INVALID: Microsoft 365 Webhook 地址必须使用 HTTPS");
    }
    const response = await this.graph(context, "/subscriptions", new URLSearchParams(), {
      method: "POST",
      body: JSON.stringify({
        changeType: input.changeTypes,
        notificationUrl: input.notificationUrl,
        resource: input.resource,
        expirationDateTime: this.subscriptionExpiration(),
        clientState: input.clientState,
        latestSupportedTlsVersion: "v1_2"
      })
    });
    const id = requiredString(response.body, "id");
    const resource = requiredString(response.body, "resource") || input.resource;
    return {
      id,
      resource,
      changeTypes: String(response.body.changeType || input.changeTypes),
      expiresAt: requiredString(response.body, "expirationDateTime")
    };
  }

  async renewWebhook(context: DriverRuntimeContext, subscriptionId: string): Promise<DriverWebhookSubscription> {
    const id = encodeURIComponent(requiredString({ id: subscriptionId }, "id"));
    const response = await this.graph(context, `/subscriptions/${id}`, new URLSearchParams(), {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: this.subscriptionExpiration() })
    });
    return {
      id: requiredString(response.body, "id") || subscriptionId,
      resource: String(response.body.resource || "me/mailFolders('Inbox')/messages"),
      changeTypes: String(response.body.changeType || "created"),
      expiresAt: requiredString(response.body, "expirationDateTime")
    };
  }

  async unregisterWebhook(context: DriverRuntimeContext, subscriptionId: string): Promise<void> {
    const id = encodeURIComponent(requiredString({ id: subscriptionId }, "id"));
    try {
      await this.graph(context, `/subscriptions/${id}`, new URLSearchParams(), { method: "DELETE" });
    } catch (error) {
      // A remote subscription that already expired is already safely gone.
      if (!(error instanceof Error) || !/\(404(?:\/|\))/u.test(error.message)) throw error;
    }
  }

  private messagePayload(input: Record<string, unknown>, context: DriverRuntimeContext) {
    const to = emailList(input, "to", true);
    const cc = emailList(input, "cc");
    return {
      recipients: { to, cc },
      message: {
        subject: requiredString(input, "subject", 255),
        body: {
          contentType: optionalString(input, "bodyType", 10).toLowerCase() === "html" ? "HTML" : "Text",
          content: requiredString(input, "body", 50_000)
        },
        toRecipients: graphRecipients(to),
        ccRecipients: graphRecipients(cc),
        attachments: parseAttachments(input),
        internetMessageHeaders: [{ name: "X-GoodJob-Request-Id", value: fixedRequestId(context.requestId) }]
      }
    };
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const observedAt = new Date().toISOString();
    if (remoteName === "mail.list_accounts") {
      const response = await this.graph(context, "/me", new URLSearchParams({ "$select": "id,displayName,mail,userPrincipalName" }));
      const account = response.body;
      return result("已读取当前 Microsoft 365 邮箱账号", {
        account: { id: account.id, name: account.displayName, email: account.mail || account.userPrincipalName },
        source: "microsoft-graph://me", observedAt
      });
    }
    if (remoteName === "mail.search_messages") {
      const pageSize = integer(input, "pageSize", 25, 1, 50);
      const offset = integer(input, "offset", 0, 0, 10_000);
      const folder = optionalString(input, "folder", 20) || "inbox";
      if (!new Set(["inbox", "sentitems", "drafts"]).has(folder)) throw new Error("INTEGRATION_INPUT_INVALID: folder 无效");
      const query = new URLSearchParams({
        "$top": String(pageSize), "$skip": String(offset),
        "$select": "id,subject,receivedDateTime,sentDateTime,sender,from,toRecipients,conversationId,hasAttachments,isRead,bodyPreview,internetMessageId",
        "$orderby": "receivedDateTime desc"
      });
      const terms = [optionalString(input, "query", 200), optionalString(input, "sender", 254), optionalString(input, "domain", 253)]
        .filter(Boolean).join(" ").replace(/["\\]/gu, " ").replace(/\s+/gu, " ").trim();
      const headers: Record<string, string> = {};
      if (terms) {
        query.set("$search", `\"${terms}\"`);
        query.delete("$orderby");
        headers.ConsistencyLevel = "eventual";
      }
      const response = await this.graph(context, `/me/mailFolders/${folder}/messages`, query, { headers });
      const messages = Array.isArray(response.body.value) ? response.body.value.slice(0, pageSize).map((item) => {
        const message = record(item);
        return {
          id: message.id, subject: String(message.subject || "").slice(0, 500),
          receivedAt: message.receivedDateTime || message.sentDateTime,
          sender: message.sender || message.from, toRecipients: message.toRecipients,
          conversationId: message.conversationId, internetMessageId: message.internetMessageId,
          hasAttachments: message.hasAttachments === true, isRead: message.isRead === true,
          bodyPreview: String(message.bodyPreview || "").slice(0, 1000)
        };
      }) : [];
      return result(`已读取 ${messages.length} 封邮件摘要`, {
        messages, page: { offset, pageSize, nextOffset: messages.length === pageSize ? offset + pageSize : null },
        source: `microsoft-graph://me/${folder}/messages`, observedAt
      });
    }
    if (remoteName === "mail.get_message") {
      const messageId = encodeURIComponent(requiredString(input, "messageId"));
      const query = new URLSearchParams({ "$select": "id,subject,receivedDateTime,sentDateTime,sender,from,toRecipients,ccRecipients,replyTo,conversationId,hasAttachments,isRead,body,internetMessageId" });
      const response = await this.graph(context, `/me/messages/${messageId}`, query, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      const body = record(response.body.body);
      return result("已读取单封邮件", {
        message: { ...response.body, body: { contentType: body.contentType, content: String(body.content || "").slice(0, 50_000) } },
        source: `microsoft-graph://me/messages/${messageId}`, observedAt
      });
    }
    if (remoteName === "calendar.list_events") {
      const startUtc = utcDate(input, "startUtc");
      const endUtc = utcDate(input, "endUtc");
      if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) throw new Error("INTEGRATION_INPUT_INVALID: 日历结束时间必须晚于开始时间");
      const pageSize = integer(input, "pageSize", 25, 1, 50);
      const offset = integer(input, "offset", 0, 0, 10_000);
      const timeZone = optionalString(input, "timeZone", 100) || "UTC";
      const query = new URLSearchParams({
        startDateTime: startUtc, endDateTime: endUtc, "$top": String(pageSize), "$skip": String(offset),
        "$select": "id,subject,start,end,attendees,organizer,location,isOnlineMeeting,onlineMeeting,webLink,isCancelled,changeKey,lastModifiedDateTime",
        "$orderby": "start/dateTime"
      });
      const response = await this.graph(context, "/me/calendarView", query, { headers: { Prefer: `outlook.timezone=\"${timeZone}\"` } });
      const events = Array.isArray(response.body.value) ? response.body.value.slice(0, pageSize) : [];
      return result(`已读取 ${events.length} 个日历事件`, {
        events, page: { offset, pageSize, nextOffset: events.length === pageSize ? offset + pageSize : null },
        timeZone, source: "microsoft-graph://me/calendarView", observedAt
      });
    }
    if (remoteName === "calendar.get_availability") {
      const schedules = emailList(input, "schedules", true).slice(0, 20);
      const startUtc = utcDate(input, "startUtc");
      const endUtc = utcDate(input, "endUtc");
      if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) throw new Error("INTEGRATION_INPUT_INVALID: 空闲查询结束时间必须晚于开始时间");
      const timeZone = requiredString(input, "timeZone", 100);
      const interval = integer(input, "intervalMinutes", 30, 5, 1440);
      const response = await this.graph(context, "/me/calendar/getSchedule", new URLSearchParams(), {
        method: "POST",
        body: JSON.stringify({ schedules, startTime: { dateTime: startUtc, timeZone }, endTime: { dateTime: endUtc, timeZone }, availabilityViewInterval: interval })
      });
      const availability = Array.isArray(response.body.value) ? response.body.value.map((item) => {
        const schedule = record(item);
        return {
          scheduleId: schedule.scheduleId, availabilityView: schedule.availabilityView,
          scheduleItems: Array.isArray(schedule.scheduleItems) ? schedule.scheduleItems.map((entry) => {
            const slot = record(entry);
            return { status: slot.status, start: slot.start, end: slot.end };
          }) : []
        };
      }) : [];
      return result("已读取会议参与人的忙闲状态", {
        availability, timeZone, intervalMinutes: interval,
        source: "microsoft-graph://me/calendar/getSchedule", observedAt
      });
    }
    if (remoteName === "mail.create_draft" || remoteName === "mail.send_message") {
      const payload = this.messagePayload(input, context);
      const created = await this.graph(context, "/me/messages", new URLSearchParams(), { method: "POST", body: JSON.stringify(payload.message) });
      const messageId = requiredString(created.body, "id");
      if (remoteName === "mail.create_draft") {
        return result("邮件草稿已创建，尚未发送", {
          messageId, createdObjectId: messageId, externalReceiptId: messageId,
          isDraft: true, etag: created.body["@odata.etag"], source: `microsoft-graph://me/messages/${encodeURIComponent(messageId)}`,
          observedAt
        });
      }
      try {
        await this.graph(context, `/me/messages/${encodeURIComponent(messageId)}/send`, new URLSearchParams(), { method: "POST" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; reconciliationMessageId=${messageId}; clientRequestId=${fixedRequestId(context.requestId)}`);
      }
      return result("邮件已交给 Microsoft 365 发送", {
        messageId, externalReceiptId: messageId, deliveryAccepted: true,
        acceptedRecipients: payload.recipients.to, clientRequestId: fixedRequestId(context.requestId),
        stateTransition: "draft->send_accepted", source: `microsoft-graph://me/messages/${encodeURIComponent(messageId)}`,
        observedAt
      });
    }
    if (remoteName === "calendar.create_event") {
      const startUtc = utcDate(input, "startUtc");
      const endUtc = utcDate(input, "endUtc");
      if (new Date(endUtc).getTime() <= new Date(startUtc).getTime()) throw new Error("INTEGRATION_INPUT_INVALID: 会议结束时间必须晚于开始时间");
      const timeZone = requiredString(input, "timeZone", 100);
      const attendees = emailList(input, "attendees", true);
      const payload = {
        subject: requiredString(input, "subject", 255),
        start: { dateTime: startUtc, timeZone }, end: { dateTime: endUtc, timeZone },
        attendees: attendees.map((address) => ({ emailAddress: { address }, type: "required" })),
        body: { contentType: "Text", content: optionalString(input, "body", 20_000) },
        location: { displayName: optionalString(input, "location", 255) },
        isOnlineMeeting: input.onlineMeeting === true,
        onlineMeetingProvider: input.onlineMeeting === true ? "teamsForBusiness" : undefined,
        transactionId: fixedRequestId(context.requestId)
      };
      const created = await this.graph(context, "/me/events", new URLSearchParams(), { method: "POST", body: JSON.stringify(payload) });
      const eventId = requiredString(created.body, "id");
      const onlineMeeting = record(created.body.onlineMeeting);
      return result("Microsoft 365 会议已创建", {
        eventId, createdObjectId: eventId, externalReceiptId: eventId,
        etag: created.body["@odata.etag"] || created.body.changeKey,
        meetingLink: onlineMeeting.joinUrl || created.body.webLink || "",
        clientRequestId: fixedRequestId(context.requestId), stateTransition: "missing->created",
        source: `microsoft-graph://me/events/${encodeURIComponent(eventId)}`, observedAt
      });
    }
    if (remoteName === "calendar.update_event") {
      const eventId = requiredString(input, "eventId");
      const etag = requiredString(input, "etag");
      const timeZone = optionalString(input, "timeZone", 100) || "UTC";
      const patch: Record<string, unknown> = {};
      if (input.subject !== undefined) patch.subject = requiredString(input, "subject", 255);
      if (input.startUtc !== undefined) patch.start = { dateTime: utcDate(input, "startUtc"), timeZone };
      if (input.endUtc !== undefined) patch.end = { dateTime: utcDate(input, "endUtc"), timeZone };
      if (input.attendees !== undefined) patch.attendees = emailList(input, "attendees").map((address) => ({ emailAddress: { address }, type: "required" }));
      if (input.body !== undefined) patch.body = { contentType: "Text", content: optionalString(input, "body", 20_000) };
      if (input.location !== undefined) patch.location = { displayName: optionalString(input, "location", 255) };
      if (input.onlineMeeting !== undefined) patch.isOnlineMeeting = input.onlineMeeting === true;
      if (!Object.keys(patch).length) throw new Error("INTEGRATION_INPUT_INVALID: 至少填写一个会议变更字段");
      const updated = await this.graph(context, `/me/events/${encodeURIComponent(eventId)}`, new URLSearchParams(), {
        method: "PATCH", headers: { "if-match": etag }, body: JSON.stringify(patch)
      });
      const current = Object.keys(updated.body).length ? updated : await this.graph(context, `/me/events/${encodeURIComponent(eventId)}`, new URLSearchParams({ "$select": "id,subject,start,end,attendees,location,isOnlineMeeting,onlineMeeting,webLink,changeKey,lastModifiedDateTime" }));
      const onlineMeeting = record(current.body.onlineMeeting);
      return result("Microsoft 365 会议已更新", {
        eventId, createdObjectId: eventId, externalReceiptId: eventId,
        etag: current.body["@odata.etag"] || current.body.changeKey,
        meetingLink: onlineMeeting.joinUrl || current.body.webLink || "",
        stateTransition: "existing->updated", readAfterWriteMatch: true,
        source: `microsoft-graph://me/events/${encodeURIComponent(eventId)}`, observedAt
      });
    }
    throw new Error("INTEGRATION_TOOL_NOT_APPROVED: Microsoft Graph 工具不存在");
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    const discovery = await this.discoverTools(context);
    await this.invokeTool({ ...context, requestId: `health:${context.connectionId}` }, "mail.list_accounts", {});
    return { ok: true as const, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), discovery };
  }
}
