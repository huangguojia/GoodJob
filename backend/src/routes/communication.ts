/**
 * 企业微信指令、企业微信、WhatsApp路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, publicUser, requireAuth, signToken } from "../auth.js";
import { callAiModel } from "../ai-model-runtime.js";
import { followupSyncPayloadSchema, runWhatsappFollowupSync } from "../whatsapp-followup-sync.js";
import { createAgentPlan } from "../ai-agent.js";
import { type Customer, type SessionUser, type WecomCommandEndpoint, type WecomMemberBinding } from "../types.js";
import { getExchangeRepository } from "../exchange/exchange-repository.js";
import { getIntegrationRepository } from "../integrations/integration-runtime.js";
import { decryptIntegrationValue, encryptIntegrationValue } from "../integrations/integration-credential-vault.js";
import { assertWeComSignature, buildWeComEncryptedReply, decryptWeComMessage, encryptWeComMessage, fastWeComCommand, looksLikeWriteCommand, parseWeComEncryptedXml, type WeComCallbackConfig } from "../wecom-command-gateway.js";
import { type CrmStore, getStore } from "../store.js";
import { isPublicCustomer } from "../customer-public-pool.js";
import { assertCrmOutreachEligible } from "../prospect-outreach-eligibility.js";
import { twilioManager, whatsappWebManager } from "../whatsapp-service.js";
import { asyncRoute, createLeadFromSource, getAiConfig, ownedCustomersFor, sendProspectQualificationError, twilioWebhookUrl } from "../server-core.js";

const weComCallbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: ["test", "e2e"].includes(process.env.NODE_ENV || "") ? 10_000 : 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "企业微信回调请求过于频繁"
});

function ensureWeComCollections(store: CrmStore) {
  store.wecomCommandEndpoints ||= [];
  store.wecomMemberBindings ||= [];
  store.wecomCommandReceipts ||= [];
  return {
    endpoints: store.wecomCommandEndpoints,
    bindings: store.wecomMemberBindings,
    receipts: store.wecomCommandReceipts
  };
}

function weComMasterKey() {
  const configured = String(process.env.INTEGRATION_CREDENTIAL_KEY || "").trim();
  if (configured.length >= 32) return configured;
  if (process.env.NODE_ENV !== "production") {
    const fallback = String(process.env.JWT_SECRET || "").trim();
    if (fallback.length >= 32) return fallback;
  }
  throw Object.assign(new Error("企业微信回调密钥未配置"), { code: "WECOM_CALLBACK_KEY_MISSING", status: 503 });
}

function weComEndpointContext(endpoint: WecomCommandEndpoint) {
  return {
    teamId: endpoint.teamId,
    ownerId: endpoint.ownerId,
    connectionId: endpoint.connectionId,
    artifactType: "wecom_command_callback"
  };
}

function decryptWeComEndpointConfig(endpoint: WecomCommandEndpoint): WeComCallbackConfig {
  const key = weComMasterKey();
  const context = weComEndpointContext(endpoint);
  return {
    corpId: endpoint.corpId,
    callbackToken: decryptIntegrationValue<string>(endpoint.callbackTokenEncrypted, key, context),
    encodingAesKey: decryptIntegrationValue<string>(endpoint.encodingAesKeyEncrypted, key, context)
  };
}

function publicWeComEndpoint(endpoint: WecomCommandEndpoint) {
  const base = String(process.env.PUBLIC_BASE_URL || process.env.INTEGRATION_OAUTH_CALLBACK_BASE_URL || "").trim().replace(/\/$/u, "");
  return {
    id: endpoint.id,
    connectionId: endpoint.connectionId,
    callbackPublicId: endpoint.callbackPublicId,
    teamId: endpoint.teamId,
    corpId: endpoint.corpId,
    status: endpoint.status,
    callbackPath: `/api/wecom/commands/${endpoint.callbackPublicId}`,
    callbackUrl: base ? `${base}/api/wecom/commands/${endpoint.callbackPublicId}` : "",
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt
  };
}

function weComTeamId(actor: SessionUser, requestedTeamId = "") {
  return actor.teamId;
}

function canManageWeComCommand(actor: SessionUser) {
  return hasIamPermission(actor, "integration.manage");
}

async function findWeComConnection(connectionId: string, teamId: string) {
  const repository = getIntegrationRepository();
  if (!repository) {
    throw Object.assign(new Error("集成平台尚未启用"), { code: "INTEGRATION_DISABLED", status: 503 });
  }
  const connection = await repository.getConnection(connectionId, { type: "team", teamId });
  if (!connection) throw Object.assign(new Error("企业微信连接不存在或不属于当前团队"), { code: "WECOM_CONNECTION_NOT_FOUND", status: 404 });
  const connector = await repository.getConnector(connection.connectorId, teamId, false);
  if (!connector || connector.code !== "wecom") {
    throw Object.assign(new Error("当前连接不是企业微信官方连接器"), { code: "WECOM_CONNECTOR_INVALID", status: 409 });
  }
  if (!["active", "degraded"].includes(connection.status)) {
    throw Object.assign(new Error("企业微信连接尚未进入可用状态"), { code: "WECOM_CONNECTION_NOT_READY", status: 409 });
  }
  return connection;
}

async function assertWeComEndpointReady(endpoint: WecomCommandEndpoint) {
  const repository = getIntegrationRepository();
  if (!repository) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("集成平台尚未启用"), { code: "INTEGRATION_DISABLED", status: 503 });
    }
    return;
  }
  const connection = await repository.getConnection(endpoint.connectionId, { type: "team", teamId: endpoint.teamId });
  if (!connection || !["active", "degraded"].includes(connection.status)) {
    throw Object.assign(new Error("企业微信连接当前不可用"), { code: "WECOM_CONNECTION_NOT_READY", status: 503 });
  }
  const connector = await repository.getConnector(connection.connectorId, endpoint.teamId, false);
  if (!connector || connector.code !== "wecom") {
    throw Object.assign(new Error("企业微信连接器校验失败"), { code: "WECOM_CONNECTOR_INVALID", status: 503 });
  }
}

function weComActorForMessage(endpoint: WecomCommandEndpoint, wecomUserId: string) {
  const store = getStore();
  const binding = store.wecomMemberBindings?.find((item) => item.connectionId === endpoint.connectionId
    && item.teamId === endpoint.teamId
    && item.wecomUserId === wecomUserId
    && item.status === "active");
  if (!binding) return null;
  const user = store.users.find((item) => item.id === binding.crmUserId
    && item.teamId === endpoint.teamId
    && item.status === "active");
  return user ? publicUser(user) : null;
}

function weComCommandResponse(text: string, config: WeComCallbackConfig, timestamp: string, nonce: string) {
  const clipped = text.trim().slice(0, 2_000) || "已收到。";
  const envelope = encryptWeComMessage(clipped, config, timestamp, nonce);
  return buildWeComEncryptedReply(envelope);
}

function weComFastReadData(actor: SessionUser) {
  const store = getStore();
  return {
    todos: store.todos
      .filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId && !item.done)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map((item) => ({ title: item.title, dueAt: item.dueAt, priority: item.priority })),
    customers: store.customers
      .filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId)
      .map((item) => ({ company: item.company, stage: item.stage, nextReminder: item.nextReminder })),
    deals: store.deals
      .filter((item) => item.ownerId === actor.id && item.teamId === actor.teamId && !["成交", "丢单"].includes(item.stage))
      .map((item) => ({ title: item.title, stage: item.stage, amount: item.amount, currency: item.currency, expectedCloseAt: item.expectedCloseAt }))
  };
}

function recordWeComReceipt(endpoint: WecomCommandEndpoint, messageKey: string, wecomUserId: string, responseText: string) {
  const store = getStore();
  const { receipts } = ensureWeComCollections(store);
  receipts.unshift({
    id: `wcr_${randomUUID()}`,
    endpointId: endpoint.id,
    connectionId: endpoint.connectionId,
    teamId: endpoint.teamId,
    messageKey,
    wecomUserId,
    responseHash: createHash("sha256").update(responseText, "utf8").digest("hex"),
    receivedAt: new Date().toISOString()
  });
  if (receipts.length > 5_000) receipts.splice(5_000);
}

function recordWeComAgentNotification(actor: SessionUser, subject: string, content: string, relatedId = "") {
  const store = getStore();
  store.internalMessages.unshift({
    id: `msg_${randomUUID()}`,
    threadId: `wecom_${actor.id}`.slice(0, 64),
    senderId: "system",
    recipientId: actor.id,
    teamId: actor.teamId,
    type: "system",
    subject,
    content: content.slice(0, 5_000),
    relatedType: "message",
    relatedId,
    readAt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  void store.persist().catch((error) => console.error("企业微信 Agent 通知持久化失败:", error));
}

// ---------------------------------------------------------------------------
// WhatsApp (阶段0:手动录入对话 + 手动翻译)。仅官方合规路径,不接非官方库。
// ---------------------------------------------------------------------------
function findWhatsAppCustomer(user: SessionUser, customerId: string) {
  const store = getStore();
  const customer = store.customers.find((item) => item.id === customerId);
  if (!customer
    || isPublicCustomer(customer)
    || customer.ownerId !== user.id) return null;
  return customer;
}

function canManageWhatsAppBinding(user: SessionUser, customer: Customer) {
  return customer.ownerId === user.id;
}

function publicWhatsAppBinding(binding: ReturnType<typeof getStore>["whatsappBindings"][number] | null) {
  if (!binding) return null;
  return {
    id: binding.id,
    customerId: binding.customerId,
    phoneNumber: binding.phoneNumber,
    waProfileName: binding.waProfileName,
    lastMessageAt: binding.lastMessageAt,
    unreadCount: binding.unreadCount,
    createdAt: binding.createdAt,
    bindingMode: binding.bindingMode,
    twilioPhoneNumber: binding.twilioPhoneNumber,
    connectionStatus: binding.connectionStatus,
    lastConnectedAt: binding.lastConnectedAt
  };
}

/** 简易中文检测:含 CJK 字符即视为中文，无需翻译。 */
function isChineseText(text: string) {
  return /[一-鿿]/.test(text);
}

async function translateToChinese(user: SessionUser, text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || isChineseText(trimmed)) return "";
  const config = getAiConfig(user);
  if (!config?.enabled || !config.apiKey) {
    // 无可用模型时返回空，前端会提示“未配置翻译模型”，不阻断录入。
    return "";
  }
  const prompt = `你是专业外贸翻译。请把下面这段客户消息翻译成简体中文，只返回译文本身，不要解释、不要引号：\n\n${trimmed}`;
  try {
    const result = await callAiModel(config, prompt, 4000);
    return result.trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

const webScanEnabled = process.env.NODE_ENV !== "production" && process.env.WHATSAPP_ENABLE_WEB_SCAN === "true";

/**
 * WhatsApp 跟进同步 · CRM 侧大脑（2026-10-15，用户拍板「结论在 CRM 做」）。
 *
 * 插件只保留会话库与触发（定时 tick / 扩展按钮），把当天消息打包 POST 过来；
 * 匹配客户、生成结论（CRM 自己配置的 AI 模型，带 `getAiConfig` 的用例无关首选）、
 * 直写跟进/线索、站内信全部在这里完成 —— 插件时代的 CLI 档不搬（CRM 的 CLI 走
 * Runner 重通道，逐会话摘要用它既慢又绕），模型不可用时降级口径与插件一致。
 * 插件用自签 owner 身份 JWT 调用（与 GET /api/customers 同一套鉴权）。
 */
/**
 * WhatsApp 插件 ↔ CRM 这条链路也走「对接中心」留痕：自动登记一个内置对接方，
 * 每次收发都落报文日志（方向 / 来源 IP / 请求响应体）。
 *
 * 铁律协调：报文日志里的**消息正文会被占位符替换**（「原文不落 CRM 库」照旧成立），
 * 结构、条数、方向、时间戳全部保留；要看正文走客户详情的「查看对话」（按需拉取）。
 */
const WHATSAPP_EXCHANGE_ENDPOINT_NAME = "WhatsApp 插件（自动登记）";

async function ensureWhatsappExchangeEndpoint(teamId: string, ownerId: string) {
  const repository = getExchangeRepository();
  if (!repository) return null;
  const existing = await repository.findEndpointByName(teamId, WHATSAPP_EXCHANGE_ENDPOINT_NAME);
  if (existing) return existing;
  return repository.createEndpoint({
    teamId,
    ownerId,
    name: WHATSAPP_EXCHANGE_ENDPOINT_NAME,
    direction: "both",
    baseUrl: process.env.WHATSAPP_PLUGIN_BASE_URL || "http://127.0.0.1:3100",
    authType: "bearer",
    authName: "",
    authSecret: "",
    extraHeadersJson: "{}",
    description: "WhatsApp 浏览器扩展插件与 CRM 的同步链路（系统自动登记）：跟进同步、对话原文按需拉取。",
    onReceive: "log",
    enabled: true
  });
}

/** 报文里出现 messages 数组就把每条 body 换成占位（保留结构；原文不落库）。 */
function redactWhatsappBodies(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWhatsappBodies);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "body" && typeof item === "string") {
      clone[key] = `【正文 ${item.length} 字 · 略】`;
    } else if (key === "authorization") {
      clone[key] = "Bearer ***";
    } else {
      clone[key] = redactWhatsappBodies(item);
    }
  }
  return clone;
}

function whatsappLogBody(value: unknown): string {
  try {
    return JSON.stringify(redactWhatsappBodies(value)).slice(0, 200_000);
  } catch {
    return String(value).slice(0, 200_000);
  }
}

/** 落报文日志：失败绝不影响主流程（打日志留痕即可）。 */
function logWhatsappExchange(input: Parameters<NonNullable<ReturnType<typeof getExchangeRepository>>["insertMessage"]>[0]) {
  const repository = getExchangeRepository();
  if (!repository) return;
  repository.insertMessage(input).catch((error) => console.error("exchange log failed:", error));
}

export function registerCommunicationRoutes(app: Express) {
  app.get("/api/wecom-command/endpoints", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageWeComCommand(req.user!)) {
      res.status(403).json({ message: "只有团队管理员可以管理企业微信指令回调" });
      return;
    }
    const teamId = weComTeamId(req.user!, String(req.query.teamId || ""));
    const { endpoints } = ensureWeComCollections(getStore());
    res.json({ endpoints: endpoints.filter((item) => item.teamId === teamId).map(publicWeComEndpoint) });
  }));

  app.post("/api/wecom-command/endpoints", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageWeComCommand(req.user!)) {
      res.status(403).json({ message: "只有团队管理员可以配置企业微信指令回调" });
      return;
    }
    const body = z.object({
      connectionId: z.string().trim().min(1).max(100),
      teamId: z.string().trim().max(64).optional().default(""),
      corpId: z.string().trim().regex(/^[A-Za-z0-9_-]{3,100}$/u),
      callbackToken: z.string().trim().min(1).max(128),
      encodingAesKey: z.string().trim().regex(/^[A-Za-z0-9]{43}$/u)
    }).strict().parse(req.body || {});
    const teamId = weComTeamId(req.user!, body.teamId);
    const connection = await findWeComConnection(body.connectionId, teamId);
    const store = getStore();
    const { endpoints } = ensureWeComCollections(store);
    const now = new Date().toISOString();
    const existing = endpoints.find((item) => item.connectionId === connection.id && item.teamId === teamId);
    const endpoint: WecomCommandEndpoint = existing || {
      id: `wce_${randomUUID()}`,
      connectionId: connection.id,
      callbackPublicId: `wcb_${randomUUID().replaceAll("-", "")}`,
      teamId,
      ownerId: connection.ownerId || req.user!.id,
      corpId: body.corpId,
      callbackTokenEncrypted: "",
      encodingAesKeyEncrypted: "",
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    const key = weComMasterKey();
    const context = weComEndpointContext({ ...endpoint, corpId: body.corpId });
    endpoint.corpId = body.corpId;
    endpoint.callbackTokenEncrypted = encryptIntegrationValue(body.callbackToken, key, context);
    endpoint.encodingAesKeyEncrypted = encryptIntegrationValue(body.encodingAesKey, key, context);
    endpoint.status = "active";
    endpoint.updatedAt = now;
    if (!existing) endpoints.unshift(endpoint);
    await store.persist();
    res.status(existing ? 200 : 201).json({ endpoint: publicWeComEndpoint(endpoint) });
  }));

  app.post("/api/wecom-command/endpoints/:id/disable", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageWeComCommand(req.user!)) {
      res.status(403).json({ message: "只有团队管理员可以停用企业微信指令回调" });
      return;
    }
    const store = getStore();
    const { endpoints } = ensureWeComCollections(store);
    const endpoint = endpoints.find((item) => item.id === req.params.id
      && item.teamId === req.user!.teamId);
    if (!endpoint) {
      res.status(404).json({ message: "企业微信指令回调不存在" });
      return;
    }
    endpoint.status = "disabled";
    endpoint.updatedAt = new Date().toISOString();
    await store.persist();
    res.json({ endpoint: publicWeComEndpoint(endpoint) });
  }));

  app.get("/api/wecom-command/bindings", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const { bindings } = ensureWeComCollections(store);
    if (!canManageWeComCommand(req.user!)) {
      res.json({ bindings: bindings.filter((item) => item.teamId === req.user!.teamId && item.crmUserId === req.user!.id).map((item) => ({
        ...item,
        crmUserName: store.users.find((user) => user.id === item.crmUserId)?.name || ""
      })) });
      return;
    }
    const teamId = weComTeamId(req.user!, String(req.query.teamId || ""));
    res.json({ bindings: bindings.filter((item) => item.teamId === teamId).map((item) => ({
      ...item,
      crmUserName: store.users.find((user) => user.id === item.crmUserId)?.name || ""
    })) });
  }));

  app.post("/api/wecom-command/bindings", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageWeComCommand(req.user!)) {
      res.status(403).json({ message: "只有团队管理员可以绑定企业微信成员" });
      return;
    }
    const body = z.object({
      connectionId: z.string().trim().min(1).max(100),
      teamId: z.string().trim().max(64).optional().default(""),
      wecomUserId: z.string().trim().min(1).max(128),
      crmUserId: z.string().trim().min(1).max(64)
    }).strict().parse(req.body || {});
    const teamId = weComTeamId(req.user!, body.teamId);
    await findWeComConnection(body.connectionId, teamId);
    const store = getStore();
    const { endpoints, bindings } = ensureWeComCollections(store);
    if (!endpoints.some((item) => item.connectionId === body.connectionId && item.teamId === teamId && item.status === "active")) {
      res.status(409).json({ message: "请先启用该企业微信连接的指令回调" });
      return;
    }
    const crmUser = store.users.find((item) => item.id === body.crmUserId && item.teamId === teamId && item.status === "active");
    if (!crmUser) {
      res.status(404).json({ message: "CRM 成员不存在或不属于当前团队" });
      return;
    }
    const conflict = bindings.find((item) => item.connectionId === body.connectionId && item.status === "active"
      && (item.wecomUserId === body.wecomUserId || item.crmUserId === body.crmUserId));
    if (conflict && (conflict.wecomUserId !== body.wecomUserId || conflict.crmUserId !== body.crmUserId)) {
      res.status(409).json({ message: "该企业微信成员或 CRM 成员已经绑定其他账号" });
      return;
    }
    const now = new Date().toISOString();
    const binding: WecomMemberBinding = conflict || bindings.find((item) => item.connectionId === body.connectionId
      && item.wecomUserId === body.wecomUserId) || {
      id: `wmb_${randomUUID()}`,
      connectionId: body.connectionId,
      teamId,
      wecomUserId: body.wecomUserId,
      crmUserId: body.crmUserId,
      status: "active",
      verifiedAt: now,
      createdAt: now,
      updatedAt: now
    };
    binding.teamId = teamId;
    binding.crmUserId = body.crmUserId;
    binding.status = "active";
    binding.verifiedAt = now;
    binding.updatedAt = now;
    if (!bindings.includes(binding)) bindings.unshift(binding);
    await store.persist();
    res.status(201).json({ binding: { ...binding, crmUserName: crmUser.name } });
  }));

  app.delete("/api/wecom-command/bindings/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageWeComCommand(req.user!)) {
      res.status(403).json({ message: "只有团队管理员可以撤销企业微信成员绑定" });
      return;
    }
    const store = getStore();
    const binding = store.wecomMemberBindings?.find((item) => item.id === req.params.id
      && item.teamId === req.user!.teamId);
    if (!binding) {
      res.status(404).json({ message: "企业微信成员绑定不存在" });
      return;
    }
    binding.status = "revoked";
    binding.updatedAt = new Date().toISOString();
    await store.persist();
    res.json({ ok: true, bindingId: binding.id });
  }));

  app.post("/api/wecom/commands/:callbackPublicId", weComCallbackLimiter, express.text({ type: ["text/xml", "application/xml"], limit: "256kb" }), async (req, res) => {
    const store = getStore();
    const { endpoints } = ensureWeComCollections(store);
    const endpoint = endpoints.find((item) => item.callbackPublicId === req.params.callbackPublicId && item.status === "active");
    if (!endpoint) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    try {
      await assertWeComEndpointReady(endpoint);
      const query = z.object({
        msg_signature: z.string().min(40).max(80),
        timestamp: z.string().regex(/^\d{1,20}$/u),
        nonce: z.string().min(1).max(128)
      }).parse(req.query);
      const config = decryptWeComEndpointConfig(endpoint);
      const rawXml = typeof req.body === "string" ? req.body : "";
      const message = parseWeComEncryptedXml(rawXml, config, query.msg_signature, query.timestamp, query.nonce);
      if (message.msgType !== "text") {
        const reply = "当前仅支持文本指令。";
        recordWeComReceipt(endpoint, message.msgId || `${message.fromUserName}:${message.createTime}`, message.fromUserName, reply);
        await store.persist();
        res.type("application/xml").send(weComCommandResponse(reply, config, query.timestamp, query.nonce));
        return;
      }
      const messageKey = message.msgId || createHash("sha256")
        .update(`${message.fromUserName}\n${message.createTime}\n${message.content}`, "utf8")
        .digest("hex");
      const duplicate = store.wecomCommandReceipts?.some((item) => item.endpointId === endpoint.id && item.messageKey === messageKey);
      if (duplicate) {
        const reply = "这条指令已经处理过了，请查看 CRM 中的结果。";
        res.type("application/xml").send(weComCommandResponse(reply, config, query.timestamp, query.nonce));
        return;
      }
      const actor = weComActorForMessage(endpoint, message.fromUserName);
      if (!actor) {
        const reply = "当前企业微信账号尚未绑定 CRM，请联系公司管理员完成绑定。";
        recordWeComReceipt(endpoint, messageKey, message.fromUserName, reply);
        await store.persist();
        res.type("application/xml").send(weComCommandResponse(reply, config, query.timestamp, query.nonce));
        return;
      }
      const readReply = fastWeComCommand(message.content, weComFastReadData(actor));
      const reply = readReply || (looksLikeWriteCommand(message.content)
        ? "已收到。系统已创建 CRM 待确认操作，不会直接修改数据或发送外部消息，请到 Agent 或审批中心确认。"
        : "已收到。当前支持：查我的待办、查我的客户、查我的商机；涉及写入、转交或外发的操作会先进入 CRM 待确认。" );
      recordWeComReceipt(endpoint, messageKey, message.fromUserName, reply);
      await store.persist();
      if (!readReply) {
        void createAgentPlan(store, actor, message.content, {
          conversationId: `wecom:${endpoint.connectionId}:${message.fromUserName}`,
          activeView: "wecom",
          automationPolicy: "approval"
        }).then((run) => {
          recordWeComAgentNotification(actor, "企业微信指令已转为 CRM 待确认操作", `${run.summary || "操作计划已生成"}\n请在 CRM Agent 页面确认后继续，运行编号：${run.id}`, run.id);
        }).catch((error) => {
          recordWeComAgentNotification(actor, "企业微信指令处理失败", "系统没有执行任何业务写入，请回到 CRM 重新发起。\n原因：" + (error instanceof Error ? error.message : "未知错误"));
        });
      }
      res.type("application/xml").send(weComCommandResponse(reply, config, query.timestamp, query.nonce));
    } catch (error) {
      const status = Number((error as { status?: number }).status || 400);
      res.status(status >= 500 ? 503 : 400).type("text/plain").send("企业微信回调校验失败");
    }
  });

  app.get("/api/wecom/commands/:callbackPublicId", weComCallbackLimiter, async (req, res) => {
    const store = getStore();
    const endpoint = store.wecomCommandEndpoints?.find((item) => item.callbackPublicId === req.params.callbackPublicId && item.status === "active");
    if (!endpoint) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    try {
      await assertWeComEndpointReady(endpoint);
      const query = z.object({
        msg_signature: z.string().min(40).max(80),
        timestamp: z.string().regex(/^\d{1,20}$/u),
        nonce: z.string().min(1).max(128),
        echostr: z.string().min(1).max(2_000)
      }).parse(req.query);
      const config = decryptWeComEndpointConfig(endpoint);
      assertWeComSignature({ token: config.callbackToken, timestamp: query.timestamp, nonce: query.nonce, encrypted: query.echostr, signature: query.msg_signature });
      res.type("text/plain").send(decryptWeComMessage(query.echostr, config.encodingAesKey, config.corpId));
    } catch (error) {
      const status = Number((error as { status?: number }).status || 400);
      res.status(status >= 500 ? 503 : 400).type("text/plain").send("企业微信回调校验失败");
    }
  });

  // 聊天中心:所有有绑定/消息的客户会话概览
  app.get("/api/whatsapp/threads", requireAuth, (req, res) => {
    const store = getStore();
    const scopedCustomerIds = new Set(
      getStore().customers.filter((c) => !isPublicCustomer(c) && c.ownerId === req.user!.id).map((c) => c.id)
    );
    const threads = store.customers
      .filter((c) => scopedCustomerIds.has(c.id))
      .map((customer) => {
        const binding = store.whatsappBindings.find((b) => b.customerId === customer.id);
        const messages = store.whatsappMessages.filter((m) => m.customerId === customer.id);
        const last = messages[messages.length - 1];
        if (!binding && messages.length === 0) return null;
        return {
          customerId: customer.id,
          company: customer.company,
          country: customer.country,
          contact: customer.contact,
          phoneNumber: binding?.phoneNumber || "",
          waProfileName: binding?.waProfileName || "",
          unreadCount: binding?.unreadCount || 0,
          lastMessage: last ? (last.content || "") : "",
          lastMessageAt: last ? last.createdAt : (binding?.lastMessageAt || ""),
          messageCount: messages.length,
          bindingMode: binding?.bindingMode || "manual",
          connectionStatus: binding?.connectionStatus || "disconnected",
          canManage: canManageWhatsAppBinding(req.user!, customer)
        };
      })
      .filter(Boolean)
      .sort((a, b) => (String((b as any).lastMessageAt) < String((a as any).lastMessageAt) ? -1 : 1));
    res.json({ threads });
  });

  // 某客户的对话记录 + 绑定信息
  app.get("/api/whatsapp/customers/:customerId/messages", requireAuth, (req, res) => {
    const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    const store = getStore();
    const binding = store.whatsappBindings.find((b) => b.customerId === customer.id) || null;
    const messages = store.whatsappMessages
      .filter((m) => m.customerId === customer.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    res.json({
      binding: publicWhatsAppBinding(binding),
      messages,
      canManage: canManageWhatsAppBinding(req.user!, customer),
      customer: { id: customer.id, company: customer.company, country: customer.country, contact: customer.contact }
    });
  });

  // 绑定/更新 WhatsApp 手机号
  app.post("/api/whatsapp/customers/:customerId/binding", requireAuth, asyncRoute(async (req, res) => {
    const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    if (!canManageWhatsAppBinding(req.user!, customer)) {
      res.status(403).json({ message: "只有客户负责人可以修改 WhatsApp 绑定" });
      return;
    }
    const schema = z.object({
      phoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "请输入包含国家码的 E.164 号码"),
      waProfileName: z.string().optional().default("")
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const now = new Date().toISOString();
    let binding = store.whatsappBindings.find((b) => b.customerId === customer.id);
    if (binding) {
      binding.phoneNumber = body.phoneNumber;
      binding.waProfileName = body.waProfileName || binding.waProfileName;
      binding.bindingMode = "manual";
      binding.connectionStatus = "disconnected";
    } else {
      binding = {
        id: `wab_${Date.now()}`,
        customerId: customer.id,
        phoneNumber: body.phoneNumber,
        waProfileName: body.waProfileName || "",
        lastMessageAt: "",
        unreadCount: 0,
        createdAt: now,
        bindingMode: "manual",
        connectionStatus: "disconnected"
      };
      store.whatsappBindings.push(binding);
    }
    customer.whatsapp = body.phoneNumber;
    await store.persist();
    res.json({ binding: publicWhatsAppBinding(binding) });
  }));

  // 手动录入一条对话(收/发),非中文自动翻译
  app.post("/api/whatsapp/customers/:customerId/messages", requireAuth, asyncRoute(async (req, res) => {
    const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    if (!canManageWhatsAppBinding(req.user!, customer)) {
      res.status(403).json({ message: "只有客户负责人可以发起 WhatsApp 绑定" });
      return;
    }
    const schema = z.object({
      direction: z.enum(["inbound", "outbound"]),
      content: z.string().min(1).max(4000),
      mediaUrl: z.string().optional().default("")
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const now = new Date().toISOString();
    const binding = store.whatsappBindings.find((b) => b.customerId === customer.id);
    let status = body.direction === "outbound" ? "recorded" : "read";
    let deliveryMode: "manual" | "web-scan" | "twilio-api" = binding?.bindingMode || "manual";
    let delivered = deliveryMode === "manual";

    if (body.direction === "outbound" && deliveryMode !== "manual") {
      try {
        await store.reloadProspectQualificationTeam?.(req.user!.teamId);
        assertCrmOutreachEligible(store, {
          target: { entityType: "customer", entity: customer },
          actorId: req.user!.id,
          channel: "whatsapp",
          recipient: binding?.phoneNumber || customer.whatsapp || ""
        });
      } catch (error) {
        if (sendProspectQualificationError(res, error)) return;
        throw error;
      }
    }

    if (body.direction === "outbound" && binding?.bindingMode === "twilio-api") {
      try {
        delivered = Boolean(binding.twilioPhoneNumber && binding.phoneNumber)
          && await twilioManager.sendMessage(binding.twilioPhoneNumber || "", binding.phoneNumber, body.content);
      } catch {
        delivered = false;
      }
      status = delivered ? "sent" : "failed";
    } else if (body.direction === "outbound" && binding?.bindingMode === "web-scan") {
      try {
        delivered = binding.connectionStatus === "connected" && Boolean(binding.sessionData && binding.phoneNumber)
          && await whatsappWebManager.sendMessage(binding.sessionData || "", binding.phoneNumber, body.content);
      } catch {
        delivered = false;
      }
      status = delivered ? "sent" : "failed";
    }

    const contentTranslated = await translateToChinese(req.user!, body.content);
    const message = {
      id: `wam_${Date.now()}`,
      customerId: customer.id,
      direction: body.direction,
      content: body.content,
      contentTranslated,
      mediaUrl: body.mediaUrl || "",
      status,
      waMessageId: "",
      createdAt: now
    };
    store.whatsappMessages.push(message);
    // 同步绑定的最近时间
    if (binding) binding.lastMessageAt = now;
    await store.persist();
    res.json({ message, delivery: { mode: deliveryMode, delivered } });
  }));

  app.post("/api/whatsapp/customers/:customerId/read", requireAuth, asyncRoute(async (req, res) => {
    const customer = findWhatsAppCustomer(req.user!, req.params.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    const binding = getStore().whatsappBindings.find((item) => item.customerId === customer.id);
    if (binding?.unreadCount) {
      binding.unreadCount = 0;
      await getStore().persist();
    }
    res.json({ ok: true });
  }));

  // 对已有消息重新翻译(用户点击“翻译”按钮)
  app.post("/api/whatsapp/messages/:id/translate", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const message = store.whatsappMessages.find((m) => m.id === req.params.id);
    if (!message) {
      res.status(404).json({ message: "消息不存在" });
      return;
    }
    const customer = findWhatsAppCustomer(req.user!, message.customerId);
    if (!customer) {
      res.status(403).json({ message: "无权访问该消息" });
      return;
    }
    if (isChineseText(message.content)) {
      res.json({ message, skipped: true, reason: "中文无需翻译" });
      return;
    }
    const translated = await translateToChinese(req.user!, message.content);
    if (!translated) {
      res.status(400).json({ message: "翻译失败，请检查是否已配置并启用 AI 模型" });
      return;
    }
    message.contentTranslated = translated;
    await store.persist();
    res.json({ message });
  }));

  // 删除一条对话记录
  app.delete("/api/whatsapp/messages/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const message = store.whatsappMessages.find((m) => m.id === req.params.id);
    if (!message) {
      res.status(404).json({ message: "消息不存在" });
      return;
    }
    const customer = findWhatsAppCustomer(req.user!, message.customerId);
    if (!customer) {
      res.status(403).json({ message: "无权访问该消息" });
      return;
    }
    store.whatsappMessages = store.whatsappMessages.filter((m) => m.id !== message.id);
    await store.persist();
    res.json({ ok: true, id: message.id });
  }));

  // 获取可用的绑定模式
  app.get("/api/whatsapp/binding-modes", requireAuth, (req, res) => {
    const modes = {
      webScan: { available: webScanEnabled, name: "测试扫码", risk: "仅限非生产测试" },
      twilioApi: { available: twilioManager.isInitialized(), name: "WhatsApp Business API", risk: "官方通道" },
      manual: { available: true, name: "人工同步", risk: "不调用外部接口" }
    };
    res.json({ modes });
  });

  // 开始 Web 扫码绑定流程
  app.post("/api/whatsapp/binding/web-scan/start", requireAuth, asyncRoute(async (req, res) => {
    if (!webScanEnabled) {
      res.status(403).json({ message: "测试扫码通道未启用" });
      return;
    }
    const schema = z.object({
      customerId: z.string()
    });
    const body = schema.parse(req.body);
    const customer = findWhatsAppCustomer(req.user!, body.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    if (!canManageWhatsAppBinding(req.user!, customer)) {
      res.status(403).json({ message: "只有客户负责人可以修改 WhatsApp 绑定" });
      return;
    }

    try {
      // 创建新的 WhatsApp Web 客户端
      const clientId = await whatsappWebManager.createClient(req.user!.id);

      // 存储绑定信息（状态为 qr-pending）
      const store = getStore();
      let binding = store.whatsappBindings.find((b) => b.customerId === customer.id);

      if (!binding) {
        binding = {
          id: `wab_${Date.now()}`,
          customerId: customer.id,
          phoneNumber: "",
          waProfileName: "",
          lastMessageAt: "",
          unreadCount: 0,
          createdAt: new Date().toISOString(),
          bindingMode: "web-scan",
          userId: req.user!.id,
          sessionData: clientId,
          connectionStatus: "qr-pending",
          lastConnectedAt: ""
        };
        store.whatsappBindings.push(binding);
      } else {
        binding.bindingMode = "web-scan";
        binding.userId = req.user!.id;
        binding.sessionData = clientId;
        binding.connectionStatus = "qr-pending";
      }

      await store.persist();

      whatsappWebManager.onMessage(clientId, async (message) => {
        const currentStore = getStore();
        if (currentStore.whatsappMessages.some((item) => item.waMessageId === message.waMessageId)) return;
        const currentBinding = currentStore.whatsappBindings.find((item) =>
          item.customerId === customer.id && item.sessionData === clientId
        );
        if (!currentBinding) return;
        message.customerId = customer.id;
        message.contentTranslated = await translateToChinese(req.user!, message.content);
        currentStore.whatsappMessages.push(message);
        currentBinding.lastMessageAt = message.createdAt;
        currentBinding.unreadCount = (currentBinding.unreadCount || 0) + 1;
        await currentStore.persist();
      });

      res.json({ clientId, bindingId: binding.id, status: "qr-pending" });
    } catch (error: any) {
      res.status(500).json({ message: "启动扫码失败: " + error.message });
    }
  }));

  // 获取二维码（通过 SSE 推送）
  app.get("/api/whatsapp/binding/web-scan/qr/:clientId", requireAuth, (req, res) => {
    const { clientId } = req.params;
    const binding = getStore().whatsappBindings.find((item) =>
      item.sessionData === clientId && item.userId === req.user!.id
    );
    if (!binding) {
      res.status(404).json({ message: "扫码会话不存在或无权访问" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const unsubscribe = whatsappWebManager.onQR(clientId, async (qr) => {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 220, margin: 1 });
      res.write(`data: ${JSON.stringify({ qrDataUrl })}\n\n`);
    });

    // 30秒超时
    const timer = setTimeout(() => {
      res.write(`data: ${JSON.stringify({ timeout: true })}\n\n`);
      res.end();
    }, 30000);

    req.on("close", () => {
      clearTimeout(timer);
      unsubscribe();
      res.end();
    });
  });

  // 检查 Web 扫码状态
  app.get("/api/whatsapp/binding/web-scan/status/:clientId", requireAuth, (req, res) => {
    const { clientId } = req.params;
    const binding = getStore().whatsappBindings.find((item) =>
      item.sessionData === clientId && item.userId === req.user!.id
    );
    if (!binding) {
      res.status(404).json({ message: "扫码会话不存在或无权访问" });
      return;
    }
    const status = whatsappWebManager.getClientStatus(clientId);
    if (binding.connectionStatus !== status) {
      binding.connectionStatus = status;
      if (status === "connected") binding.lastConnectedAt = new Date().toISOString();
      void getStore().persist();
    }
    res.json({ status });
  });

  // 断开 Web 扫码连接
  app.post("/api/whatsapp/binding/web-scan/disconnect", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      customerId: z.string()
    });
    const body = schema.parse(req.body);
    const customer = findWhatsAppCustomer(req.user!, body.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    if (!canManageWhatsAppBinding(req.user!, customer)) {
      res.status(403).json({ message: "只有客户负责人可以断开 WhatsApp 绑定" });
      return;
    }

    const store = getStore();
    const binding = store.whatsappBindings.find((b) => b.customerId === customer.id);

    if (binding && binding.sessionData) {
      await whatsappWebManager.disconnectClient(binding.sessionData);
      binding.connectionStatus = "disconnected";
      await store.persist();
    }

    res.json({ ok: true });
  }));

  // 开始 Twilio API 绑定
  app.post("/api/whatsapp/binding/twilio/start", requireAuth, asyncRoute(async (req, res) => {
    if (!twilioManager.isInitialized()) {
      res.status(400).json({ message: "Twilio 未配置，请联系管理员" });
      return;
    }

    const schema = z.object({
      customerId: z.string(),
      phoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "请输入包含国家码的客户号码"),
      twilioPhoneNumber: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "请输入包含国家码的企业发信号码")
    });
    const body = schema.parse(req.body);
    const customer = findWhatsAppCustomer(req.user!, body.customerId);
    if (!customer) {
      res.status(404).json({ message: "客户不存在或无权访问" });
      return;
    }
    if (!canManageWhatsAppBinding(req.user!, customer)) {
      res.status(403).json({ message: "只有客户负责人可以修改 WhatsApp 绑定" });
      return;
    }

    const store = getStore();
    let binding = store.whatsappBindings.find((b) => b.customerId === customer.id);

    if (!binding) {
      binding = {
        id: `wab_${Date.now()}`,
        customerId: customer.id,
        phoneNumber: body.phoneNumber,
        waProfileName: "",
        lastMessageAt: "",
        unreadCount: 0,
        createdAt: new Date().toISOString(),
        bindingMode: "twilio-api",
        twilioPhoneNumber: body.twilioPhoneNumber,
        userId: req.user!.id,
        connectionStatus: "connected",
        lastConnectedAt: new Date().toISOString()
      };
      store.whatsappBindings.push(binding);
    } else {
      binding.bindingMode = "twilio-api";
      binding.phoneNumber = body.phoneNumber;
      binding.twilioPhoneNumber = body.twilioPhoneNumber;
      binding.userId = req.user!.id;
      binding.connectionStatus = "connected";
      binding.lastConnectedAt = new Date().toISOString();
    }

    await store.persist();
    res.json({ binding: publicWhatsAppBinding(binding) });
  }));

  app.post("/api/whatsapp/followup-sync", requireAuth, asyncRoute(async (req, res) => {
    const started = Date.now();
    let payload: import("../whatsapp-followup-sync.js").FollowupSyncPayload;
    try {
      payload = followupSyncPayloadSchema.parse(req.body);
    } catch (error) {
      void ensureWhatsappExchangeEndpoint(req.user!.teamId, req.user!.id).then((endpoint) => {
        if (!endpoint) return;
        logWhatsappExchange({
          teamId: req.user!.teamId,
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          direction: "inbound",
          topic: "whatsapp.followup-sync",
          method: req.method,
          url: req.originalUrl.split("?")[0] || "/api/whatsapp/followup-sync",
          requestHeadersJson: JSON.stringify(redactWhatsappBodies(req.headers as Record<string, unknown>)).slice(0, 200_000),
          requestBody: whatsappLogBody(req.body),
          status: "failed",
          httpStatus: 400,
          responseHeadersJson: "{}",
          responseBody: JSON.stringify({ message: error instanceof Error ? error.message : "报文校验失败" }),
          durationMs: Date.now() - started,
          errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "报文校验失败",
          leadId: "",
          sourceIp: req.ip || req.socket?.remoteAddress || ""
        });
      }).catch(() => {});
      throw error;
    }
    const store = getStore();
    const result = await runWhatsappFollowupSync(req.user!, payload, {
      customersOf: (user) => ownedCustomersFor(user, "mine").map((customer) => ({
        id: customer.id,
        whatsapp: customer.whatsapp || "",
        whatsappPhone: customer.whatsapp || store.whatsappBindings.find((binding) => binding.customerId === customer.id)?.phoneNumber || ""
      })),
      aiConfig: (user) => getAiConfig(user),
      createLead: (user, input) => createLeadFromSource(user, input as Parameters<typeof createLeadFromSource>[1])
    });
    res.json(result);
    // 同步完成后落对接中心日志（fire-and-forget）：方向=接收、来源 IP=插件所在机器。
    void ensureWhatsappExchangeEndpoint(req.user!.teamId, req.user!.id).then((endpoint) => {
      if (!endpoint) return;
      const failed = result.failures.length > 0;
      logWhatsappExchange({
        teamId: req.user!.teamId,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        direction: "inbound",
        topic: "whatsapp.followup-sync",
        method: req.method,
        url: req.originalUrl.split("?")[0] || "/api/whatsapp/followup-sync",
        requestHeadersJson: JSON.stringify(redactWhatsappBodies(req.headers as Record<string, unknown>)).slice(0, 200_000),
        requestBody: whatsappLogBody(payload),
        // partial（部分会话失败）不算整条失败——仍是「已接收」，失败原因进 errorMessage。
        status: "received",
        httpStatus: 200,
        responseHeadersJson: "{}",
        responseBody: whatsappLogBody(result),
        durationMs: Date.now() - started,
        errorMessage: failed ? result.failures.slice(0, 5).join("；").slice(0, 1000) : "",
        leadId: "",
        sourceIp: req.ip || req.socket?.remoteAddress || ""
      });
    }).catch(() => {});
  }));

  /**
   * 「跟进/旅程上点图标看对话原文」的供给端。原文不落 CRM 库（老铁律）——
   * 它一直在插件的会话库里，这里只是带着 owner 身份去插件按 activityId 取当天那份。
   * 插件挂了/没配置时回 502，前端图标点了会看到明确的错误提示而不是静默。
   */
  app.get("/api/whatsapp/followup-transcript/:activityId", requireAuth, asyncRoute(async (req, res) => {
    const pluginBase = (process.env.WHATSAPP_PLUGIN_BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/u, "");
    const activityId = encodeURIComponent(String(req.params.activityId || ""));
    const started = Date.now();
    const sourceIp = req.ip || req.socket?.remoteAddress || "";
    const upstreamUrl = `${pluginBase}/api/v1/automation/followup-sync/transcript/activity/${activityId}`;
    try {
      const upstream = await fetch(upstreamUrl, {
        headers: { authorization: `Bearer ${signToken(req.user!)}` },
        signal: AbortSignal.timeout(8_000)
      });
      const body = await upstream.json().catch(() => ({}));
      // 前端 api() 的错误展示只认 `message` 字段，这里统一带上。
      if (!upstream.ok) {
        res.status(upstream.status).json({ ...body, message: body.message || body.error || "对话记录读取失败" });
        // 出站失败同样留痕（响应体是错误信息，不含原文）。
        void ensureWhatsappExchangeEndpoint(req.user!.teamId, req.user!.id).then((endpoint) => {
          if (!endpoint) return;
          logWhatsappExchange({
            teamId: req.user!.teamId,
            endpointId: endpoint.id,
            endpointName: endpoint.name,
            direction: "outbound",
            topic: "whatsapp.transcript",
            method: "GET",
            url: upstreamUrl,
            requestHeadersJson: JSON.stringify({ authorization: "Bearer ***", "x-trigger-source-ip": sourceIp }),
            requestBody: "",
            status: "failed",
            httpStatus: upstream.status,
            responseHeadersJson: "{}",
            responseBody: whatsappLogBody(body),
            durationMs: Date.now() - started,
            errorMessage: String(body.error || body.message || "对话记录读取失败").slice(0, 1000),
            leadId: "",
            sourceIp
          });
        }).catch(() => {});
        return;
      }
      res.json(body);
      // 出站成功留痕：响应正文里的消息原文同样替换成占位（原文不落库，要看走「查看对话」）。
      void ensureWhatsappExchangeEndpoint(req.user!.teamId, req.user!.id).then((endpoint) => {
        if (!endpoint) return;
        logWhatsappExchange({
          teamId: req.user!.teamId,
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          direction: "outbound",
          topic: "whatsapp.transcript",
          method: "GET",
          url: upstreamUrl,
          requestHeadersJson: JSON.stringify({ authorization: "Bearer ***", "x-trigger-source-ip": sourceIp }),
          requestBody: "",
          status: "ok",
          httpStatus: upstream.status,
          responseHeadersJson: "{}",
          responseBody: whatsappLogBody(body),
          durationMs: Date.now() - started,
          errorMessage: "",
          leadId: "",
          sourceIp
        });
      }).catch(() => {});
    } catch (error) {
      const message = `WhatsApp 插件服务不可达（${error instanceof Error ? error.message : "未知错误"}）`;
      void ensureWhatsappExchangeEndpoint(req.user!.teamId, req.user!.id).then((endpoint) => {
        if (!endpoint) return;
        logWhatsappExchange({
          teamId: req.user!.teamId,
          endpointId: endpoint.id,
          endpointName: endpoint.name,
          direction: "outbound",
          topic: "whatsapp.transcript",
          method: "GET",
          url: upstreamUrl,
          requestHeadersJson: JSON.stringify({ authorization: "Bearer ***", "x-trigger-source-ip": sourceIp }),
          requestBody: "",
          status: "failed",
          httpStatus: null,
          responseHeadersJson: "{}",
          responseBody: "",
          durationMs: Date.now() - started,
          errorMessage: message.slice(0, 1000),
          leadId: "",
          sourceIp
        });
      }).catch(() => {});
      res.status(502).json({ error: message, code: "PLUGIN_UNREACHABLE" });
    }
  }));

  // Twilio Webhook 接收消息
  app.post("/api/whatsapp/webhook/twilio", asyncRoute(async (req, res) => {
    const signature = String(req.headers["x-twilio-signature"] || "");
    const url = twilioWebhookUrl || `${req.protocol}://${req.get("host")}${req.originalUrl}`;

    if (!signature || !twilioManager.validateWebhook(signature, url, req.body)) {
      res.status(403).json({ message: "Invalid signature" });
      return;
    }

    const { From, To, Body, MessageSid } = z.object({
      From: z.string().min(5).max(40),
      To: z.string().min(5).max(40),
      Body: z.string().max(4000).default(""),
      MessageSid: z.string().min(8).max(80)
    }).parse(req.body);

    // 去掉 whatsapp: 前缀
    const fromNumber = From.replace("whatsapp:", "");
    const toNumber = To.replace("whatsapp:", "");

    const store = getStore();
    if (store.whatsappMessages.some((message) => message.waMessageId === MessageSid)) {
      res.type("text/xml");
      res.send("<Response></Response>");
      return;
    }

    // 目标通道和客户号码必须同时匹配，避免共享通道时串客户。
    const binding = store.whatsappBindings.find((b) =>
      b.bindingMode === "twilio-api"
      && b.twilioPhoneNumber === toNumber
      && b.phoneNumber === fromNumber
    );

    if (binding) {
      const message = {
        id: `wam_${Date.now()}`,
        customerId: binding.customerId,
        direction: "inbound" as const,
        content: Body,
        contentTranslated: "",
        mediaUrl: "",
        status: "received",
        waMessageId: MessageSid,
        createdAt: new Date().toISOString()
      };

      store.whatsappMessages.push(message);
      binding.lastMessageAt = message.createdAt;
      binding.unreadCount = (binding.unreadCount || 0) + 1;

      await store.persist();
    }

    // Twilio 需要 TwiML 响应
    res.type("text/xml");
    res.send("<Response></Response>");
  }));

  app.get("/api/wecom/messages", requireAuth, (req, res) => {
    const { wecomMessages } = getStore();
    const scoped = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
    res.json({ messages: scoped });
  });

  app.post("/api/wecom/messages/:id/archive", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const message = store.wecomMessages.find((item) => item.id === req.params.id);
    if (!message || !canSeeOwner(req.user!, message.ownerId, message.teamId)) {
      res.status(404).json({ message: "企微摘要不存在" });
      return;
    }
    message.status = "archived";
    await store.persist();
    res.json({ message });
  }));
}
