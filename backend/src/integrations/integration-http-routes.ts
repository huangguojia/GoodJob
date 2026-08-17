import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { hasIamPermission, isPlatformIdentity, requireAuth } from "../auth.js";
import { getStore } from "../store.js";
import { getIntegrationControlPlaneService } from "./integration-runtime.js";
import { localRunnerAgentRouter, localRunnerWebRouter } from "./local-runner-http-routes.js";

const router = Router();
const oauthCallbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: process.env.NODE_ENV === "test" ? 10_000 : 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "OAuth 回调请求过于频繁"
});
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: process.env.NODE_ENV === "test" ? 10_000 : 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "Webhook 请求过于频繁"
});

function requestId(req: Request) {
  const supplied = String(req.headers["x-request-id"] || "").trim();
  return /^[A-Za-z0-9._:-]{8,100}$/u.test(supplied) ? supplied : `req_${randomUUID()}`;
}

function service() {
  const current = getIntegrationControlPlaneService();
  if (!current) throw Object.assign(new Error("集成服务当前未启用"), { code: "INTEGRATION_DISABLED", status: 503 });
  return current;
}

function send(res: Response, id: string, data: unknown) {
  res.json({ requestId: id, data, uiAction: { type: "refresh", view: "integration-center" } });
}

function handle(handler: (req: Request, res: Response, id: string) => Promise<void>) {
  return async (req: Request, res: Response) => {
    const id = requestId(req);
    try {
      await handler(req, res, id);
    } catch (cause) {
      const value = cause as { code?: string; status?: number; message?: string };
      const validationError = cause instanceof z.ZodError;
      const status = validationError ? 400 : Number(value.status || 500);
      res.status(status).json({
        requestId: id,
        errorCode: validationError ? "INTEGRATION_INPUT_INVALID" : value.code || "INTEGRATION_INTERNAL_ERROR",
        message: validationError
          ? cause.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
          : status >= 500 && !value.code ? "集成服务处理失败" : value.message || "集成服务处理失败",
        recoverable: [409, 429, 502, 503, 504].includes(status),
        action: status === 409 ? "refresh_integration_state" : status === 503 ? "check_integration_service" : ""
      });
    }
  };
}

router.get("/oauth/callback/:connectorCode", oauthCallbackLimiter, async (req, res) => {
  res.set({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-frame-options": "DENY"
  });
  try {
    const connectorCode = z.string().regex(/^[a-z0-9-]{2,100}$/u).parse(req.params.connectorCode);
    const callback = await service().receiveOAuthCallback(connectorCode, {
      state: String(req.query.state || ""),
      code: req.query.code ? String(req.query.code) : undefined,
      iss: req.query.iss ? String(req.query.iss) : undefined,
      oauthError: req.query.error ? String(req.query.error) : undefined
    });
    if (service().oauthSuccessRedirectUrl) {
      const target = new URL(service().oauthSuccessRedirectUrl);
      target.searchParams.set("integrationOAuth", "completed");
      target.searchParams.set("transactionId", callback.transactionId);
      res.redirect(303, target.toString());
      return;
    }
    res.status(202).type("html").send("<!doctype html><meta charset=\"utf-8\"><title>授权已接收</title><style>body{font:15px system-ui;margin:48px;color:#17202a}main{max-width:520px;margin:auto}h1{font-size:22px}</style><main><h1>授权已接收</h1><p>正在安全交换凭据，请返回 GoodJob CRM 完成账号确认。</p></main>");
  } catch (cause) {
    const value = cause as { status?: number; message?: string };
    res.status(Number(value.status || 400)).type("html").send(`<!doctype html><meta charset="utf-8"><title>授权失败</title><main><h1>授权未完成</h1><p>${String(value.message || "OAuth 回调处理失败").replace(/[<>&"']/gu, "")}</p></main>`);
  }
});

const webhookParams = z.object({
  connectorCode: z.string().regex(/^[a-z0-9-]{2,100}$/u),
  connectionPublicId: z.string().regex(/^iwp_[a-f0-9]{32}$/u)
});

async function validateWebhook(req: Request, res: Response) {
  try {
    const params = webhookParams.parse(req.params);
    const validationToken = z.string().min(1).max(500).parse(req.query.validationToken);
    await service().validateWebhookEndpoint(params.connectorCode, params.connectionPublicId);
    res.set("cache-control", "no-store").status(200).type("text/plain").send(validationToken);
  } catch (cause) {
    const value = cause as { code?: string; status?: number; message?: string };
    res.status(Number(value.status || (cause instanceof z.ZodError ? 400 : 500))).json({
      errorCode: value.code || (cause instanceof z.ZodError ? "INTEGRATION_INPUT_INVALID" : "INTEGRATION_INTERNAL_ERROR"),
      message: value.message || "Webhook 验证失败"
    });
  }
}

router.get("/webhooks/:connectorCode/:connectionPublicId", webhookLimiter, validateWebhook);
router.post("/webhooks/:connectorCode/:connectionPublicId", webhookLimiter, async (req, res) => {
  if (req.query.validationToken) {
    await validateWebhook(req, res);
    return;
  }
  try {
    const params = webhookParams.parse(req.params);
    const captured = (req as Request & { integrationRawBody?: Buffer }).integrationRawBody;
    const rawBody = captured || Buffer.from(JSON.stringify(req.body || {}), "utf8");
    const result = await service().receiveWebhook({
      connectorCode: params.connectorCode,
      webhookPublicId: params.connectionPublicId,
      body: req.body,
      rawBody,
      signatureHeader: String(req.headers["x-goodjob-signature"] || ""),
      nonce: String(req.headers["x-goodjob-nonce"] || ""),
      eventId: String(req.headers["x-goodjob-event-id"] || ""),
      eventType: String(req.headers["x-goodjob-event-type"] || "")
    });
    res.status(202).json({ received: true, ...result });
  } catch (cause) {
    const value = cause as { code?: string; status?: number; message?: string };
    const status = cause instanceof z.ZodError ? 400 : Number(value.status || 500);
    res.status(status).json({
      received: false,
      errorCode: cause instanceof z.ZodError ? "INTEGRATION_INPUT_INVALID" : value.code || "INTEGRATION_INTERNAL_ERROR",
      message: status >= 500 && !value.code ? "Webhook 处理失败" : value.message || "Webhook 处理失败"
    });
  }
});

router.use(localRunnerAgentRouter);
router.use(requireAuth);
router.use(async (req, res, next) => {
  try {
    const connectorReviewRequest = req.path === "/connectors/reviews"
      || /^\/connectors\/[^/]+\/review$/u.test(req.path);
    if (isPlatformIdentity(req.user)) {
      const permissionCode = "platform.integration.connector.review";
      if (!connectorReviewRequest || !hasIamPermission(req.user, permissionCode)) {
        res.status(403).json({ requestId: requestId(req), errorCode: "INTEGRATION_PERMISSION_DENIED", message: "平台运维身份不能直接管理公司集成", permissionCode, recoverable: false, action: "" });
        return;
      }
      res.setHeader("X-Authorization-Source", "iam");
      next();
      return;
    }
    const method = req.method.toUpperCase();
    const permissionCode = ["GET", "HEAD"].includes(method)
      ? connectorReviewRequest ? "integration.manage" : "integration.read"
      : req.path === "/local-runners/pairings" || /^\/local-runners\/[^/]+\/revoke$/u.test(req.path)
        ? "integration.connect"
        : req.path === "/connectors/private" || /^\/tools\/[^/]+\/(approve|reject)$/u.test(req.path) || /^\/calls\/[^/]+\/reconcile$/u.test(req.path)
        ? "integration.manage"
        : /^\/approvals\/[^/]+\/(approve|reject)$/u.test(req.path)
          ? "integration.approval.act"
          : req.path === "/connections" || req.path.startsWith("/connections/")
            ? "integration.connect"
            : "integration.execute";
    if (!hasIamPermission(req.user, permissionCode)) {
      res.status(403).json({ requestId: requestId(req), errorCode: "INTEGRATION_PERMISSION_DENIED", message: "当前账号没有访问集成中心的权限", permissionCode, recoverable: false, action: "" });
      return;
    }
    if (getStore().resolveIamDataScope) {
      req.user!.iamDataScope = { permissionCode, ...await getStore().resolveIamDataScope!(req.user!, permissionCode) };
    } else {
      const scopes = req.user!.iamPermissions?.[permissionCode] || [];
      const organizationWide = scopes.includes("org_unit") || scopes.includes("org_subtree");
      req.user!.iamDataScope = {
        permissionCode,
        tenantWide: scopes.includes("tenant"),
        ownerIds: organizationWide
          ? getStore().users.filter((user) => user.teamId === req.user!.teamId && user.status === "active").map((user) => user.id)
          : scopes.includes("self") ? [req.user!.id] : []
      };
    }
    res.setHeader("X-Authorization-Source", "iam");
    next();
  } catch (error) {
    next(error);
  }
});

router.use(localRunnerWebRouter);

const connectionSchema = z.object({
  connectorId: z.string().min(1).max(64),
  scope: z.enum(["personal", "team", "platform"]),
  teamId: z.string().max(64).optional(),
  displayName: z.string().max(160).default(""),
  credentials: z.record(z.string(), z.string().max(2_000))
    .refine((value) => Object.keys(value).length <= 8, "凭据字段不能超过 8 个")
    .optional()
}).strict();

const reviewSchema = z.object({
  stableAlias: z.string().min(3).max(120),
  riskLevel: z.number().int().min(0).max(5),
  permissionCode: z.string().min(2).max(80),
  fieldAllowlist: z.array(z.string().min(1).max(100)).max(100).default([]),
  dailyCallLimit: z.number().int().min(1).max(10_000).default(100),
  allowedDataClasses: z.array(z.enum(["public", "business", "personal", "sensitive"])).max(4).default(["public", "business", "personal"]),
  approvalPolicy: z.enum(["risk_based", "always"]).default("risk_based"),
  completionEvidence: z.array(z.enum([
    "created_object_id", "external_receipt_id", "state_transition", "read_after_write_match",
    "delivery_acceptance", "file_artifact"
  ])).max(6).default([])
}).strict();

const utcDateTime = z.string().datetime({ offset: true });
const timeZone = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_+\-/]+$/u);
const emailList = z.array(z.string().trim().email().max(254)).min(1).max(50);
const optionalEmailList = z.array(z.string().trim().email().max(254)).max(50).default([]);
const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(180),
  contentType: z.string().trim().max(120).default("application/octet-stream"),
  contentBase64: z.string().min(1).max(5_600_000)
}).strict();

router.get("/catalog", handle(async (req, res, id) => send(res, id, await service().catalog(req.user!))));
router.post("/connectors/private", handle(async (req, res, id) => {
  const body = z.object({
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().min(3).max(100),
    version: z.string().trim().min(1).max(40).default("1.0.0"),
    description: z.string().trim().max(1000).default(""),
    teamId: z.string().trim().max(64).optional(),
    manifest: z.record(z.string(), z.unknown())
  }).strict().parse(req.body);
  res.status(202);
  send(res, id, await service().registerPrivateConnector(req.user!, body));
}));
router.get("/connectors/reviews", handle(async (req, res, id) => {
  const query = z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() }).strict().parse(req.query);
  send(res, id, await service().connectorReviews(req.user!, query.status || ""));
}));
router.post("/connectors/:id/review", handle(async (req, res, id) => {
  const body = z.object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(1000).default("")
  }).strict().parse(req.body);
  send(res, id, await service().reviewPrivateConnector(req.user!, req.params.id, body));
}));
router.get("/connections", handle(async (req, res, id) => send(
  res,
  id,
  await service().connections(req.user!, String(req.query.teamId || ""))
)));
router.post("/connections", handle(async (req, res, id) => {
  const body = connectionSchema.parse(req.body);
  const connection = await service().createConnection(req.user!, body);
  res.status(202);
  send(res, id, connection);
}));
router.get("/connections/:id", handle(async (req, res, id) => send(
  res,
  id,
  await service().connection(req.user!, req.params.id, String(req.query.teamId || ""))
)));
router.post("/connections/:id/auth/start", handle(async (req, res, id) => {
  res.status(202);
  send(res, id, await service().startAuthorization(req.user!, req.params.id));
}));
router.get("/auth/transactions/:id", handle(async (req, res, id) => send(
  res,
  id,
  await service().authTransaction(req.user!, req.params.id)
)));
router.post("/connections/:id/confirm", handle(async (req, res, id) => {
  const body = z.object({ transactionId: z.string().max(64).default("") }).strict().parse(req.body || {});
  res.status(202);
  send(res, id, await service().confirmAuthorization(req.user!, req.params.id, body.transactionId));
}));
router.post("/connections/:id/reauthorize", handle(async (req, res, id) => {
  res.status(202);
  send(res, id, await service().reauthorizeConnection(req.user!, req.params.id));
}));
router.post("/connections/:id/credentials", handle(async (req, res, id) => {
  const credentials = z.record(z.string(), z.string().max(2_000))
    .refine((value) => Object.keys(value).length <= 8, "凭据字段不能超过 8 个")
    .parse(req.body?.credentials);
  res.status(202);
  send(res, id, await service().replaceApiCredentials(req.user!, req.params.id, credentials));
}));
router.post("/connections/:id/refresh-tools", handle(async (req, res, id) => {
  res.status(202);
  send(res, id, await service().refreshTools(req.user!, req.params.id));
}));
router.post("/connections/:id/pause", handle(async (req, res, id) => send(res, id, await service().pauseConnection(req.user!, req.params.id))));
router.post("/connections/:id/resume", handle(async (req, res, id) => send(res, id, await service().resumeConnection(req.user!, req.params.id))));
router.post("/connections/:id/disconnect", handle(async (req, res, id) => send(res, id, await service().disconnectConnection(req.user!, req.params.id))));

router.get("/tools", handle(async (req, res, id) => send(
  res,
  id,
  await service().tools(req.user!, String(req.query.connectionId || ""), String(req.query.teamId || ""))
)));
router.post("/tools/:id/approve", handle(async (req, res, id) => send(
  res,
  id,
  await service().approveTool(req.user!, req.params.id, reviewSchema.parse(req.body))
)));
router.post("/tools/:id/reject", handle(async (req, res, id) => send(
  res,
  id,
  await service().rejectTool(req.user!, req.params.id, z.object({ note: z.string().max(500).default("") }).strict().parse(req.body).note)
)));
router.post("/tools/:id/test", handle(async (req, res, id) => {
  res.status(202);
  send(res, id, await service().testTool(req.user!, req.params.id));
}));

router.get("/approvals", handle(async (req, res, id) => send(
  res,
  id,
  await service().approvals(req.user!, String(req.query.status || ""))
)));
router.get("/approvals/:id", handle(async (req, res, id) => send(res, id, await service().approval(req.user!, req.params.id))));
router.post("/approvals/:id/approve", handle(async (req, res, id) => {
  res.status(202);
  send(res, id, await service().approveExecution(req.user!, req.params.id));
}));
router.post("/approvals/:id/reject", handle(async (req, res, id) => {
  const body = z.object({ note: z.string().max(1_000).default("") }).strict().parse(req.body || {});
  send(res, id, await service().rejectExecution(req.user!, req.params.id, body.note));
}));

router.get("/calls", handle(async (req, res, id) => send(
  res,
  id,
  await service().calls(req.user!, String(req.query.teamId || ""))
)));
router.get("/usage", handle(async (req, res, id) => {
  const query = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional()
  }).strict().parse(req.query);
  send(res, id, await service().dailyUsage(req.user!, query.date));
}));
router.get("/calls/:id", handle(async (req, res, id) => send(
  res,
  id,
  await service().call(req.user!, req.params.id, String(req.query.teamId || ""))
)));
router.get("/events", handle(async (req, res, id) => send(
  res,
  id,
  await service().webhookEvents(req.user!, String(req.query.status || ""))
)));
router.post("/events/:id/replay", handle(async (req, res, id) => {
  res.status(202);
  send(res, id, await service().replayWebhookEvent(req.user!, req.params.id));
}));
router.post("/events/:id/link-customer", handle(async (req, res, id) => {
  const body = z.object({ customerId: z.string().trim().min(1).max(64) }).strict().parse(req.body);
  send(res, id, await service().linkWebhookEventCustomer(req.user!, req.params.id, body.customerId));
}));
router.post("/calls/:id/reconcile", handle(async (req, res, id) => {
  const body = z.object({
    outcome: z.enum(["succeeded", "failed"]),
    note: z.string().trim().min(1).max(1_000),
    externalReceipt: z.string().max(500).default("")
  }).strict().parse(req.body);
  send(res, id, await service().reconcileExecution(req.user!, req.params.id, body));
}));

router.get("/microsoft/mail/messages", handle(async (req, res, id) => {
  const query = z.object({
    query: z.string().trim().max(200).default(""),
    sender: z.string().trim().max(254).default(""),
    domain: z.string().trim().max(253).default(""),
    folder: z.enum(["inbox", "sentitems", "drafts"]).default("inbox"),
    pageSize: z.coerce.number().int().min(1).max(50).default(25),
    offset: z.coerce.number().int().min(0).max(10_000).default(0)
  }).strict().parse(req.query);
  send(res, id, await service().microsoftMailSearch(req.user!, query, id));
}));

router.get("/microsoft/mail/messages/:messageId", handle(async (req, res, id) => {
  const messageId = z.string().trim().min(1).max(512).parse(req.params.messageId);
  send(res, id, await service().microsoftMessage(req.user!, messageId, id));
}));

router.post("/microsoft/mail/send", handle(async (req, res, id) => {
  const body = z.object({
    customerId: z.string().trim().min(1).max(64),
    to: emailList,
    cc: optionalEmailList,
    subject: z.string().trim().min(1).max(255),
    body: z.string().min(1).max(50_000),
    bodyType: z.enum(["text", "html"]).default("text"),
    attachments: z.array(attachmentSchema).max(5).default([]),
    conversationId: z.string().trim().max(500).default(""),
    nextFollowAt: z.string().trim().max(100).default("")
  }).strict().parse(req.body);
  res.status(202);
  send(res, id, await service().microsoftSendMail(req.user!, body, id));
}));

router.get("/microsoft/calendar/events", handle(async (req, res, id) => {
  const query = z.object({
    startUtc: utcDateTime,
    endUtc: utcDateTime,
    timeZone: timeZone.default("UTC"),
    pageSize: z.coerce.number().int().min(1).max(50).default(25),
    offset: z.coerce.number().int().min(0).max(10_000).default(0)
  }).strict().parse(req.query);
  send(res, id, await service().microsoftCalendarEvents(req.user!, query, id));
}));

router.post("/microsoft/calendar/availability", handle(async (req, res, id) => {
  const body = z.object({
    schedules: emailList.max(20),
    startUtc: utcDateTime,
    endUtc: utcDateTime,
    timeZone,
    intervalMinutes: z.number().int().min(5).max(1440).default(30)
  }).strict().parse(req.body);
  send(res, id, await service().microsoftCalendarAvailability(req.user!, body, id));
}));

router.post("/microsoft/calendar/events", handle(async (req, res, id) => {
  const body = z.object({
    customerId: z.string().trim().min(1).max(64),
    subject: z.string().trim().min(1).max(255),
    startUtc: utcDateTime,
    endUtc: utcDateTime,
    timeZone,
    attendees: emailList,
    body: z.string().max(20_000).default(""),
    onlineMeeting: z.boolean().default(true),
    location: z.string().trim().max(255).default(""),
    nextFollowAt: z.string().trim().max(100).default("")
  }).strict().parse(req.body);
  res.status(202);
  send(res, id, await service().microsoftCreateEvent(req.user!, body, id));
}));

router.patch("/microsoft/calendar/events/:eventId", handle(async (req, res, id) => {
  const body = z.object({
    customerId: z.string().trim().min(1).max(64),
    etag: z.string().trim().min(1).max(512),
    subject: z.string().trim().min(1).max(255).optional(),
    startUtc: utcDateTime.optional(),
    endUtc: utcDateTime.optional(),
    timeZone: timeZone.optional(),
    attendees: optionalEmailList.optional(),
    body: z.string().max(20_000).optional(),
    onlineMeeting: z.boolean().optional(),
    location: z.string().trim().max(255).optional(),
    nextFollowAt: z.string().trim().max(100).default("")
  }).strict().parse(req.body);
  const eventId = z.string().trim().min(1).max(512).parse(req.params.eventId);
  res.status(202);
  send(res, id, await service().microsoftUpdateEvent(req.user!, { ...body, eventId }, id));
}));

router.get("/microsoft/business-calls/:id", handle(async (req, res, id) => {
  const callId = z.string().trim().min(1).max(64).parse(req.params.id);
  send(res, id, await service().microsoftBusinessCall(req.user!, callId));
}));

router.get("/google/mail/messages", handle(async (req, res, id) => {
  const query = z.object({
    query: z.string().trim().max(200).default(""),
    sender: z.string().trim().max(254).default(""),
    domain: z.string().trim().max(253).default(""),
    folder: z.enum(["inbox", "sentitems", "drafts"]).default("inbox"),
    pageSize: z.coerce.number().int().min(1).max(50).default(25),
    pageToken: z.string().trim().max(1024).default("")
  }).strict().parse(req.query);
  send(res, id, await service().googleMailSearch(req.user!, query, id));
}));

router.get("/google/mail/messages/:messageId", handle(async (req, res, id) => {
  const messageId = z.string().trim().min(1).max(512).parse(req.params.messageId);
  send(res, id, await service().googleMessage(req.user!, messageId, id));
}));

router.post("/google/mail/send", handle(async (req, res, id) => {
  const body = z.object({
    customerId: z.string().trim().min(1).max(64),
    to: emailList,
    cc: optionalEmailList,
    subject: z.string().trim().min(1).max(255),
    body: z.string().min(1).max(50_000),
    bodyType: z.enum(["text", "html"]).default("text"),
    attachments: z.array(attachmentSchema).max(5).default([]),
    conversationId: z.string().trim().max(500).default(""),
    inReplyTo: z.string().trim().max(998).default(""),
    nextFollowAt: z.string().trim().max(100).default("")
  }).strict().parse(req.body);
  res.status(202);
  send(res, id, await service().googleSendMail(req.user!, body, id));
}));

router.get("/google/calendar/events", handle(async (req, res, id) => {
  const query = z.object({
    startUtc: utcDateTime,
    endUtc: utcDateTime,
    timeZone: timeZone.default("UTC"),
    pageSize: z.coerce.number().int().min(1).max(50).default(25),
    pageToken: z.string().trim().max(1024).default("")
  }).strict().parse(req.query);
  send(res, id, await service().googleCalendarEvents(req.user!, query, id));
}));

router.post("/google/calendar/availability", handle(async (req, res, id) => {
  const body = z.object({
    schedules: emailList.max(20),
    startUtc: utcDateTime,
    endUtc: utcDateTime,
    timeZone,
    intervalMinutes: z.number().int().min(5).max(1440).default(30)
  }).strict().parse(req.body);
  send(res, id, await service().googleCalendarAvailability(req.user!, body, id));
}));

router.post("/google/calendar/events", handle(async (req, res, id) => {
  const body = z.object({
    customerId: z.string().trim().min(1).max(64),
    subject: z.string().trim().min(1).max(255),
    startUtc: utcDateTime,
    endUtc: utcDateTime,
    timeZone,
    attendees: emailList,
    body: z.string().max(20_000).default(""),
    onlineMeeting: z.boolean().default(true),
    location: z.string().trim().max(255).default(""),
    nextFollowAt: z.string().trim().max(100).default("")
  }).strict().parse(req.body);
  res.status(202);
  send(res, id, await service().googleCreateEvent(req.user!, body, id));
}));

router.patch("/google/calendar/events/:eventId", handle(async (req, res, id) => {
  const body = z.object({
    customerId: z.string().trim().min(1).max(64),
    etag: z.string().trim().min(1).max(512),
    subject: z.string().trim().min(1).max(255).optional(),
    startUtc: utcDateTime.optional(),
    endUtc: utcDateTime.optional(),
    timeZone: timeZone.optional(),
    attendees: optionalEmailList.optional(),
    body: z.string().max(20_000).optional(),
    onlineMeeting: z.boolean().optional(),
    location: z.string().trim().max(255).optional(),
    nextFollowAt: z.string().trim().max(100).default("")
  }).strict().parse(req.body);
  const eventId = z.string().trim().min(1).max(512).parse(req.params.eventId);
  res.status(202);
  send(res, id, await service().googleUpdateEvent(req.user!, { ...body, eventId }, id));
}));

router.get("/google/business-calls/:id", handle(async (req, res, id) => {
  const callId = z.string().trim().min(1).max(64).parse(req.params.id);
  send(res, id, await service().googleBusinessCall(req.user!, callId));
}));

export const integrationHttpRouter = router;
