/**
 * 对接中心路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { type SessionUser } from "../types.js";
import { getExchangeRepository } from "../exchange/exchange-repository.js";
import { getStore } from "../store.js";
import { type LeadIntake, asyncRoute, createLeadFromSource, findDuplicateLead } from "../server-core.js";

// ---------------------------------------------------------------------------
// 系统对接模块：对接方管理 + 报文收发 + 报文日志
// ---------------------------------------------------------------------------
const exchangeInboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10_000 : 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "对接接收请求过于频繁" }
});

function exchangeRepositoryOr500(res: express.Response) {
  const repository = getExchangeRepository();
  if (!repository) {
    res.status(503).json({ message: "对接模块未启用（当前存储不支持）" });
    return null;
  }
  return repository;
}

function exchangeEndpointPayload(body: unknown) {
  const schema = z.object({
    name: z.string().trim().min(1).max(120),
    direction: z.enum(["outbound", "inbound", "both"]).default("outbound"),
    baseUrl: z.string().trim().max(500).default(""),
    authType: z.enum(["none", "bearer", "header"]).default("none"),
    authName: z.string().trim().max(120).default(""),
    authSecret: z.string().max(500).default(""),
    extraHeaders: z.record(z.string().max(500)).default({}),
    description: z.string().trim().max(500).default(""),
    onReceive: z.enum(["log", "create_lead"]).default("log"),
    enabled: z.boolean().default(true)
  });
  const parsed = schema.parse(body);
  let extraHeadersJson = "{}";
  if (Object.keys(parsed.extraHeaders).length) {
    try {
      extraHeadersJson = JSON.stringify(parsed.extraHeaders);
    } catch {
      extraHeadersJson = "{}";
    }
  }
  return { ...parsed, extraHeadersJson };
}

/**
 * 对接入站报文 → 线索字段解析。容忍常见包装层（data/lead/payload/body）
 * 与中英文字段别名；公司名是唯一硬性要求，取不到则返回 null（仅记日志不建线索）。
 */
function exchangeInboundLeadFields(raw: unknown): LeadIntake | null {
  let payload = raw;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const wrapper of ["data", "lead", "payload", "body"]) {
      const inner = record[wrapper];
      if (inner && typeof inner === "object" && !Array.isArray(inner) && Object.keys(inner as object).length) {
        payload = inner;
        break;
      }
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  };
  const company = pick("company", "companyName", "company_name", "customer", "customerName", "客户公司", "公司", "公司名称");
  if (!company) return null;
  const intentRaw = pick("intent", "intentLevel", "意图", "意向").toLowerCase();
  const intent = intentRaw === "high" || intentRaw === "高" ? "高"
    : intentRaw === "low" || intentRaw === "低" ? "低" : "中";
  return {
    company: company.slice(0, 200),
    contact: pick("contact", "contactName", "contactPerson", "contact_person", "联系人", "联系人姓名").slice(0, 120),
    country: pick("country", "countryName", "country_region", "国家", "地区").slice(0, 120),
    email: pick("email", "emailAddress", "email_address", "邮箱", "电子邮件").slice(0, 200),
    phone: pick("phone", "phoneNo", "telephone", "mobile", "tel", "whatsapp", "电话", "手机").slice(0, 60),
    wechat: pick("wechat", "weChat", "微信").slice(0, 60),
    source: "对接接收",
    intent,
    stage: "新线索",
    estimatedAmount: 0,
    nextFollowAt: "",
    remark: pick("remark", "notes", "note", "备注").slice(0, 2000),
    inquiryContent: pick("inquiry", "inquiryContent", "message", "content", "demand", "requirement", "询盘内容", "需求", "需求描述", "留言").slice(0, 20000),
    sourceType: "inbound",
    sourceChannel: "exchange",
    sourceCampaign: "",
    externalId: pick("externalId", "external_id", "leadId", "id").slice(0, 180),
    sourceUrl: pick("sourceUrl", "source_url", "url", "link").slice(0, 500)
  };
}

export function registerExchangeRoutes(app: Express) {
  app.get("/api/exchange/endpoints", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    res.json({ endpoints: await repository.listEndpoints(req.user!.teamId) });
  }));

  app.post("/api/exchange/endpoints", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const input = exchangeEndpointPayload(req.body);
    const endpoint = await repository.createEndpoint({
      teamId: req.user!.teamId,
      ownerId: req.user!.id,
      name: input.name,
      direction: input.direction,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authName: input.authName,
      authSecret: input.authSecret,
      extraHeadersJson: input.extraHeadersJson,
      description: input.description,
      onReceive: input.onReceive,
      enabled: input.enabled
    });
    res.json({ endpoint });
  }));

  app.patch("/api/exchange/endpoints/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const input = exchangeEndpointPayload(req.body);
    const endpoint = await repository.updateEndpoint(req.params.id, req.user!.teamId, input);
    if (!endpoint) {
      res.status(404).json({ message: "对接方不存在或无权访问" });
      return;
    }
    res.json({ endpoint });
  }));

  app.delete("/api/exchange/endpoints/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const deleted = await repository.deleteEndpoint(req.params.id, req.user!.teamId);
    if (!deleted) {
      res.status(404).json({ message: "对接方不存在或无权访问" });
      return;
    }
    res.json({ deleted: req.params.id });
  }));

  /** 向对接方推送报文：真实发起 HTTP 请求，并把完整报文（请求/响应）落日志 */
  app.post("/api/exchange/endpoints/:id/send", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const schema = z.object({
      topic: z.string().trim().max(120).default("message"),
      method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
      payload: z.unknown()
    });
    const input = schema.parse(req.body);
    const endpoint = await repository.getEndpoint(req.params.id, req.user!.teamId);
    if (!endpoint) {
      res.status(404).json({ message: "对接方不存在或无权访问" });
      return;
    }
    if (!endpoint.enabled) {
      res.status(400).json({ message: "对接方已停用，请先启用后再发送" });
      return;
    }
    if (!endpoint.baseUrl) {
      res.status(400).json({ message: "该对接方未配置基础 URL，无法推送报文" });
      return;
    }
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = JSON.parse(endpoint.extraHeadersJson || "{}") as Record<string, string>;
    } catch {
      extraHeaders = {};
    }
    const authHeaders: Record<string, string> = endpoint.authType === "bearer"
      ? { Authorization: `Bearer ${endpoint.authSecret}` }
      : endpoint.authType === "header" && endpoint.authName
        ? { [endpoint.authName]: endpoint.authSecret }
        : {};
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "GoodJobCRM-Exchange/1.0",
      ...extraHeaders,
      ...authHeaders
    };
    const bodyText = JSON.stringify(input.payload ?? null);
    const started = Date.now();
    let status: "ok" | "failed" = "ok";
    let httpStatus: number | null = null;
    let responseHeaders = "{}";
    let responseBody = "";
    let errorMessage = "";
    try {
      const response = await fetch(endpoint.baseUrl, {
        method: input.method,
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(30_000)
      });
      httpStatus = response.status;
      responseHeaders = JSON.stringify(Object.fromEntries(response.headers.entries()));
      responseBody = (await response.text()).slice(0, 200_000);
      if (!response.ok) status = "failed";
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const message = await repository.insertMessage({
      teamId: req.user!.teamId,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      direction: "outbound",
      topic: input.topic,
      method: input.method,
      url: endpoint.baseUrl,
      requestHeadersJson: JSON.stringify(headers),
      requestBody: bodyText,
      status,
      httpStatus,
      responseHeadersJson: responseHeaders,
      responseBody,
      durationMs: Date.now() - started,
      errorMessage,
      leadId: ""
    });
    res.json({ message });
  }));

  /** 对接方推送报文给我方：公开接收端点，按 inbound_key 识别对接方，完整留痕 */
  app.post("/api/exchange/in/:inboundKey", exchangeInboundLimiter, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const endpoint = await repository.getEndpointByInboundKey(req.params.inboundKey);
    if (!endpoint) {
      res.status(404).json({ message: "对接接收地址无效" });
      return;
    }
    const topic = String(req.headers["x-exchange-topic"] || req.query.topic || "inbound").slice(0, 120);
    const requestBody = typeof req.body === "string" ? req.body.slice(0, 200_000) : JSON.stringify(req.body ?? null);

    // 线索接收闭环：对接方开启"自动建线索"后，解析报文并幂等建线索（含血缘事件）
    let leadId = "";
    let leadDuplicate = false;
    let leadNote = "";
    if (endpoint.onReceive === "create_lead") {
      const mapped = exchangeInboundLeadFields(req.body);
      if (!mapped) {
        leadNote = "报文中未识别到公司名（company 字段），已记录报文但未自动建线索";
      } else {
        const store = getStore();
        const duplicateLead = findDuplicateLead(store, endpoint.teamId, mapped.company, mapped.country);
        if (duplicateLead) {
          leadId = duplicateLead.id;
          leadDuplicate = true;
          leadNote = `线索已存在，本次报文已关联到现有线索 ${duplicateLead.id}`;
        } else {
          const owner = { id: endpoint.ownerId, teamId: endpoint.teamId } as SessionUser;
          const result = createLeadFromSource(owner, {
            ...mapped,
            source: `对接:${endpoint.name}`,
            occurredAt: new Date().toISOString(),
            rawPayload: req.body
          });
          leadId = result.lead.id;
          leadNote = `已自动创建线索 ${leadId}`;
          await store.persist();
        }
      }
    }

    const responsePayload = { ok: true, messageId: "", leadId, duplicate: leadDuplicate, note: leadNote };
    const message = await repository.insertMessage({
      teamId: endpoint.teamId,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      direction: "inbound",
      topic,
      method: req.method,
      url: req.originalUrl.split("?")[0] || "/api/exchange/in",
      requestHeadersJson: JSON.stringify(Object.fromEntries(Object.entries(req.headers as Record<string, string>).slice(0, 40))),
      requestBody,
      status: "received",
      httpStatus: 200,
      responseHeadersJson: "{}",
      responseBody: JSON.stringify(responsePayload),
      durationMs: null,
      errorMessage: "",
      leadId
    });
    res.json({ ...responsePayload, messageId: message.id });
  }));

  app.get("/api/exchange/messages", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const limit = Number(req.query.limit) || 100;
    const messages = await repository.listMessages(req.user!.teamId, {
      endpointId: String(req.query.endpointId || "") || undefined,
      direction: ["outbound", "inbound"].includes(String(req.query.direction)) ? String(req.query.direction) : undefined,
      onlyFailed: req.query.onlyFailed === "1" || req.query.onlyFailed === "true",
      limit
    });
    res.json({ messages });
  }));

  app.get("/api/exchange/messages/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = exchangeRepositoryOr500(res);
    if (!repository) return;
    const message = await repository.getMessage(req.params.id, req.user!.teamId);
    if (!message) {
      res.status(404).json({ message: "报文记录不存在或无权访问" });
      return;
    }
    res.json({ message });
  }));
}
