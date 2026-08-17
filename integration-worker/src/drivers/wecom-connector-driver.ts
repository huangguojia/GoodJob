import { createHash } from "node:crypto";
import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint } from "../network-policy.js";
import { normalizeToolList } from "../mcp/tool-schema.js";
import type { DriverRuntimeContext } from "./connector-driver.js";
import { OfficialApiConnectorDriver } from "./official-api-connector-driver.js";

const tools: Tool[] = [
  {
    name: "wecom.departments.list", title: "查询企业微信部门",
    description: "通过企业微信官方 API 读取组织部门，可从指定部门开始查询。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      departmentId: { type: "integer", minimum: 1, maximum: 2_147_483_647 }
    } }
  },
  {
    name: "wecom.members.list", title: "查询企业微信成员",
    description: "通过企业微信官方 API 读取指定部门成员，只返回组织匹配所需字段，不返回手机号和邮箱。",
    inputSchema: { type: "object", additionalProperties: false, required: ["departmentId"], properties: {
      departmentId: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
      includeChildren: { type: "boolean" }
    } }
  },
  {
    name: "wecom.external_contacts.list", title: "查询成员的外部联系人",
    description: "按企业微信成员 UserID 读取其外部联系人编号，供 CRM 做增量匹配和去重。",
    inputSchema: { type: "object", additionalProperties: false, required: ["userId"], properties: {
      userId: { type: "string", minLength: 1, maxLength: 64 }
    } }
  },
  {
    name: "wecom.external_contacts.get", title: "查看企业微信外部联系人",
    description: "按 ExternalUserID 读取客户资料、跟进成员和标签；仅调用客户联系官方 API。",
    inputSchema: { type: "object", additionalProperties: false, required: ["externalUserId"], properties: {
      externalUserId: { type: "string", minLength: 1, maxLength: 128 },
      cursor: { type: "string", maxLength: 1_000 }
    } }
  },
  {
    name: "wecom.app_message.send_text", title: "发送企业微信应用通知",
    description: "向最多 100 名明确指定的企业成员发送文本通知；禁止全员发送，并启用企业微信重复消息检查。",
    inputSchema: { type: "object", additionalProperties: false, required: ["userIds", "content"], properties: {
      userIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 64 } },
      content: { type: "string", minLength: 1, maxLength: 1_500 }
    } }
  }
];

type TokenKind = "app" | "customer";

interface CachedToken {
  token: string;
  expiresAt: number;
  credentialFingerprint: string;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown, max = 2_000) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, max);
}

function inputString(input: Record<string, unknown>, field: string, required = false, max = 128) {
  const value = String(input[field] || "").trim();
  if ((required && !value) || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  }
  return value;
}

function inputInteger(input: Record<string, unknown>, field: string, required = false) {
  if (!required && input[field] === undefined) return 0;
  const value = Number(input[field]);
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  }
  return value;
}

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

function errorCode(body: Record<string, unknown>) {
  return Number(body.errcode || 0);
}

function assertWeComSuccess(body: Record<string, unknown>, operation: string) {
  const code = errorCode(body);
  if (!code) return;
  if ([40001, 40013, 40014, 42001, 42007, 42009].includes(code)) {
    throw new Error(`INTEGRATION_REAUTH_REQUIRED: 企业微信凭据无效或访问令牌已失效 (${code})`);
  }
  if ([48002, 50001, 60011].includes(code)) {
    throw new Error(`INTEGRATION_PERMISSION_DENIED: 企业微信未向该应用授予所需权限 (${code})`);
  }
  if ([45009, 45011].includes(code)) {
    throw new Error(`INTEGRATION_RATE_LIMITED: 企业微信请求频率受限 (${code})`);
  }
  if ([40058, 60111, 84061].includes(code)) {
    throw new Error(`INTEGRATION_REMOTE_NOT_FOUND: 企业微信未找到指定业务对象 (${code})`);
  }
  throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: 企业微信${operation}失败 (${code})`);
}

function normalizeDepartment(value: unknown) {
  const item = record(value);
  return {
    id: Number(item.id || 0),
    name: cleanString(item.name, 128),
    nameEn: cleanString(item.name_en, 128),
    parentId: Number(item.parentid || 0),
    order: Number(item.order || 0)
  };
}

function normalizeMember(value: unknown) {
  const item = record(value);
  return {
    userId: cleanString(item.userid, 64),
    name: cleanString(item.name, 128),
    alias: cleanString(item.alias, 128),
    departments: Array.isArray(item.department) ? item.department.slice(0, 100).map(Number) : [],
    departmentOrder: Array.isArray(item.order) ? item.order.slice(0, 100).map(Number) : [],
    isLeader: Array.isArray(item.is_leader_in_dept) ? item.is_leader_in_dept.slice(0, 100).map(Number) : [],
    position: cleanString(item.position, 128),
    status: Number(item.status || 0),
    mainDepartment: Number(item.main_department || 0)
  };
}

function normalizeAttribute(value: unknown) {
  const item = record(value);
  const payload = record(item.text || item.web || item.miniprogram);
  return {
    type: Number(item.type || 0),
    name: cleanString(item.name, 128),
    value: cleanString(payload.value || payload.title || payload.url || payload.pagepath, 1_000),
    url: cleanString(payload.url, 1_000)
  };
}

function normalizeExternalContact(value: unknown) {
  const item = record(value);
  const profile = record(item.external_profile);
  return {
    externalUserId: cleanString(item.external_userid, 128),
    name: cleanString(item.name, 128),
    type: Number(item.type || 0),
    gender: Number(item.gender || 0),
    position: cleanString(item.position, 128),
    corpName: cleanString(item.corp_name, 256),
    corpFullName: cleanString(item.corp_full_name, 256),
    attributes: Array.isArray(profile.external_attr) ? profile.external_attr.slice(0, 30).map(normalizeAttribute) : []
  };
}

function normalizeFollowUser(value: unknown) {
  const item = record(value);
  return {
    userId: cleanString(item.userid, 64),
    remark: cleanString(item.remark, 256),
    description: cleanString(item.description, 2_000),
    createdAt: Number(item.createtime || 0),
    addWay: Number(item.add_way || 0),
    state: cleanString(item.state, 256),
    operatorUserId: cleanString(item.oper_userid, 64),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 100).map((value) => {
      const tag = record(value);
      return {
        groupName: cleanString(tag.group_name, 128), tagName: cleanString(tag.tag_name, 128),
        tagId: cleanString(tag.tag_id, 128), type: Number(tag.type || 0)
      };
    }) : []
  };
}

export class WeComConnectorDriver extends OfficialApiConnectorDriver {
  readonly type = "wecom";
  private readonly discoveredTools = normalizeToolList(tools, 5);
  private readonly tokenCache = new Map<string, CachedToken>();

  validateConfiguration(manifest: DriverRuntimeContext["manifest"]) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["wecom"]
    });
  }

  private policy(context: DriverRuntimeContext) {
    return {
      allowedHosts: context.manifest.approvedHosts,
      allowedPorts: context.manifest.allowedPorts,
      allowInsecureLoopback: process.env.NODE_ENV === "test" && context.manifest.allowInsecureLoopback === true,
      maxRedirects: 0
    };
  }

  private credential(context: DriverRuntimeContext, key: string, max = 256) {
    const value = String(context.credentials?.[key] || "").trim();
    if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("INTEGRATION_REAUTH_REQUIRED: 企业微信连接凭据不完整");
    }
    return value;
  }

  private async apiUrl(context: DriverRuntimeContext, path: string, query = new URLSearchParams()) {
    const base = await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
    url.search = query.toString();
    return url;
  }

  private async fetchJson(context: DriverRuntimeContext, url: URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("user-agent", "GoodJob-Integration-Worker/1.0");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    const response = await createValidatedFetch(this.policy(context))(url, {
      ...init, headers, signal: AbortSignal.timeout(context.timeoutMs)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > context.maxResponseBytes) {
      throw new Error("INTEGRATION_RESULT_TOO_LARGE: 企业微信返回结果超过限制");
    }
    let body: Record<string, unknown> = {};
    if (bytes.length) {
      try { body = record(JSON.parse(bytes.toString("utf8"))); } catch { body = {}; }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("INTEGRATION_REAUTH_REQUIRED: 企业微信拒绝访问");
      if (response.status === 429) throw new Error("INTEGRATION_RATE_LIMITED: 企业微信请求频率受限");
      throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: 企业微信请求失败 (${response.status})`);
    }
    return body;
  }

  private async token(context: DriverRuntimeContext, kind: TokenKind, forceRefresh = false) {
    const corpId = this.credential(context, "corpId", 128);
    const secretKey = kind === "app" ? "appSecret" : "customerContactSecret";
    const secret = this.credential(context, secretKey);
    const fingerprint = createHash("sha256").update(`${corpId}\u0000${secret}`).digest("hex");
    const cacheKey = `${context.connectionId}:${kind}`;
    const cached = this.tokenCache.get(cacheKey);
    if (!forceRefresh && cached && cached.credentialFingerprint === fingerprint && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const query = new URLSearchParams({ corpid: corpId, corpsecret: secret });
    const body = await this.fetchJson(context, await this.apiUrl(context, "/cgi-bin/gettoken", query));
    assertWeComSuccess(body, "获取访问令牌");
    const accessToken = cleanString(body.access_token, 1_000);
    const expiresIn = Number(body.expires_in || 7_200);
    if (!accessToken || !Number.isFinite(expiresIn)) {
      throw new Error("INTEGRATION_REAUTH_REQUIRED: 企业微信未返回有效访问令牌");
    }
    this.tokenCache.set(cacheKey, {
      token: accessToken,
      expiresAt: Date.now() + Math.max(300, Math.min(expiresIn, 7_200)) * 1_000,
      credentialFingerprint: fingerprint
    });
    return accessToken;
  }

  private async request(context: DriverRuntimeContext, kind: TokenKind, path: string, query = new URLSearchParams(), init: RequestInit = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.token(context, kind, attempt > 0);
      const requestQuery = new URLSearchParams(query);
      requestQuery.set("access_token", accessToken);
      const body = await this.fetchJson(context, await this.apiUrl(context, path, requestQuery), init);
      const code = errorCode(body);
      if (attempt === 0 && [40014, 42001, 42007, 42009].includes(code)) {
        this.tokenCache.delete(`${context.connectionId}:${kind}`);
        continue;
      }
      assertWeComSuccess(body, "调用");
      return body;
    }
    throw new Error("INTEGRATION_REAUTH_REQUIRED: 企业微信访问令牌刷新失败");
  }

  async discoverTools(context: DriverRuntimeContext) {
    if (context.manifest.driver !== "wecom") throw new Error("INTEGRATION_CONNECTOR_INVALID: 企业微信 Driver 配置不匹配");
    await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    return {
      protocolVersion: "official-api/1.0", serverName: "企业微信", serverVersion: "v1",
      capabilities: {
        officialApi: true, crawling: false, arbitraryEndpoints: false,
        separatedCredentials: true, boundedRecipients: true, duplicateMessageCheck: true
      },
      tools: this.discoveredTools
    };
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const observedAt = new Date().toISOString();
    if (remoteName === "wecom.departments.list") {
      const departmentId = inputInteger(input, "departmentId");
      const query = new URLSearchParams();
      if (departmentId) query.set("id", String(departmentId));
      const body = await this.request(context, "app", "/cgi-bin/department/list", query);
      const all = Array.isArray(body.department) ? body.department : [];
      return result("已查询企业微信部门", {
        departments: all.slice(0, 5_000).map(normalizeDepartment), truncated: all.length > 5_000,
        source: "wecom://departments", observedAt
      });
    }
    if (remoteName === "wecom.members.list") {
      const departmentId = inputInteger(input, "departmentId", true);
      const query = new URLSearchParams({
        department_id: String(departmentId), fetch_child: input.includeChildren === true ? "1" : "0"
      });
      const body = await this.request(context, "app", "/cgi-bin/user/list", query);
      const all = Array.isArray(body.userlist) ? body.userlist : [];
      return result("已查询企业微信成员", {
        members: all.slice(0, 5_000).map(normalizeMember), truncated: all.length > 5_000,
        departmentId, source: `wecom://departments/${departmentId}/members`, observedAt
      });
    }
    if (remoteName === "wecom.external_contacts.list") {
      const userId = inputString(input, "userId", true, 64);
      const body = await this.request(context, "customer", "/cgi-bin/externalcontact/list", new URLSearchParams({ userid: userId }));
      const all = Array.isArray(body.external_userid) ? body.external_userid.map((value) => cleanString(value, 128)).filter(Boolean) : [];
      return result("已查询成员的企业微信外部联系人", {
        externalUserIds: all.slice(0, 10_000), truncated: all.length > 10_000,
        ownerUserId: userId, source: `wecom://members/${encodeURIComponent(userId)}/external-contacts`, observedAt
      });
    }
    if (remoteName === "wecom.external_contacts.get") {
      const externalUserId = inputString(input, "externalUserId", true, 128);
      const cursor = inputString(input, "cursor", false, 1_000);
      const query = new URLSearchParams({ external_userid: externalUserId });
      if (cursor) query.set("cursor", cursor);
      const body = await this.request(context, "customer", "/cgi-bin/externalcontact/get", query);
      return result("已读取企业微信外部联系人", {
        externalContact: normalizeExternalContact(body.external_contact),
        followUsers: Array.isArray(body.follow_user) ? body.follow_user.slice(0, 500).map(normalizeFollowUser) : [],
        nextCursor: cleanString(body.next_cursor, 1_000),
        source: `wecom://external-contacts/${encodeURIComponent(externalUserId)}`, observedAt
      });
    }
    if (remoteName === "wecom.app_message.send_text") {
      if (!Array.isArray(input.userIds) || input.userIds.length < 1 || input.userIds.length > 100) {
        throw new Error("INTEGRATION_INPUT_INVALID: userIds 必须包含 1-100 名成员");
      }
      const rawUserIds = input.userIds.map((value) => typeof value === "string" ? value.trim() : "");
      const userIds = [...new Set(rawUserIds)];
      if (userIds.length !== input.userIds.length || userIds.some((value) => !value || value.length > 64 || value === "@all" || /[|\u0000-\u001f\u007f]/u.test(value))) {
        throw new Error("INTEGRATION_INPUT_INVALID: userIds 包含重复、全员或非法成员编号");
      }
      const content = inputString(input, "content", true, 1_500);
      if (Buffer.byteLength(content, "utf8") > 2_048) {
        throw new Error("INTEGRATION_INPUT_INVALID: content 超过企业微信 2048 字节限制");
      }
      const agentId = this.credential(context, "agentId", 32);
      if (!/^\d+$/u.test(agentId)) throw new Error("INTEGRATION_REAUTH_REQUIRED: 企业微信 AgentId 格式无效");
      const body = await this.request(context, "app", "/cgi-bin/message/send", new URLSearchParams(), {
        method: "POST",
        body: JSON.stringify({
          touser: userIds.join("|"), msgtype: "text", agentid: Number(agentId), text: { content },
          safe: 0, enable_duplicate_check: 1, duplicate_check_interval: 1_800
        })
      });
      const externalReceiptId = cleanString(body.msgid || body.response_code, 500);
      if (!externalReceiptId) {
        throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: 企业微信未返回消息回执编号");
      }
      const invalidRecipients = cleanString(body.invaliduser, 7_000).split("|").filter(Boolean);
      const invalidSet = new Set(invalidRecipients);
      const acceptedRecipients = userIds.filter((userId) => !invalidSet.has(userId));
      return result("企业微信应用通知已提交", {
        messageId: externalReceiptId, externalReceiptId,
        deliveryAccepted: invalidRecipients.length === 0,
        acceptedRecipients, invalidRecipients, recipientCount: userIds.length,
        duplicateCheckSeconds: 1_800,
        source: `wecom://app-messages/${encodeURIComponent(externalReceiptId)}`, observedAt
      });
    }
    throw new Error(`INTEGRATION_TOOL_NOT_FOUND: 未知企业微信工具 ${remoteName}`);
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    const agentId = this.credential(context, "agentId", 32);
    if (!/^\d+$/u.test(agentId)) throw new Error("INTEGRATION_REAUTH_REQUIRED: 企业微信 AgentId 格式无效");
    const agent = await this.request(context, "app", "/cgi-bin/agent/get", new URLSearchParams({ agentid: agentId }));
    await this.token(context, "customer");
    return {
      ok: true as const,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      discovery: await this.discoverTools(context),
      details: { agentId: Number(agent.agentid || agentId), agentName: cleanString(agent.name, 128), customerContactCredential: "verified" }
    };
  }

  async closeConnection(connectionId: string) {
    this.tokenCache.delete(`${connectionId}:app`);
    this.tokenCache.delete(`${connectionId}:customer`);
  }
}
