import { createServer, type Server as HttpServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import pino from "pino";
import { z, ZodError } from "zod";
import { E164_PHONE_PATTERN, isE164PhoneNumber, type CommercialReadinessCheck, type ContactOrigin, type CrmSandboxContact } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db/database.js";
import { migrate } from "./db/migrate.js";
import { Repository } from "./db/repository.js";
import { seed, seedDemo as seedDemoData } from "./db/seed.js";
import { DomainError } from "./errors.js";
import { BaileysProvider } from "./providers/baileys-provider.js";
import { DemoProvider } from "./providers/demo-provider.js";
import { MetaProvider } from "./providers/meta-provider.js";
import { ProviderManager } from "./providers/provider-manager.js";
import { RealtimeHub } from "./realtime.js";
import { EncryptionService } from "./security/encryption.js";
import { TranslationService } from "./services/translation.js";
import { MediaStorageService } from "./services/media-storage.js";
import { ConversationIntelligenceService } from "./services/conversation-intelligence.js";
import { requireCrmAuth } from "./crm-auth.js";
import { AutomationRhythmService } from "./services/automation-rhythm.js";
import { historyMessageId, parseWhatsAppHistory, previewWhatsAppHistory } from "./services/whatsapp-history-import.js";

export interface AppRuntime {
  app: Express;
  server: HttpServer;
  database: Database;
  repository: Repository;
  providers: ProviderManager;
  translation: TranslationService;
  close(): Promise<void>;
}

const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.enum(["demo", "baileys", "meta"]),
  phone: z.string().trim().max(40).optional(),
  purposeLabel: z.string().trim().max(80).optional(),
  leadTypes: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  region: z.string().trim().max(80).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  riskAccepted: z.boolean().optional()
});

const messageSchema = z.object({
  accountId: z.string().uuid(),
  clientMessageId: z.string().min(8).max(100),
  body: z.string().trim().min(1).max(10_000)
});

const mediaUploadSchema = z.object({
  accountId: z.string().uuid(),
  clientMessageId: z.string().min(8).max(100),
  kind: z.enum(["image", "video", "file"]),
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(120),
  caption: z.string().trim().max(2_000).default("")
});

const mediaRetentionSchema = z.object({
  mode: z.enum(["immediate", "days"]),
  days: z.number().int().min(0).max(365)
}).superRefine((value, context) => {
  if (value.mode === "immediate" && value.days !== 0) {
    context.addIssue({ code: "custom", path: ["days"], message: "立即清理模式的天数必须为 0" });
  }
  if (value.mode === "days" && value.days < 1) {
    context.addIssue({ code: "custom", path: ["days"], message: "保留模式至少为 1 天" });
  }
});

const MEDIA_UPLOAD_LIMIT = "25mb";
const MEDIA_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

function validateMediaUpload(input: z.infer<typeof mediaUploadSchema>, sizeBytes: number): void {
  if (sizeBytes < 1 || sizeBytes > MEDIA_UPLOAD_LIMIT_BYTES) {
    throw new DomainError("MEDIA_SIZE_INVALID", 413, "附件大小必须在 1B 到 25MB 之间");
  }
  if (input.kind === "image" && !input.mimeType.startsWith("image/")) {
    throw new DomainError("MEDIA_TYPE_INVALID", 400, "图片附件的 MIME 类型无效");
  }
  if (input.kind === "video" && !input.mimeType.startsWith("video/")) {
    throw new DomainError("MEDIA_TYPE_INVALID", 400, "视频附件的 MIME 类型无效");
  }
  if (
    /(?:x-msdownload|x-executable|x-sh|x-dosexec|text\/html|image\/svg\+xml|javascript)/iu.test(input.mimeType)
    || /\.(?:exe|dll|dmg|pkg|sh|bat|cmd|app|html?|svg|js|mjs|cjs)$/iu.test(input.fileName)
  ) {
    throw new DomainError("MEDIA_TYPE_BLOCKED", 400, "该文件类型不允许发送");
  }
}

const templateMessageSchema = z.object({
  accountId: z.string().uuid(),
  clientMessageId: z.string().min(8).max(100),
  templateName: z.string().trim().regex(/^[a-z0-9_]{1,512}$/u, "Template name must use lowercase letters, numbers, or underscores"),
  languageCode: z.string().trim().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/u, "Template language must look like en_US"),
  bodyParameters: z.array(z.string().trim().min(1).max(1024)).max(20).default([])
});

const manualContactSchema = z.object({
  accountId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(80),
  phone: z.string().trim().regex(E164_PHONE_PATTERN, "Phone must use strict E.164 format"),
  createCrmContact: z.boolean().default(false)
});

const integrationPreferenceSchema = z
  .object({
    strategy: z.enum(["free_first", "official_first", "hybrid"]),
    defaultProvider: z.enum(["baileys", "meta"])
  })
  .superRefine((value, context) => {
    const requiredProvider = value.strategy === "free_first"
      ? "baileys"
      : value.strategy === "official_first"
        ? "meta"
        : null;
    if (requiredProvider && value.defaultProvider !== requiredProvider) {
      context.addIssue({
        code: "custom",
        path: ["defaultProvider"],
        message: `${value.strategy} requires ${requiredProvider} as the default provider`
      });
    }
  });

const routingRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    leadType: z.string().trim().max(80).default(""),
    region: z.string().trim().max(80).default(""),
    preferredAccountId: z.string().uuid(),
    fallbackAccountId: z.string().uuid().nullable().default(null),
    priority: z.number().int().min(0).max(10_000).default(100),
    enabled: z.boolean().default(true)
  })
  .refine((value) => value.fallbackAccountId !== value.preferredAccountId, {
    path: ["fallbackAccountId"],
    message: "Fallback account must differ from the preferred account"
  });

const metaAppSchema = z.object({
  name: z.string().trim().min(1).max(80),
  appId: z.string().trim().regex(/^\d{4,40}$/u, "Meta App ID must contain only digits"),
  appSecret: z.string().min(8).max(500),
  verifyToken: z.string().min(8).max(500)
});

const metaConfigurationSchema = z.object({
  appConfigId: z.string().uuid(),
  wabaId: z.string().trim().regex(/^\d{4,40}$/u, "WABA ID must contain only digits"),
  phoneNumberId: z.string().trim().regex(/^\d{4,40}$/u, "Phone Number ID must contain only digits"),
  accessToken: z.string().min(8).max(2000),
  graphApiVersion: z.string().trim().regex(/^v\d+\.\d+$/u, "Graph API version must look like v23.0")
});

const secretMask = (value: string): string => `****${value.slice(-4)}`;

const asyncRoute =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

const routeParam = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value);

const inboundRequestId = (request: Request): string => {
  const candidate = request.header("x-request-id")?.trim();
  return candidate && /^[A-Za-z0-9._:-]{1,100}$/u.test(candidate) ? candidate : randomUUID();
};

const safeRequestPath = (request: Request): string => {
  if (request.path.startsWith("/api/webhooks/meta/")) return "/api/webhooks/meta/:webhookKey";
  const routePath = request.route?.path as unknown;
  return typeof routePath === "string" ? routePath : request.path;
};

const beginHttpClose = (server: HttpServer): Promise<void> => {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
};

export async function createAppRuntime(config: AppConfig): Promise<AppRuntime> {
  const demoProviderEnabled = config.enableDemoProvider ?? config.nodeEnv !== "production";
  const autoMigrate = config.autoMigrate ?? config.nodeEnv !== "production";
  const officialOnly = config.officialOnly ?? config.nodeEnv === "production";
  if (config.seedDemo && !demoProviderEnabled) throw new Error("Demo seed requires the Demo Provider to be enabled");
  if (config.nodeEnv === "production") {
    if (config.databaseClient !== "mysql") throw new Error("DATABASE_CLIENT must be mysql in production");
    if (!config.sessionMasterKey || Buffer.from(config.sessionMasterKey, "base64").length !== 32) {
      throw new Error("SESSION_MASTER_KEY must decode to exactly 32 bytes in production");
    }
    if (config.seedDemo || demoProviderEnabled) throw new Error("Demo features must be disabled in production");
    if (autoMigrate) throw new Error("AUTO_MIGRATE must be false in production");
    if (!officialOnly) throw new Error("WHATSAPP_OFFICIAL_ONLY must be true in production");
    const graphBaseUrl = config.metaGraphBaseUrl?.replace(/\/+$/u, "");
    if (graphBaseUrl && graphBaseUrl !== "https://graph.facebook.com") {
      throw new Error("META_GRAPH_BASE_URL must use https://graph.facebook.com in production");
    }
  }

  const logger = pino({
    name: "whatsapp-crm-plugin",
    level: config.nodeEnv === "test" ? "silent" : "info",
    redact: {
      paths: [
        "authorization",
        "cookie",
        "accessToken",
        "apiKey",
        "appSecret",
        "verifyToken",
        "qrDataUrl",
        "body"
      ],
      censor: "[Redacted]"
    }
  });
  const database = await createDatabase(config);
  if (autoMigrate) await migrate(database);
  const repository = new Repository(database);
  await seed(database, repository, config);
  if (officialOnly) await repository.enforceOfficialIntegrationPreference();
  if (config.seedDemo && demoProviderEnabled) await seedDemoData(database, repository, config);
  const encryption = await EncryptionService.create(config);
  const mediaStorage = new MediaStorageService(
    config.mediaStoragePath ?? path.resolve(path.dirname(config.pglitePath), "media")
  );
  await mediaStorage.initialize();

  const app = express();
  const server = createServer(app);
  const realtime = new RealtimeHub(server, config);
  const translation = new TranslationService(repository, encryption, realtime, config);
  const intelligence = new ConversationIntelligenceService(repository, realtime, translation);
  const automation = new AutomationRhythmService(repository, intelligence, config.crmBaseUrl ?? "http://127.0.0.1:4188", config.crmJwtSecret);
  const demo = new DemoProvider(repository, realtime, translation);
  const baileys = new BaileysProvider(repository, encryption, realtime, translation, config);
  const meta = new MetaProvider(repository, encryption, realtime, translation, config, intelligence);
  const providers = new ProviderManager(repository, demo, baileys, meta, demoProviderEnabled, officialOnly);
  const cleanupExpiredMedia = async (): Promise<void> => {
    const expired = await repository.listExpiredMessageMedia();
    for (const item of expired) {
      await mediaStorage.remove(item.storageKey);
      await repository.clearMessageMediaStorage(item.id);
    }
  };
  await cleanupExpiredMedia();
  const mediaCleanupTimer = setInterval(() => {
    void cleanupExpiredMedia().catch(() => undefined);
  }, 60 * 60 * 1_000);
  mediaCleanupTimer.unref();
  await automation.start();
  let shuttingDown = false;
  let closePromise: Promise<void> | null = null;

  const provisionContact = async (input: {
    accountId: string;
    displayName: string;
    phone: string;
    origin: ContactOrigin;
    createCrmContact?: boolean;
    existingCrmContact?: CrmSandboxContact | null;
  }) => {
    if (!isE164PhoneNumber(input.phone)) throw new Error("Invalid E.164 phone number");
    const account = await repository.getAccount(input.accountId);
    if (!account) throw new Error("Account not found");
    const providerContactId = await providers.resolveContactAddress(input.accountId, input.phone);
    if (!providerContactId) throw new Error("Phone number is not registered on WhatsApp");
    let contact = await repository.upsertContact({
      accountId: input.accountId,
      providerContactId,
      displayName: input.displayName,
      phone: input.phone,
      source: account.provider,
      origin: input.origin
    });
    const conversation = await repository.ensureConversationForContact(contact.id);
    let crmContact = input.existingCrmContact ?? null;
    if (input.createCrmContact && !contact.crmContactId) {
      crmContact = await repository.createCrmContact(contact.id);
      realtime.publish("crm.contact.created", input.accountId, crmContact);
      contact = (await repository.getContact(contact.id))!;
    }
    realtime.publish("contact.upserted", input.accountId, contact);
    realtime.publish("conversation.upserted", input.accountId, conversation);
    await repository.audit("contact.provisioned", "contact", contact.id, "success", { origin: input.origin });
    return { contact, conversation, crmContact };
  };

  const assertRoutingAccountsExist = async (input: z.infer<typeof routingRuleSchema>, ownerUserId?: string): Promise<void> => {
    if (!(await repository.getAccount(input.preferredAccountId, ownerUserId))) {
      throw new DomainError("ROUTING_ACCOUNT_NOT_FOUND", 404, "Preferred routing account not found");
    }
    if (input.fallbackAccountId && !(await repository.getAccount(input.fallbackAccountId, ownerUserId))) {
      throw new DomainError("ROUTING_ACCOUNT_NOT_FOUND", 404, "Fallback routing account not found");
    }
  };

  app.use((request, response, next) => {
    const requestId = inboundRequestId(request);
    const startedAt = process.hrtime.bigint();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info(
        {
          requestId,
          method: request.method,
          path: safeRequestPath(request),
          statusCode: response.statusCode,
          durationMs: Math.round(durationMs * 10) / 10
        },
        "request completed"
      );
    });
    next();
  });
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.get(
    "/api/webhooks/meta/:webhookKey",
    asyncRoute(async (request, response) => {
      const mode = typeof request.query["hub.mode"] === "string" ? request.query["hub.mode"] : "";
      const token = typeof request.query["hub.verify_token"] === "string" ? request.query["hub.verify_token"] : "";
      const challenge = typeof request.query["hub.challenge"] === "string" ? request.query["hub.challenge"] : "";
      if (!challenge || !(await meta.verifyWebhookSubscription(routeParam(request.params.webhookKey), mode, token))) {
        response.status(403).type("text/plain").send("Verification failed");
        return;
      }
      response.status(200).type("text/plain").send(challenge);
    })
  );
  app.post(
    "/api/webhooks/meta/:webhookKey",
    express.raw({ type: "application/json", limit: "2mb" }),
    asyncRoute(async (request, response) => {
      if (!Buffer.isBuffer(request.body)) {
        throw new DomainError("META_WEBHOOK_RAW_BODY_REQUIRED", 400, "Meta webhook requires an application/json body");
      }
      await meta.handleWebhook(
        routeParam(request.params.webhookKey),
        request.header("x-hub-signature-256"),
        request.body
      );
      response.status(200).type("text/plain").send("EVENT_RECEIVED");
    })
  );
  app.use(express.json({ limit: "2mb" }));
  // Every plugin API request must carry the signed CRM session. The identity is
  // derived from the token, never from a user id supplied by the browser.
  app.use("/api/v1", requireCrmAuth(config.crmJwtSecret));

  const ownedAccount = async (request: Request, accountId: string) => {
    const account = await repository.getAccount(accountId, request.crmIdentity!.userId);
    if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    return account;
  };

  const healthDetails = () => ({
    database: database.kind,
    activeConnections: providers.activeConnectionCount(),
    demoProviderEnabled,
    timestamp: new Date().toISOString()
  });
  const respondReady = async (response: Response, legacy = false): Promise<void> => {
    if (shuttingDown) {
      response.status(503).json({ status: "not_ready", ready: false, reason: "shutting_down", ...healthDetails() });
      return;
    }
    try {
      await database.query("SELECT 1 AS ready");
      response.json({ status: legacy ? "ok" : "ready", ready: true, ...healthDetails() });
    } catch (error) {
      logger.warn(
        {
          requestId: response.locals.requestId,
          errorType: error instanceof Error ? error.name : typeof error
        },
        "database readiness check failed"
      );
      response.status(503).json({ status: "not_ready", ready: false, reason: "database_unavailable", ...healthDetails() });
    }
  };

  app.get("/api/health/live", (_request, response) => {
    response.json({ status: "ok", live: true, shuttingDown, ...healthDetails() });
  });
  app.get(
    "/api/health/ready",
    asyncRoute(async (request, response) => {
      await respondReady(response);
    })
  );
  app.get(
    "/api/health",
    asyncRoute(async (_request, response) => {
      await respondReady(response, true);
    })
  );

  app.get("/api/v1/capabilities", (_request, response) => {
    response.json({
      demoProviderEnabled,
      officialOnly,
      providers: {
        demo: demoProviderEnabled,
        baileys: !officialOnly,
        meta: true
      }
    });
  });

  app.get("/api/v1/commercial-readiness", asyncRoute(async (request, response) => {
    const ownerUserId = request.crmIdentity!.userId;
    const [accounts, apps, configurations, providersList, preference, automationSettings, crm, retention] = await Promise.all([
      repository.listAccounts(ownerUserId),
      repository.listMetaApps(ownerUserId),
      repository.listMetaConfigurations(ownerUserId),
      repository.listAiProfiles(ownerUserId),
      repository.getIntegrationPreference(ownerUserId),
      repository.getAutomationSettings(ownerUserId),
      automation.checkCrm(ownerUserId),
      repository.getMediaRetentionPolicy(ownerUserId)
    ]);
    const metaAccounts = accounts.filter((account) => account.provider === "meta");
    const configuredMetaAccountIds = new Set(configurations.map((configuration) => configuration.accountId));
    const connectedMeta = metaAccounts.filter((account) => account.status === "connected" && configuredMetaAccountIds.has(account.id));
    const verifiedMetaConfigurations = configurations.filter((configuration) => Boolean(configuration.lastVerifiedAt));
    const webhookReceived = configurations.some((configuration) => Boolean(configuration.lastWebhookAt));
    const testedProvider = providersList.find((provider) => provider.lastTestStatus === "success");
    const publicOrigin = (() => {
      try {
        const url = new URL(config.webOrigin);
        return url.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      } catch { return false; }
    })();
    const checks: CommercialReadinessCheck[] = [
      { key: "crm_auth", label: "CRM 身份与权限", detail: "当前请求已通过 GoodJob CRM 会话身份验证。", status: "pass", actionView: null },
      { key: "crm_adapter", label: "CRM 待办与站内信通道", detail: crm.ok ? "即刻沟通可以使用当前用户身份访问 CRM。" : crm.error ?? "CRM 连接失败。", status: crm.ok ? "pass" : "blocking", actionView: "diagnostics" },
      { key: "official_strategy", label: "官方通道策略", detail: preference.defaultProvider === "meta" ? "新账号默认使用 Meta 官方通道。" : "当前仍默认创建免费通道账号，正式上线建议切换为官方优先。", status: preference.defaultProvider === "meta" ? "pass" : "warning", actionView: "access" },
      { key: "meta_app", label: "Meta App 密钥", detail: apps.length ? `已加密保存 ${apps.length} 个 Meta App。` : "尚未保存 Meta App、App Secret 与 Verify Token。", status: apps.length ? "pass" : "blocking", actionView: "access" },
      { key: "meta_account", label: "Meta 号码与 Token", detail: configurations.length ? `已配置 ${configurations.length} 个官方号码。` : "尚未绑定 WABA、Phone Number ID 与 Access Token。", status: configurations.length ? "pass" : "blocking", actionView: "access" },
      { key: "meta_connection", label: "Graph API 连接", detail: connectedMeta.length && verifiedMetaConfigurations.length ? `${connectedMeta.length} 个 Meta 账号已配置且最近验证通过。` : "尚无同时完成号码配置与 Graph API 验证的 Meta 官方账号。", status: connectedMeta.length && verifiedMetaConfigurations.length ? "pass" : "blocking", actionView: "accounts" },
      { key: "public_https", label: "公网 HTTPS 回调", detail: publicOrigin ? `${config.webOrigin} 可作为生产 HTTPS Origin。` : "当前 Origin 不是公网 HTTPS 地址，注册 Meta Webhook 前需配置正式域名或安全隧道。", status: publicOrigin ? "pass" : "blocking", actionView: "access" },
      { key: "webhook", label: "真实 Webhook 入站", detail: webhookReceived ? "已收到并验证过 Meta Webhook。" : "尚未收到真实 Meta Webhook，接入后需完成一条测试消息。", status: webhookReceived ? "pass" : "blocking", actionView: "access" },
      { key: "ai_intelligence", label: "客户 AI 深度分析", detail: automationSettings.intelligenceMode === "ai" && testedProvider ? `已使用通过测试的 ${testedProvider.name}。` : testedProvider ? "Provider 已通过测试，可在自动化节奏中启用 AI 深度分析。" : "当前使用规则分析；商业使用前建议配置并测试 AI Provider。", status: automationSettings.intelligenceMode === "ai" && testedProvider ? "pass" : "warning", actionView: automationSettings.intelligenceMode === "ai" ? "ai" : "automation" },
      { key: "automation", label: "周期分析与每日通知", detail: automationSettings.enabled ? `自动运行已启用，最近状态：${automationSettings.lastRunStatus}。` : "自动化已暂停，不会周期分析或生成每日待办。", status: automationSettings.enabled && automationSettings.lastRunStatus !== "failed" ? "pass" : "blocking", actionView: "automation" },
      { key: "production_database", label: "即刻沟通生产数据库", detail: database.kind === "mysql" ? "即刻沟通已运行在目标 MySQL 数据库。" : `当前使用 ${database.kind}，仅适合本地验证，商业运行必须切换至 MySQL。`, status: database.kind === "mysql" ? "pass" : "blocking", actionView: "diagnostics" },
      { key: "retention", label: "附件数据保留", detail: retention.mode === "immediate" ? "附件发送后立即清理本地副本。" : `附件本地副本保留 ${retention.days} 天。`, status: "pass", actionView: "accounts" }
    ];
    const registrationKeys = new Set(["crm_auth", "crm_adapter", "meta_app", "meta_account", "meta_connection", "public_https"]);
    response.json({
      readyForMetaRegistration: checks.filter((check) => registrationKeys.has(check.key)).every((check) => check.status !== "blocking"),
      readyForCommercialUse: checks.every((check) => check.status !== "blocking"),
      checkedAt: new Date().toISOString(),
      checks
    });
  }));

  app.get(
    "/api/v1/integration/preference",
    asyncRoute(async (request, response) => {
      response.json(await repository.getIntegrationPreference(request.crmIdentity!.userId));
    })
  );
  app.put(
    "/api/v1/integration/preference",
    asyncRoute(async (request, response) => {
      const input = integrationPreferenceSchema.parse(request.body);
      if (officialOnly && (input.strategy === "free_first" || input.defaultProvider === "baileys")) {
        throw new DomainError(
          "UNOFFICIAL_PROVIDER_DISABLED",
          403,
          "This runtime accepts official WhatsApp channels only; use Meta as the default provider"
        );
      }
      const preference = await repository.updateIntegrationPreference(input, request.crmIdentity!.userId);
      await repository.audit("integration.preference.updated", "integration", "default", "success", preference);
      realtime.publish("integration.preference.changed", null, preference);
      response.json(preference);
    })
  );

  app.get(
    "/api/v1/meta/apps",
    asyncRoute(async (request, response) => {
      response.json(await repository.listMetaApps(request.crmIdentity!.userId));
    })
  );
  app.post(
    "/api/v1/meta/apps",
    asyncRoute(async (request, response) => {
      const input = metaAppSchema.parse(request.body);
      if (await repository.getMetaAppByAppId(input.appId, request.crmIdentity!.userId)) {
        throw new DomainError("META_APP_EXISTS", 409, "A Meta App configuration with this App ID already exists");
      }
      const appConfig = await repository.createMetaApp({
        name: input.name,
        appId: input.appId,
        appSecretCipher: encryption.encrypt(input.appSecret),
        appSecretMask: secretMask(input.appSecret),
        verifyTokenDigest: createHash("sha256").update(input.verifyToken, "utf8").digest("hex"),
        verifyTokenMask: secretMask(input.verifyToken),
        webhookKey: randomBytes(24).toString("base64url"),
        ownerUserId: request.crmIdentity!.userId
      });
      await repository.audit("meta.app.created", "meta_app", appConfig.id, "success", { appId: input.appId });
      response.status(201).json(appConfig);
    })
  );
  app.get(
    "/api/v1/meta/configurations",
    asyncRoute(async (request, response) => {
      response.json(await repository.listMetaConfigurations(request.crmIdentity!.userId));
    })
  );

  app.get(
    "/api/v1/accounts",
    asyncRoute(async (request, response) => {
      response.json(await repository.listAccounts(request.crmIdentity!.userId));
    })
  );
  app.post(
    "/api/v1/accounts",
    asyncRoute(async (request, response) => {
      const input = accountSchema.parse(request.body);
      if (input.provider === "demo" && !demoProviderEnabled) {
        throw new DomainError("DEMO_PROVIDER_DISABLED", 403, "Demo Provider is disabled in this environment");
      }
      if (input.provider === "baileys" && officialOnly) {
        throw new DomainError(
          "UNOFFICIAL_PROVIDER_DISABLED",
          403,
          "Baileys account creation is disabled because this runtime accepts official WhatsApp channels only"
        );
      }
      if (input.provider === "baileys" && !input.riskAccepted) {
        response.status(400).json({ error: "创建 Baileys 账号前必须确认非官方通道风险" });
        return;
      }
      const account = await repository.createAccount({ ...input, ownerUserId: request.crmIdentity!.userId });
      realtime.registerAccountOwner(account.id, request.crmIdentity!.userId);
      await repository.audit("account.created", "account", account.id, "success", { provider: account.provider });
      response.status(201).json(account);
    })
  );
  app.get(
    "/api/v1/accounts/:id/meta",
    asyncRoute(async (request, response) => {
      await ownedAccount(request, routeParam(request.params.id));
      const configuration = await repository.getMetaConfiguration(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!configuration) {
        response.status(404).json({ error: "Meta configuration not found" });
        return;
      }
      response.json(configuration);
    })
  );
  app.put(
    "/api/v1/accounts/:id/meta",
    asyncRoute(async (request, response) => {
      const accountId = routeParam(request.params.id);
      const account = await ownedAccount(request, accountId);
      if (account.provider !== "meta") {
        throw new DomainError("ACCOUNT_PROVIDER_MISMATCH", 409, "Only Meta accounts can store Meta configuration");
      }
      const input = metaConfigurationSchema.parse(request.body);
      if (!(await repository.getMetaApp(input.appConfigId, request.crmIdentity!.userId))) {
        throw new DomainError("META_APP_NOT_FOUND", 404, "Meta App configuration not found");
      }
      const existingPhoneConfiguration = await repository.getMetaCredentialByPhoneNumberId(input.phoneNumberId);
      if (existingPhoneConfiguration && existingPhoneConfiguration.accountId !== accountId) {
        throw new DomainError(
          "META_PHONE_NUMBER_IN_USE",
          409,
          "This Meta Phone Number ID is already assigned to another account"
        );
      }
      if (account.status === "connected") await meta.disconnect(accountId);
      const configuration = await repository.upsertMetaConfiguration({
        accountId,
        appConfigId: input.appConfigId,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        accessTokenCipher: encryption.encrypt(input.accessToken),
        accessTokenMask: secretMask(input.accessToken),
        graphApiVersion: input.graphApiVersion
      });
      await repository.updateAccountStatus(accountId, "unconfigured");
      await repository.audit("meta.configuration.updated", "account", accountId, "success", {
        appConfigId: input.appConfigId,
        phoneNumberId: input.phoneNumberId,
        graphApiVersion: input.graphApiVersion
      });
      response.json(configuration);
    })
  );
  app.post(
    "/api/v1/accounts/:id/connect",
    asyncRoute(async (request, response) => {
      const accountId = routeParam(request.params.id);
      await ownedAccount(request, accountId);
      await providers.connect(accountId);
      response.status(202).json(await repository.getAccount(accountId));
    })
  );
  app.post(
    "/api/v1/accounts/:id/logout",
    asyncRoute(async (request, response) => {
      const accountId = routeParam(request.params.id);
      await ownedAccount(request, accountId);
      await providers.disconnect(accountId, true);
      await repository.audit("account.logout", "account", accountId, "success");
      response.json(await repository.getAccount(accountId));
    })
  );
  app.delete(
    "/api/v1/accounts/:id",
    asyncRoute(async (request, response) => {
      const account = await ownedAccount(request, routeParam(request.params.id));
      if (!account) {
        response.status(404).json({ error: "Account not found" });
        return;
      }
      const routingReferences = await repository.countRoutingReferences(account.id);
      if (routingReferences > 0) {
        response.status(409).json({
          error: "Account is referenced by routing rules; update or delete those rules before removing the account",
          routingReferences
        });
        return;
      }
      if (!["unconfigured", "logged_out"].includes(account.status)) {
        await providers.disconnect(account.id, true);
      }
      await repository.deleteAccount(account.id);
      response.status(204).end();
    })
  );
  app.post(
    "/api/v1/accounts/:id/sync/contacts",
    asyncRoute(async (request, response) => {
      const accountId = routeParam(request.params.id);
      await ownedAccount(request, accountId);
      response.status(202).json(await providers.syncContacts(accountId));
    })
  );

  app.get(
    "/api/v1/contacts",
    asyncRoute(async (request, response) => {
      const accountId = typeof request.query.accountId === "string" ? request.query.accountId : undefined;
      if (accountId) await ownedAccount(request, accountId);
      response.json(await repository.listContacts(accountId, request.crmIdentity!.userId));
    })
  );
  app.post(
    "/api/v1/contacts",
    asyncRoute(async (request, response) => {
      const input = manualContactSchema.parse(request.body);
      await ownedAccount(request, input.accountId);
      response.status(201).json(
        await provisionContact({
          accountId: input.accountId,
          displayName: input.displayName,
          phone: input.phone,
          origin: "manual",
          createCrmContact: input.createCrmContact
        })
      );
    })
  );
  app.post(
    "/api/v1/contacts/:id/conversation",
    asyncRoute(async (request, response) => {
      const contact = await repository.getContact(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!contact) {
        response.status(404).json({ error: "Contact not found" });
        return;
      }
      const conversation = await repository.ensureConversationForContact(contact.id);
      realtime.publish("conversation.upserted", contact.accountId, conversation);
      response.status(201).json(conversation);
    })
  );
  app.get(
    "/api/v1/conversations",
    asyncRoute(async (request, response) => {
      const accountId = typeof request.query.accountId === "string" ? request.query.accountId : undefined;
      if (accountId) await ownedAccount(request, accountId);
      response.json(await repository.listConversations(accountId, request.crmIdentity!.userId));
    })
  );
  app.post("/api/v1/imports/whatsapp-text/preview", asyncRoute(async (request, response) => {
    const input = z.object({
      content: z.string().min(1).max(1_500_000),
      dateOrder: z.enum(["dmy", "mdy"]).default("dmy")
    }).parse(request.body);
    const preview = previewWhatsAppHistory(input.content, input.dateOrder);
    if (!preview.messageCount) throw new DomainError("WHATSAPP_HISTORY_EMPTY", 422, "没有识别到 WhatsApp 聊天消息，请检查导出格式和日期顺序");
    response.json(preview);
  }));
  app.post("/api/v1/imports/whatsapp-text", asyncRoute(async (request, response) => {
    const input = z.object({
      accountId: z.string().uuid(),
      phone: z.string().trim(),
      displayName: z.string().trim().min(1).max(180),
      customerSender: z.string().trim().min(1).max(180),
      content: z.string().min(1).max(1_500_000),
      dateOrder: z.enum(["dmy", "mdy"]).default("dmy")
    }).parse(request.body);
    if (!isE164PhoneNumber(input.phone)) throw new DomainError("PHONE_INVALID", 400, "客户号码必须使用 E.164 格式，例如 +491234567890");
    const account = await ownedAccount(request, input.accountId);
    const parsed = parseWhatsAppHistory(input.content, input.dateOrder);
    if (!parsed.messages.length) throw new DomainError("WHATSAPP_HISTORY_EMPTY", 422, "没有识别到可导入的聊天消息");
    if (!parsed.messages.some((message) => message.sender === input.customerSender)) throw new DomainError("WHATSAPP_HISTORY_SENDER_NOT_FOUND", 422, "所选客户名称不存在于导出记录中");
    const contact = await repository.upsertContact({
      accountId: account.id,
      providerContactId: `history:${input.phone.replace(/\D/gu, "")}`,
      displayName: input.displayName,
      phone: input.phone,
      source: account.provider,
      origin: "history_import"
    });
    const conversation = await repository.ensureConversationForContact(contact.id);
    let imported = 0;
    let duplicates = 0;
    for (const message of parsed.messages) {
      const providerMessageId = historyMessageId({ accountId: account.id, phone: input.phone, message });
      if (await repository.findMessageByIdempotency(account.id, providerMessageId)) {
        duplicates += 1;
        continue;
      }
      await repository.createMessage({
        accountId: account.id,
        conversationId: conversation.id,
        providerMessageId,
        direction: message.sender === input.customerSender ? "inbound" : "outbound",
        body: message.body,
        status: "read",
        occurredAt: message.occurredAt
      });
      imported += 1;
    }
    await repository.markConversationRead(conversation.id);
    const intelligenceResult = await intelligence.analyzeConversation(conversation.id);
    realtime.publish("contact.upserted", account.id, contact);
    realtime.publish("conversation.upserted", account.id, await repository.getConversation(conversation.id));
    await repository.audit("whatsapp.history.imported", "conversation", conversation.id, "success", { imported, duplicates, parsed: parsed.messages.length });
    response.status(201).json({ contact, conversation: await repository.getConversation(conversation.id), imported, duplicates, parsed: parsed.messages.length, analysis: intelligenceResult.analysis });
  }));
  app.get(
    "/api/v1/conversations/:id/messages",
    asyncRoute(async (request, response) => {
      const conversation = await repository.getConversation(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!conversation) {
        response.status(404).json({ error: "Conversation not found" });
        return;
      }
      await repository.markConversationRead(conversation.id);
      response.json(await repository.listMessages(conversation.id, request.crmIdentity!.userId));
    })
  );
  app.get(
    "/api/v1/conversations/:id/intelligence",
    asyncRoute(async (request, response) => {
      const conversationId = routeParam(request.params.id);
      const conversation = await repository.getConversation(conversationId, request.crmIdentity!.userId);
      if (!conversation) throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      response.json(await intelligence.getConversationIntelligence(conversationId, request.crmIdentity!.userId));
    })
  );
  app.get("/api/v1/automation/settings", asyncRoute(async (request, response) => {
    response.json(await automation.get(request.crmIdentity!.userId));
  }));
  app.put("/api/v1/automation/settings", asyncRoute(async (request, response) => {
    const input = z.object({
      analysisIntervalHours: z.number().int().min(1).max(168),
      intelligenceMode: z.enum(["rules", "ai"]),
      intelligenceProviderId: z.string().uuid().nullable(),
      dailyTodoHour: z.number().int().min(0).max(23),
      dailyTodoMinute: z.number().int().min(0).max(59),
      timezone: z.string().trim().min(1).max(64),
      enabled: z.boolean()
    }).parse(request.body);
    if (input.intelligenceMode === "ai") {
      if (!input.intelligenceProviderId) throw new DomainError("INTELLIGENCE_PROVIDER_REQUIRED", 409, "AI 深度分析需要选择 Provider");
      if (!(await repository.getAiProfile(input.intelligenceProviderId, request.crmIdentity!.userId))) {
        throw new DomainError("AI_PROVIDER_NOT_FOUND", 404, "AI Provider not found");
      }
    }
    response.json(await automation.update(request.crmIdentity!.userId, input));
  }));
  app.post("/api/v1/automation/run", asyncRoute(async (request, response) => {
    response.json(await automation.runNow(request.crmIdentity!.userId));
  }));
  app.get("/api/v1/automation/runs", asyncRoute(async (request, response) => {
    const limit = typeof request.query.limit === "string" ? Number(request.query.limit) : 12;
    response.json(await repository.listAutomationRuns(request.crmIdentity!.userId, Number.isFinite(limit) ? limit : 12));
  }));
  app.get("/api/v1/automation/deliveries", asyncRoute(async (request, response) => {
    const limit = Number(request.query.limit ?? 30);
    response.json(await repository.listAutomationDeliveries(request.crmIdentity!.userId, Number.isFinite(limit) ? limit : 30));
  }));
  app.post(
    "/api/v1/conversations/:id/intelligence/analyze",
    asyncRoute(async (request, response) => {
      const conversationId = routeParam(request.params.id);
      const conversation = await repository.getConversation(conversationId, request.crmIdentity!.userId);
      if (!conversation) throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      const result = await intelligence.analyzeConversation(conversationId);
      await repository.audit("conversation.analysis.generated", "conversation", conversationId, "success", {
        sourceMessageCount: result.analysis.sourceMessageCount,
        followupCount: result.followups.length
      });
      response.json(result);
    })
  );
  app.put("/api/v1/conversations/:id/intelligence/feedback", asyncRoute(async (request, response) => {
    const conversationId = routeParam(request.params.id);
    const conversation = await repository.getConversation(conversationId, request.crmIdentity!.userId);
    if (!conversation) throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
    const input = z.object({ traitKey: z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/i), traitLabel: z.string().trim().min(1).max(180), verdict: z.enum(["confirmed", "rejected"]), correctionText: z.string().trim().max(500).optional() }).parse(request.body);
    await repository.saveConversationTraitFeedback({ conversationId, ...input, actorUserId: request.crmIdentity!.userId });
    await intelligence.analyzeConversation(conversationId);
    await repository.audit("conversation.trait.feedback", "conversation", conversationId, "success", { traitKey: input.traitKey, verdict: input.verdict });
    response.json(await intelligence.getConversationIntelligence(conversationId, request.crmIdentity!.userId));
  }));
  app.delete("/api/v1/conversations/:id/intelligence/feedback/:traitKey", asyncRoute(async (request, response) => {
    const conversationId = routeParam(request.params.id);
    const conversation = await repository.getConversation(conversationId, request.crmIdentity!.userId);
    if (!conversation) throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
    const deleted = await repository.deleteConversationTraitFeedback(conversationId, routeParam(request.params.traitKey), request.crmIdentity!.userId);
    if (!deleted) throw new DomainError("TRAIT_FEEDBACK_NOT_FOUND", 404, "Trait feedback not found");
    await repository.restoreConversationFollowupsByTraitKey(conversationId, routeParam(request.params.traitKey));
    await intelligence.analyzeConversation(conversationId);
    await repository.audit("conversation.trait.feedback.removed", "conversation", conversationId, "success", { traitKey: routeParam(request.params.traitKey) });
    response.json(await intelligence.getConversationIntelligence(conversationId, request.crmIdentity!.userId));
  }));
  app.patch(
    "/api/v1/followups/:id",
    asyncRoute(async (request, response) => {
      const input = z.object({ status: z.enum(["pending", "completed", "dismissed"]) }).parse(request.body);
      const followup = await repository.updateConversationFollowupStatus(routeParam(request.params.id), input.status, request.crmIdentity!.userId);
      if (!followup) throw new DomainError("FOLLOWUP_NOT_FOUND", 404, "Follow-up item not found");
      await repository.audit("conversation.followup.updated", "followup", followup.id, "success", { status: followup.status });
      response.json(followup);
    })
  );
  app.post(
    "/api/v1/conversations/:id/messages",
    asyncRoute(async (request, response) => {
      const input = messageSchema.parse(request.body);
      const conversation = await repository.getConversation(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!conversation) {
        const visibleConversation = await repository.getConversation(routeParam(request.params.id));
        if (visibleConversation && visibleConversation.accountId !== input.accountId) {
          throw new DomainError("ACCOUNT_MISMATCH", 409, "Selected account does not own this conversation");
        }
        throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      }
      if (conversation.accountId !== input.accountId) throw new DomainError("ACCOUNT_MISMATCH", 409, "Selected account does not own this conversation");
      const message = await providers.sendMessage({ ...input, conversationId: routeParam(request.params.id) });
      response.status(201).json(message);
    })
  );
  app.post(
    "/api/v1/conversations/:id/media",
    express.raw({ type: () => true, limit: MEDIA_UPLOAD_LIMIT }),
    asyncRoute(async (request, response) => {
      if (!Buffer.isBuffer(request.body)) throw new DomainError("MEDIA_BODY_REQUIRED", 400, "附件内容不能为空");
      const input = mediaUploadSchema.parse(request.query);
      const conversation = await repository.getConversation(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!conversation || conversation.accountId !== input.accountId) throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      validateMediaUpload(input, request.body.byteLength);
      let message = await providers.sendMedia({
        ...input,
        conversationId: routeParam(request.params.id),
        buffer: request.body
      });
      const policy = await repository.getMediaRetentionPolicy(request.crmIdentity!.userId);
      if (policy.mode === "days") {
        const storageKey = await mediaStorage.save(request.body, input.fileName);
        const expiresAt = new Date(Date.now() + policy.days * 86_400_000).toISOString();
        message = await repository.updateMessageMediaStorage(message.id, storageKey, expiresAt);
      }
      await repository.audit("message.media.sent", "message", message.id, "success", {
        kind: input.kind,
        sizeBytes: request.body.byteLength,
        retained: policy.mode === "days",
        retentionDays: policy.days
      });
      response.status(201).json(message);
    })
  );
  app.post(
    "/api/v1/messages/:id/revoke",
    asyncRoute(async (request, response) => {
      const body = z.object({ accountId: z.string().uuid() }).parse(request.body);
      await ownedAccount(request, body.accountId);
      const message = await repository.getMessage(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!message || message.accountId !== body.accountId) throw new DomainError("MESSAGE_NOT_FOUND", 404, "Message not found");
      const storage = await repository.getMessageMediaStorage(routeParam(request.params.id));
      const revoked = await providers.revokeMessage(body.accountId, routeParam(request.params.id));
      if (storage) await mediaStorage.remove(storage.storageKey);
      await repository.audit("message.revoked", "message", revoked.id, "success", { accountId: body.accountId });
      response.json(revoked);
    })
  );
  app.get(
    "/api/v1/messages/:id/media",
    asyncRoute(async (request, response) => {
      const messageId = routeParam(request.params.id);
      if (!(await repository.getMessage(messageId, request.crmIdentity!.userId))) {
        throw new DomainError("MESSAGE_NOT_FOUND", 404, "Message not found");
      }
      const storage = await repository.getMessageMediaStorage(messageId);
      if (!storage) throw new DomainError("MEDIA_NOT_AVAILABLE", 410, "附件本地副本已清理");
      response.type(storage.mimeType);
      response.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(storage.fileName)}`);
      await new Promise<void>((resolve, reject) => {
        response.sendFile(mediaStorage.resolve(storage.storageKey), (error) => error ? reject(error) : resolve());
      }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          await repository.clearMessageMediaStorage(messageId);
          throw new DomainError("MEDIA_NOT_AVAILABLE", 410, "附件本地副本已清理");
        }
        throw error;
      });
    })
  );
  app.get("/api/v1/media-retention", asyncRoute(async (request, response) => {
    response.json(await repository.getMediaRetentionPolicy(request.crmIdentity!.userId));
  }));
  app.put("/api/v1/media-retention", asyncRoute(async (request, response) => {
    const input = mediaRetentionSchema.parse(request.body);
    const policy = await repository.updateMediaRetentionPolicy(input.mode, input.days, request.crmIdentity!.userId);
    await repository.audit("media.retention.updated", "media_retention", request.crmIdentity!.userId, "success", policy);
    response.json(policy);
  }));
  app.post(
    "/api/v1/conversations/:id/template-messages",
    asyncRoute(async (request, response) => {
      const input = templateMessageSchema.parse(request.body);
      const conversation = await repository.getConversation(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!conversation || conversation.accountId !== input.accountId) throw new DomainError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      const message = await providers.sendTemplateMessage({
        ...input,
        conversationId: routeParam(request.params.id)
      });
      response.status(201).json(message);
    })
  );

  app.get(
    "/api/v1/translation/preferences",
    asyncRoute(async (request, response) => {
      response.json(await repository.getTranslationPreference(request.crmIdentity!.userId));
    })
  );
  app.put(
    "/api/v1/translation/preferences",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          autoTranslate: z.boolean().optional(),
          targetLanguage: z.string().trim().min(2).max(20).optional(),
          providerId: z.string().uuid().nullable().optional(),
          crmAutoCreate: z.boolean().optional()
        })
        .parse(request.body);
      const current = await repository.getTranslationPreference(request.crmIdentity!.userId);
      const nextProviderId = input.providerId === undefined ? current.providerId : input.providerId;
      const nextAutoTranslate = input.autoTranslate ?? current.autoTranslate;
      if (input.providerId && !(await repository.getAiProfile(input.providerId, request.crmIdentity!.userId))) {
        throw new DomainError("AI_PROVIDER_NOT_FOUND", 404, "AI Provider not found");
      }
      if (nextAutoTranslate && !nextProviderId) {
        throw new DomainError("AI_PROVIDER_REQUIRED", 409, "An AI Provider is required before automatic translation can be enabled");
      }
      const preference = await repository.updateTranslationPreference(input, request.crmIdentity!.userId);
      realtime.publish("translation.preference.changed", null, preference);
      response.json(preference);
    })
  );
  app.post(
    "/api/v1/messages/:id/translations",
    asyncRoute(async (request, response) => {
      if (!(await repository.getMessage(routeParam(request.params.id), request.crmIdentity!.userId))) {
        throw new DomainError("MESSAGE_NOT_FOUND", 404, "Message not found");
      }
      const translationResult = await translation.translate(routeParam(request.params.id), "manual");
      response.status(translationResult ? 201 : 204);
      if (translationResult) response.json(translationResult);
      else response.end();
    })
  );

  app.get(
    "/api/v1/ai/providers",
    asyncRoute(async (request, response) => {
      response.json(await repository.listAiProfiles(request.crmIdentity!.userId));
    })
  );
  app.post(
    "/api/v1/ai/providers",
    asyncRoute(async (request, response) => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(80),
          baseUrl: z.string().url(),
          apiKey: z.string().min(1).max(500),
          model: z.string().trim().min(1).max(120)
        })
        .parse(request.body);
      const profile = await repository.createAiProfile({
        name: input.name,
        kind: "openai",
        baseUrl: input.baseUrl,
        apiKeyCipher: encryption.encrypt(input.apiKey),
        apiKeyMask: `****${input.apiKey.slice(-4)}`,
        model: input.model,
        ownerUserId: request.crmIdentity!.userId
      });
      const preference = await repository.getTranslationPreference(request.crmIdentity!.userId);
      if (!preference.providerId) {
        const updatedPreference = await repository.updateTranslationPreference({ providerId: profile.id }, request.crmIdentity!.userId);
        realtime.publish("translation.preference.changed", null, updatedPreference);
      }
      response.status(201).json(profile);
    })
  );
  app.post(
    "/api/v1/ai/providers/:id/test",
    asyncRoute(async (request, response) => {
      const result = await translation.testProvider(routeParam(request.params.id));
      response.status(result.ok ? 200 : 422).json(result);
    })
  );
  app.delete(
    "/api/v1/ai/providers/:id",
    asyncRoute(async (request, response) => {
      const id = routeParam(request.params.id);
      const profile = await repository.getAiProfile(id, request.crmIdentity!.userId);
      if (!profile) throw new DomainError("AI_PROVIDER_NOT_FOUND", 404, "AI Provider not found");
      const preference = await repository.getTranslationPreference(request.crmIdentity!.userId);
      if (preference.providerId === id) {
        const updatedPreference = await repository.updateTranslationPreference({
          autoTranslate: false,
          providerId: null
        }, request.crmIdentity!.userId);
        realtime.publish("translation.preference.changed", null, updatedPreference);
      }
      if (!(await repository.deleteAiProfile(id, request.crmIdentity!.userId))) {
        throw new DomainError("AI_PROVIDER_NOT_FOUND", 404, "AI Provider not found");
      }
      await repository.audit("ai.provider.deleted", "ai_provider", id, "success", {
        wasDefault: preference.providerId === id
      });
      response.status(204).end();
    })
  );

  app.get(
    "/api/v1/routing/rules",
    asyncRoute(async (request, response) => {
      response.json(await repository.listRoutingRules(request.crmIdentity!.userId));
    })
  );
  app.post(
    "/api/v1/routing/rules",
    asyncRoute(async (request, response) => {
      const input = routingRuleSchema.parse(request.body);
      await assertRoutingAccountsExist(input, request.crmIdentity!.userId);
      const rule = await repository.createRoutingRule({ ...input, ownerUserId: request.crmIdentity!.userId });
      await repository.audit("routing.rule.created", "routing_rule", rule.id, "success");
      response.status(201).json(rule);
    })
  );
  app.put(
    "/api/v1/routing/rules/:id",
    asyncRoute(async (request, response) => {
      const id = routeParam(request.params.id);
      const input = routingRuleSchema.parse(request.body);
      await assertRoutingAccountsExist(input, request.crmIdentity!.userId);
      const rule = await repository.updateRoutingRule(id, input, request.crmIdentity!.userId);
      if (!rule) throw new DomainError("ROUTING_RULE_NOT_FOUND", 404, "Routing rule not found");
      await repository.audit("routing.rule.updated", "routing_rule", id, "success", {
        preferredAccountId: input.preferredAccountId,
        fallbackAccountId: input.fallbackAccountId
      });
      response.json(rule);
    })
  );
  app.delete(
    "/api/v1/routing/rules/:id",
    asyncRoute(async (request, response) => {
      const id = routeParam(request.params.id);
      if (!(await repository.deleteRoutingRule(id, request.crmIdentity!.userId))) {
        throw new DomainError("ROUTING_RULE_NOT_FOUND", 404, "Routing rule not found");
      }
      await repository.audit("routing.rule.deleted", "routing_rule", id, "success");
      response.status(204).end();
    })
  );
  app.post(
    "/api/v1/routing/resolve",
    asyncRoute(async (request, response) => {
      const input = z.object({ leadType: z.string().default(""), region: z.string().default("") }).parse(request.body);
      response.json(await repository.resolveRouting(input.leadType, input.region, request.crmIdentity!.userId));
    })
  );

  app.get(
    "/api/v1/crm/contacts",
    asyncRoute(async (request, response) => {
      response.json(await repository.listCrmContacts(request.crmIdentity!.userId));
    })
  );
  app.post(
    "/api/v1/crm/contacts/:id/import",
    asyncRoute(async (request, response) => {
      const input = z.object({
        accountId: z.string().uuid(),
        externalContact: z.object({
          id: z.string().trim().min(1).max(191),
          name: z.string().trim().min(1).max(120),
          phone: z.string().trim().regex(E164_PHONE_PATTERN)
        }).optional()
      }).parse(request.body);
      await ownedAccount(request, input.accountId);
      const crmContact = input.externalContact
        ? {
            id: input.externalContact.id,
            phone: input.externalContact.phone,
            name: input.externalContact.name,
            source: "goodjob_crm",
            sourceContactId: input.externalContact.id,
            createdAt: new Date().toISOString()
          }
        : await repository.getCrmContact(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!crmContact) {
        response.status(404).json({ error: "CRM contact not found" });
        return;
      }
      const provisioned = await provisionContact({
        accountId: input.accountId,
        displayName: crmContact.name,
        phone: crmContact.phone,
        origin: "crm_import",
        existingCrmContact: crmContact
      });
      if (input.externalContact) {
        const linked = await repository.upsertExternalCrmContact(provisioned.contact.id, input.externalContact);
        response.status(201).json({ ...provisioned, contact: (await repository.getContact(provisioned.contact.id, request.crmIdentity!.userId))!, crmContact: linked });
        return;
      }
      response.status(201).json(provisioned);
    })
  );
  app.post(
    "/api/v1/contacts/:id/crm-create",
    asyncRoute(async (request, response) => {
      const contact = await repository.getContact(routeParam(request.params.id), request.crmIdentity!.userId);
      if (!contact) throw new DomainError("CONTACT_NOT_FOUND", 404, "Contact not found");
      const crmContact = await repository.createCrmContact(contact.id);
      realtime.publish("crm.contact.created", null, crmContact);
      response.status(201).json(crmContact);
    })
  );

  if (demoProviderEnabled) {
    app.post(
      "/api/v1/demo/inbound",
      asyncRoute(async (request, response) => {
        const input = z
          .object({
            accountId: z.string().uuid(),
            displayName: z.string().trim().min(1).max(80),
            phone: z.string().trim().regex(E164_PHONE_PATTERN, "Phone must use strict E.164 format"),
            body: z.string().trim().min(1).max(10_000)
          })
          .parse(request.body);
        await ownedAccount(request, input.accountId);
        response.status(201).json(await demo.simulateInbound(input));
      })
    );
  }

  if (config.nodeEnv === "production") {
    const webRoot = path.resolve(process.cwd(), "dist");
    app.use(express.static(webRoot));
    app.use((request, response, next) => {
      if (request.method === "GET" && !request.path.startsWith("/api/")) {
        response.sendFile(path.join(webRoot, "index.html"));
        return;
      }
      next();
    });
  }

  app.use((_request, response) => {
    response.status(404).json({
      error: "Route not found",
      code: "ROUTE_NOT_FOUND",
      requestId: response.locals.requestId
    });
  });
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const requestId = response.locals.requestId as string;
    if (error instanceof DomainError) {
      response.status(error.httpStatus).json({ error: error.message, code: error.code, requestId });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST", details: error.flatten(), requestId });
      return;
    }
    if ((error as { type?: string }).type === "entity.too.large") {
      response.status(413).json({ error: "附件不能超过 25MB", code: "MEDIA_TOO_LARGE", requestId });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    const status = message.includes("not found")
      ? 404
      : message.includes("not registered")
        ? 422
        : message.includes("reserved for the optional official integration phase")
          ? 501
      : message.includes("not match") || message.includes("not connected")
          ? 409
          : message.includes("Invalid E.164")
            ? 400
            : 500;
    if (status >= 500) {
      logger.error(
        {
          requestId,
          method: request.method,
          path: safeRequestPath(request),
          errorType: error instanceof Error ? error.name : typeof error
        },
        "unhandled request error"
      );
      response.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR", requestId });
      return;
    }
    response.status(status).json({ error: message, requestId });
  });

  const accounts = await repository.listAccounts();
  for (const account of accounts) realtime.registerAccountOwner(account.id, account.ownerUserId);
  const recoveredMetaWebhooks = await meta.recoverPendingWebhookEvents();
  if (recoveredMetaWebhooks.failed > 0) {
    logger.warn({ recoveredMetaWebhooks }, "some Meta webhook events remain failed after startup recovery");
  }
  await Promise.all(
    accounts.map(async (account) => {
      if (demoProviderEnabled && account.provider === "demo" && account.status === "connected") await demo.connect(account.id);
      if (!officialOnly && account.provider === "baileys" && !["unconfigured", "logged_out"].includes(account.status)) {
        void baileys.connect(account.id).catch((error) => {
          logger.warn(
            { accountId: account.id, provider: "baileys", errorType: error instanceof Error ? error.name : typeof error },
            "provider restore failed"
          );
        });
      }
      if (account.provider === "meta" && account.status === "connected") {
        void meta.connect(account.id).catch((error) => {
          logger.warn(
            { accountId: account.id, provider: "meta", errorType: error instanceof Error ? error.name : typeof error },
            "provider restore failed"
          );
        });
      }
    })
  );

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    shuttingDown = true;
    clearInterval(mediaCleanupTimer);
    closePromise = (async () => {
      const httpClose = beginHttpClose(server);
      try {
        await automation.close();
        await realtime.close();
        await httpClose;
      } finally {
        try {
          await providers.shutdown();
        } finally {
          await database.close();
        }
      }
    })();
    return closePromise;
  };

  return {
    app,
    server,
    database,
    repository,
    providers,
    translation,
    close
  };
}
