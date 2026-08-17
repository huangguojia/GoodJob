import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint } from "../network-policy.js";
import { normalizeToolList } from "../mcp/tool-schema.js";
import type { DriverRuntimeContext } from "./connector-driver.js";
import { OfficialApiConnectorDriver } from "./official-api-connector-driver.js";

const tools: Tool[] = [
  {
    name: "logistics.search_trackers", title: "查询物流轨迹列表",
    description: "分页查询当前 EasyPost 账户中的运单轨迹，可按运单号与承运商精确筛选。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      trackingCode: { type: "string", maxLength: 100 }, carrier: { type: "string", maxLength: 80 },
      pageSize: { type: "integer", minimum: 1, maximum: 100 }, beforeId: { type: "string", maxLength: 100 }, afterId: { type: "string", maxLength: 100 }
    } }
  },
  {
    name: "logistics.get_tracking", title: "查看物流轨迹",
    description: "按 EasyPost Tracker 编号读取当前状态、预计送达时间与完整节点。",
    inputSchema: { type: "object", additionalProperties: false, required: ["trackerId"], properties: {
      trackerId: { type: "string", minLength: 1, maxLength: 100 }
    } }
  },
  {
    name: "logistics.create_tracking", title: "创建物流跟踪",
    description: "将冻结的运单号和承运商提交至 EasyPost，并写后回读确认，不访问或下载承运商网站。",
    inputSchema: { type: "object", additionalProperties: false, required: ["trackingCode"], properties: {
      trackingCode: { type: "string", minLength: 3, maxLength: 100 }, carrier: { type: "string", maxLength: 80 }
    } }
  }
];

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(input: Record<string, unknown>, field: string, required = false, max = 100) {
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

function normalizeTracker(raw: unknown) {
  const tracker = record(raw);
  const details = Array.isArray(tracker.tracking_details) ? tracker.tracking_details.map((entry) => {
    const item = record(entry);
    const location = record(item.tracking_location);
    return {
      status: String(item.status || ""), statusDetail: String(item.status_detail || ""),
      message: String(item.message || ""), occurredAt: String(item.datetime || ""),
      source: String(item.source || tracker.carrier || ""),
      location: [location.city, location.state, location.country, location.zip].filter(Boolean).map(String).join(", ")
    };
  }) : [];
  return {
    id: String(tracker.id || ""), trackingCode: String(tracker.tracking_code || ""),
    carrier: String(tracker.carrier || ""), status: String(tracker.status || ""),
    statusDetail: String(tracker.status_detail || ""), estimatedDeliveryDate: String(tracker.est_delivery_date || ""),
    signedBy: String(tracker.signed_by || ""), publicUrl: String(tracker.public_url || ""),
    updatedAt: String(tracker.updated_at || ""), events: details
  };
}

export class EasyPostConnectorDriver extends OfficialApiConnectorDriver {
  readonly type = "easypost";
  private readonly discoveredTools = normalizeToolList(tools, 3);

  validateConfiguration(manifest: DriverRuntimeContext["manifest"]) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["easypost"]
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

  async discoverTools(context: DriverRuntimeContext) {
    if (context.manifest.driver !== "easypost") throw new Error("INTEGRATION_CONNECTOR_INVALID: EasyPost Driver 配置不匹配");
    await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    return {
      protocolVersion: "official-api/1.0", serverName: "EasyPost Tracking", serverVersion: "v2",
      capabilities: { officialApi: true, compliantAggregator: true, crawling: false, boundedPagination: true, arbitraryEndpoints: false },
      tools: this.discoveredTools
    };
  }

  private async request(context: DriverRuntimeContext, path: string, query = new URLSearchParams(), init: RequestInit = {}) {
    const apiKey = String(context.credentials?.apiKey || "");
    if (!apiKey) throw new Error("INTEGRATION_REAUTH_REQUIRED: EasyPost API Key 不存在");
    const base = await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
    url.search = query.toString();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`);
    headers.set("accept", "application/json");
    headers.set("user-agent", "GoodJob-Integration-Worker/1.0");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (context.requestId) headers.set("x-client-request-id", context.requestId.slice(0, 120));
    const response = await createValidatedFetch(this.policy(context))(url, { ...init, headers, signal: AbortSignal.timeout(context.timeoutMs) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > context.maxResponseBytes) throw new Error("INTEGRATION_RESULT_TOO_LARGE: EasyPost 返回结果超过限制");
    let body: Record<string, unknown> = {};
    if (bytes.length) {
      try { body = record(JSON.parse(bytes.toString("utf8"))); } catch { body = {}; }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("INTEGRATION_REAUTH_REQUIRED: EasyPost API Key 无效或权限不足");
      if (response.status === 404) throw new Error("INTEGRATION_REMOTE_NOT_FOUND: EasyPost 未找到该运单轨迹");
      if (response.status === 409 || response.status === 422) throw new Error("INTEGRATION_VERSION_CONFLICT: EasyPost 运单状态或参数冲突");
      if (response.status === 429) throw new Error("INTEGRATION_RATE_LIMITED: EasyPost 请求频率受限");
      throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: EasyPost 请求失败 (${response.status})`);
    }
    return body;
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const observedAt = new Date().toISOString();
    if (remoteName === "logistics.search_trackers") {
      const query = new URLSearchParams({ page_size: String(integer(input, "pageSize", 25, 1, 100)) });
      for (const [field, parameter, max] of [["trackingCode", "tracking_code", 100], ["carrier", "carrier", 80], ["beforeId", "before_id", 100], ["afterId", "after_id", 100]] as const) {
        const value = stringValue(input, field, false, max);
        if (value) query.set(parameter, value);
      }
      const body = await this.request(context, "/trackers", query);
      const trackers = Array.isArray(body.trackers) ? body.trackers.map(normalizeTracker) : [];
      return result("已查询 EasyPost 物流轨迹", { trackers, hasMore: body.has_more === true, source: "easypost://trackers", observedAt });
    }
    if (remoteName === "logistics.get_tracking") {
      const trackerId = stringValue(input, "trackerId", true);
      const body = await this.request(context, `/trackers/${encodeURIComponent(trackerId)}`);
      return result("已读取 EasyPost 物流轨迹", { tracker: normalizeTracker(body), source: `easypost://trackers/${encodeURIComponent(trackerId)}`, observedAt });
    }
    if (remoteName === "logistics.create_tracking") {
      const trackingCode = stringValue(input, "trackingCode", true);
      const carrier = stringValue(input, "carrier", false, 80);
      const body = await this.request(context, "/trackers", new URLSearchParams(), {
        method: "POST", body: JSON.stringify({ tracker: { tracking_code: trackingCode, ...(carrier ? { carrier } : {}) } })
      });
      const created = normalizeTracker(body);
      if (!created.id) throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: EasyPost 创建结果缺少 Tracker 编号");
      const verified = normalizeTracker(await this.request(context, `/trackers/${encodeURIComponent(created.id)}`));
      return result("EasyPost 物流跟踪已创建", {
        createdObjectId: created.id, externalReceiptId: created.id,
        readAfterWriteMatch: verified.id === created.id && verified.trackingCode === trackingCode,
        stateTransition: `untracked->${verified.status || "tracking"}`, tracker: verified,
        source: `easypost://trackers/${encodeURIComponent(created.id)}`, observedAt
      });
    }
    throw new Error(`INTEGRATION_TOOL_NOT_FOUND: 未知 EasyPost 工具 ${remoteName}`);
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    await this.request(context, "/trackers", new URLSearchParams({ page_size: "1" }));
    return { ok: true as const, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), discovery: await this.discoverTools(context) };
  }
}
