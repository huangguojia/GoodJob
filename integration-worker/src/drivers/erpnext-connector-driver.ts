import { validateConnectorManifest } from "@goodjob/integration-connector-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { createValidatedFetch, validateMcpEndpoint } from "../network-policy.js";
import { normalizeToolList } from "../mcp/tool-schema.js";
import type { DriverRuntimeContext } from "./connector-driver.js";
import { OfficialApiConnectorDriver } from "./official-api-connector-driver.js";

const lineItemSchema = {
  type: "array", minItems: 1, maxItems: 100,
  items: {
    type: "object", additionalProperties: false, required: ["itemCode", "qty", "rate"],
    properties: {
      itemCode: { type: "string", minLength: 1, maxLength: 140 },
      qty: { type: "number", exclusiveMinimum: 0, maximum: 1000000000 },
      rate: { type: "number", minimum: 0, maximum: 1000000000000 },
      warehouse: { type: "string", maxLength: 140 },
      deliveryDate: { type: "string", format: "date" }
    }
  }
};

const tools: Tool[] = [
  {
    name: "erp.customers.search", title: "查询 ERPNext 客户",
    description: "按客户名称分页查询当前 ERPNext 实例中的客户必要字段。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", maxLength: 140 }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 100000 }
    } }
  },
  {
    name: "erp.quotations.search", title: "查询 ERPNext 报价单",
    description: "按客户和状态分页查询报价单，用于核对 CRM 商机的报价进度。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      customer: { type: "string", maxLength: 140 }, status: { type: "string", maxLength: 80 },
      pageSize: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 100000 }
    } }
  },
  {
    name: "erp.quotations.get", title: "查看 ERPNext 报价单",
    description: "按报价单编号读取抬头、金额、币种和明细行。",
    inputSchema: { type: "object", additionalProperties: false, required: ["quotationId"], properties: {
      quotationId: { type: "string", minLength: 1, maxLength: 140 }
    } }
  },
  {
    name: "erp.quotations.create", title: "创建 ERPNext 报价单",
    description: "使用冻结的客户、有效期、币种和明细行创建报价，并写后回读确认。",
    inputSchema: { type: "object", additionalProperties: false, required: ["customer", "transactionDate", "validTill", "currency", "items"], properties: {
      customer: { type: "string", minLength: 1, maxLength: 140 }, transactionDate: { type: "string", format: "date" },
      validTill: { type: "string", format: "date" }, currency: { type: "string", pattern: "^[A-Z]{3}$" },
      orderType: { type: "string", enum: ["Sales", "Maintenance", "Shopping Cart"] }, items: lineItemSchema
    } }
  },
  {
    name: "erp.sales_orders.search", title: "查询 ERPNext 销售订单",
    description: "按客户和订单状态分页查询销售订单与履约金额。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      customer: { type: "string", maxLength: 140 }, status: { type: "string", maxLength: 80 },
      pageSize: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 100000 }
    } }
  },
  {
    name: "erp.sales_orders.get", title: "查看 ERPNext 销售订单",
    description: "按订单编号读取订单、交期、金额和明细行。",
    inputSchema: { type: "object", additionalProperties: false, required: ["salesOrderId"], properties: {
      salesOrderId: { type: "string", minLength: 1, maxLength: 140 }
    } }
  },
  {
    name: "erp.sales_orders.create", title: "创建 ERPNext 销售订单",
    description: "使用冻结的客户、交期、客户订单号和明细行创建销售订单，并写后回读确认。",
    inputSchema: { type: "object", additionalProperties: false, required: ["customer", "deliveryDate", "items"], properties: {
      customer: { type: "string", minLength: 1, maxLength: 140 }, deliveryDate: { type: "string", format: "date" },
      customerPurchaseOrder: { type: "string", maxLength: 140 }, currency: { type: "string", pattern: "^[A-Z]{3}$" }, items: lineItemSchema
    } }
  },
  {
    name: "erp.inventory.get_balance", title: "查询 ERPNext 库存",
    description: "按物料和仓库读取 ERPNext 官方库存余额。",
    inputSchema: { type: "object", additionalProperties: false, required: ["itemCode", "warehouse"], properties: {
      itemCode: { type: "string", minLength: 1, maxLength: 140 }, warehouse: { type: "string", minLength: 1, maxLength: 140 },
      postingDate: { type: "string", format: "date" }, postingTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d$" }
    } }
  },
  {
    name: "erp.invoices.search", title: "查询 ERPNext 销售发票",
    description: "按客户和状态分页查询销售发票、应收余额与到期日。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      customer: { type: "string", maxLength: 140 }, status: { type: "string", maxLength: 80 },
      pageSize: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 100000 }
    } }
  }
];

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(input: Record<string, unknown>, field: string, max = 140) {
  const value = String(input[field] || "").trim();
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  return value;
}

function optionalString(input: Record<string, unknown>, field: string, max = 140) {
  const value = String(input[field] || "").trim();
  if (value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 无效`);
  return value;
}

function integer(input: Record<string, unknown>, field: string, fallback: number, min: number, max: number) {
  const value = input[field] === undefined ? fallback : Number(input[field]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 超出范围`);
  return value;
}

function dateValue(input: Record<string, unknown>, field: string, required = true) {
  const value = required ? requiredString(input, field, 10) : optionalString(input, field, 10);
  if (value && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`INTEGRATION_INPUT_INVALID: ${field} 日期无效`);
  return value;
}

function items(input: Record<string, unknown>) {
  const values = Array.isArray(input.items) ? input.items : [];
  if (!values.length || values.length > 100) throw new Error("INTEGRATION_INPUT_INVALID: items 数量无效");
  return values.map((raw) => {
    const item = record(raw);
    const qty = Number(item.qty);
    const rate = Number(item.rate);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000_000 || !Number.isFinite(rate) || rate < 0 || rate > 1_000_000_000_000) {
      throw new Error("INTEGRATION_INPUT_INVALID: 明细数量或单价无效");
    }
    return {
      item_code: requiredString(item, "itemCode"), qty, rate,
      ...(optionalString(item, "warehouse") ? { warehouse: optionalString(item, "warehouse") } : {}),
      ...(optionalString(item, "deliveryDate", 10) ? { delivery_date: dateValue(item, "deliveryDate") } : {})
    };
  });
}

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

function filters(input: Record<string, unknown>, doctype: string) {
  const values: unknown[][] = [];
  const customer = optionalString(input, "customer");
  const status = optionalString(input, "status", 80);
  if (customer) values.push([doctype, "customer", "=", customer]);
  if (status) values.push([doctype, "status", "=", status]);
  return values;
}

export class ErpNextConnectorDriver extends OfficialApiConnectorDriver {
  readonly type = "erpnext";
  private readonly discoveredTools = normalizeToolList(tools, 9);

  validateConfiguration(manifest: DriverRuntimeContext["manifest"]) {
    validateConnectorManifest(manifest, {
      environment: process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development",
      allowedDrivers: ["erpnext"]
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
    if (context.manifest.driver !== "erpnext") throw new Error("INTEGRATION_CONNECTOR_INVALID: ERPNext Driver 配置不匹配");
    await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    return {
      protocolVersion: "official-api/1.0", serverName: "ERPNext", serverVersion: "frappe-rest-v1",
      capabilities: { officialApi: true, boundedPagination: true, arbitraryEndpoints: false }, tools: this.discoveredTools
    };
  }

  private async request(context: DriverRuntimeContext, path: string, query = new URLSearchParams(), init: RequestInit = {}) {
    const apiKey = String(context.credentials?.apiKey || "");
    const apiSecret = String(context.credentials?.apiSecret || "");
    if (!apiKey || !apiSecret) throw new Error("INTEGRATION_REAUTH_REQUIRED: ERPNext API 凭据不存在");
    const base = await validateMcpEndpoint(context.manifest.endpoint, this.policy(context));
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
    url.search = query.toString();
    const headers = new Headers(init.headers);
    headers.set("authorization", `token ${apiKey}:${apiSecret}`);
    headers.set("accept", "application/json");
    headers.set("user-agent", "GoodJob-Integration-Worker/1.0");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (context.requestId) headers.set("x-goodjob-request-id", context.requestId.slice(0, 120));
    const response = await createValidatedFetch(this.policy(context))(url, { ...init, headers, signal: AbortSignal.timeout(context.timeoutMs) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > context.maxResponseBytes) throw new Error("INTEGRATION_RESULT_TOO_LARGE: ERPNext 返回结果超过限制");
    let body: Record<string, unknown> = {};
    if (bytes.length) {
      try { body = record(JSON.parse(bytes.toString("utf8"))); } catch { body = {}; }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("INTEGRATION_REAUTH_REQUIRED: ERPNext API 凭据无效或权限不足");
      if (response.status === 409) throw new Error("INTEGRATION_VERSION_CONFLICT: ERPNext 业务对象状态已变化");
      if (response.status === 429) throw new Error("INTEGRATION_RATE_LIMITED: ERPNext 请求频率受限");
      throw new Error(`INTEGRATION_REMOTE_UNAVAILABLE: ERPNext 请求失败 (${response.status})`);
    }
    return body;
  }

  private async listResource(context: DriverRuntimeContext, doctype: string, fields: string[], filterValues: unknown[][], input: Record<string, unknown>) {
    const query = new URLSearchParams({
      fields: JSON.stringify(fields), filters: JSON.stringify(filterValues),
      limit_page_length: String(integer(input, "pageSize", 25, 1, 100)),
      limit_start: String(integer(input, "offset", 0, 0, 100_000)), order_by: "modified desc"
    });
    return this.request(context, `/api/resource/${encodeURIComponent(doctype)}`, query);
  }

  private async getResource(context: DriverRuntimeContext, doctype: string, id: string) {
    return record((await this.request(context, `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(id)}`)).data);
  }

  async invokeTool(context: DriverRuntimeContext, remoteName: string, input: Record<string, unknown>) {
    const observedAt = new Date().toISOString();
    const source = (doctype: string) => `erpnext://${doctype.toLowerCase().replaceAll(" ", "-")}`;
    if (remoteName === "erp.customers.search") {
      const queryValue = optionalString(input, "query");
      const body = await this.listResource(context, "Customer", ["name", "customer_name", "customer_group", "territory", "disabled", "modified"],
        queryValue ? [["Customer", "customer_name", "like", `%${queryValue}%`]] : [], input);
      return result("已查询 ERPNext 客户", { customers: Array.isArray(body.data) ? body.data : [], source: source("Customer"), observedAt });
    }
    if (remoteName === "erp.quotations.search") {
      const body = await this.listResource(context, "Quotation", ["name", "party_name", "customer_name", "status", "currency", "grand_total", "valid_till", "modified"], filters(input, "Quotation"), input);
      return result("已查询 ERPNext 报价单", { quotations: Array.isArray(body.data) ? body.data : [], source: source("Quotation"), observedAt });
    }
    if (remoteName === "erp.quotations.get") {
      const id = requiredString(input, "quotationId");
      return result("已读取 ERPNext 报价单", { quotation: await this.getResource(context, "Quotation", id), source: `${source("Quotation")}/${encodeURIComponent(id)}`, observedAt });
    }
    if (remoteName === "erp.sales_orders.search") {
      const body = await this.listResource(context, "Sales Order", ["name", "customer", "customer_name", "status", "currency", "grand_total", "delivery_date", "per_delivered", "per_billed", "modified"], filters(input, "Sales Order"), input);
      return result("已查询 ERPNext 销售订单", { salesOrders: Array.isArray(body.data) ? body.data : [], source: source("Sales Order"), observedAt });
    }
    if (remoteName === "erp.sales_orders.get") {
      const id = requiredString(input, "salesOrderId");
      return result("已读取 ERPNext 销售订单", { salesOrder: await this.getResource(context, "Sales Order", id), source: `${source("Sales Order")}/${encodeURIComponent(id)}`, observedAt });
    }
    if (remoteName === "erp.inventory.get_balance") {
      const query = new URLSearchParams({ item_code: requiredString(input, "itemCode"), warehouse: requiredString(input, "warehouse") });
      const postingDate = dateValue(input, "postingDate", false);
      const postingTime = optionalString(input, "postingTime", 8);
      if (postingDate) query.set("posting_date", postingDate);
      if (postingTime) query.set("posting_time", postingTime);
      const body = await this.request(context, "/api/method/erpnext.stock.utils.get_stock_balance", query);
      return result("已查询 ERPNext 库存余额", { balance: body.message, itemCode: input.itemCode, warehouse: input.warehouse, source: "erpnext://stock-balance", observedAt });
    }
    if (remoteName === "erp.invoices.search") {
      const body = await this.listResource(context, "Sales Invoice", ["name", "customer", "customer_name", "status", "currency", "grand_total", "outstanding_amount", "due_date", "modified"], filters(input, "Sales Invoice"), input);
      return result("已查询 ERPNext 销售发票", { invoices: Array.isArray(body.data) ? body.data : [], source: source("Sales Invoice"), observedAt });
    }
    if (remoteName === "erp.quotations.create" || remoteName === "erp.sales_orders.create") {
      const quotation = remoteName === "erp.quotations.create";
      const doctype = quotation ? "Quotation" : "Sales Order";
      const payload = quotation ? {
        quotation_to: "Customer", party_name: requiredString(input, "customer"),
        transaction_date: dateValue(input, "transactionDate"), valid_till: dateValue(input, "validTill"),
        currency: requiredString(input, "currency", 3), order_type: optionalString(input, "orderType", 30) || "Sales", items: items(input)
      } : {
        customer: requiredString(input, "customer"), delivery_date: dateValue(input, "deliveryDate"),
        ...(optionalString(input, "customerPurchaseOrder") ? { po_no: optionalString(input, "customerPurchaseOrder") } : {}),
        ...(optionalString(input, "currency", 3) ? { currency: requiredString(input, "currency", 3) } : {}), items: items(input)
      };
      const created = record((await this.request(context, `/api/resource/${encodeURIComponent(doctype)}`, new URLSearchParams(), { method: "POST", body: JSON.stringify(payload) })).data);
      const id = String(created.name || "");
      if (!id) throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: ERPNext 创建结果缺少单据编号");
      const verified = await this.getResource(context, doctype, id);
      return result(quotation ? "ERPNext 报价单已创建" : "ERPNext 销售订单已创建", {
        createdObjectId: id, externalReceiptId: id, readAfterWriteMatch: String(verified.name || "") === id,
        object: verified, source: `${source(doctype)}/${encodeURIComponent(id)}`, observedAt
      });
    }
    throw new Error(`INTEGRATION_TOOL_NOT_FOUND: 未知 ERPNext 工具 ${remoteName}`);
  }

  async healthCheck(context: DriverRuntimeContext) {
    const startedAt = Date.now();
    await this.request(context, "/api/method/frappe.auth.get_logged_user");
    return { ok: true as const, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), discovery: await this.discoverTools(context) };
  }
}
