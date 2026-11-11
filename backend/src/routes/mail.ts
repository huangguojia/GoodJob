/**
 * 邮件追踪、外发邮件、发件邮箱池、邮件中心、个人邮箱绑定与收信、开发信路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canSeeOwner, requireAuth } from "../auth.js";
import { aggregateReplyStats } from "../development-email-reply-stats.js";
import { callAiModel, extractJsonObject } from "../ai-model-runtime.js";
import { buildOutreachJourney, getBackgroundResearchRepository, type OutreachJourneyEntityType } from "../outreach-journey.js";
import { assembleDevelopmentEmailBrief, buildDevelopmentEmailFallback, buildDevelopmentEmailPrompt, checkDevelopmentEmailDraft, developmentEmailMarketName, developmentEmailSignature, developmentEmailStagePlan, ensureDevelopmentEmailSignature, finalizePersonalization } from "../development-email-skill.js";
import { EMAIL_ENGINE_SOURCES, readTeamAiEngineSettings, resolveEngineSource } from "../ai-engine-settings.js";
import { buildEmailCliPrompt } from "../ai-engine-prompts.js";
import { getSenderMailboxRepository, senderMailboxOverrides, toSenderMailboxView } from "../sender-mailbox.js";
import { buildContactIndex, buildMailAssistPrompt, buildMailPersonalizePrompt, FOLDER_LABELS, getMailCenterRepository, getMailCenterSyncService, isMailAssistAction, journeyCounterpartAddress, journeyCounterpartName, journeyStats, mailAccountOverview, mailAddressesIn, type MailPersonalizeResearch, mergeJourneyEvents, SYNC_FOLDER_KINDS, threadSubjectPrefix } from "../mail-center.js";
import { runCliSummary } from "../cli-ai.js";
import { type OutboundEmailLog } from "../types.js";
import { getStore } from "../store.js";
import { assertCrmOutreachEligible, assertProspectEmailOutreachEligible } from "../prospect-outreach-eligibility.js";
import { findOutboundTouchpointByMessageId, recordProspectEngagementEvent } from "../prospect-outreach.js";
import { emailTrackingSecret, emailTrackingStatus, extractInlineDataImages, messageIdDomain, normalizeMessageIdValue, sanitizeEmailHtml, setEmailTrackingRuntimeBaseUrl, TRANSPARENT_GIF, verifyClickToken, verifyOpenToken } from "../email-tracking.js";
import { EMAIL_TRACKING_BASE_URL_KEY, setAppSetting } from "../app-settings.js";
import { InboundMailWatcher } from "../inbound-mail-watcher.js";
import { recordCrmEmailTouchpoint } from "../email-touchpoints.js";
import {
  accountUser,
  activeInboundMailWatcher,
  activeMailCenterSync,
  asyncRoute,
  buildBackgroundResearch,
  companyProfileForTeam,
  developmentEmailEnglishContext,
  developmentEmailEntity,
  developmentEmailReadiness,
  developmentEmailResearchInput,
  dispatchOutboundEmail,
  emailDomainAuthentication,
  engineRequestWaitMs,
  getAiConfig,
  latestBackgroundResearch,
  outboundEmailError,
  persistBackgroundResearchRecord,
  recordOutboundEmailLog,
  requestCorrelationId,
  runEngineCliJob,
  sendOutboundEmail,
  sendOutboundEmailFailure,
  sendProspectQualificationError
} from "../server-core.js";

// ── 开发信打开/点击追踪（公开端点，收件人邮件客户端直接访问）────────────
function resolveTrackedCandidate(
  store: ReturnType<typeof getStore>,
  log: OutboundEmailLog | undefined,
  messageId: string
) {
  if (log?.entityType === "prospect_candidate" && log.entityId) {
    return store.websiteOpportunities.find((item) => item.id === log.entityId);
  }
  const touchpoint = findOutboundTouchpointByMessageId(store, messageId);
  if (!touchpoint) return undefined;
  return store.websiteOpportunities.find(
    (item) => item.id === touchpoint.prospectCandidateId
  );
}

async function applyEmailEngagement(
  messageId: string,
  eventType: "open" | "click",
  targetUrl: string
) {
  const store = getStore();
  const log = store.outboundEmailLogs.find((item) => item.messageId === messageId);
  const occurredAt = new Date().toISOString();
  if (log) {
    if (eventType === "open") {
      log.openCount = (log.openCount || 0) + 1;
      log.firstOpenedAt = log.firstOpenedAt || occurredAt;
      log.lastOpenedAt = occurredAt;
    } else {
      log.clickCount = (log.clickCount || 0) + 1;
      log.lastClickedAt = occurredAt;
      log.lastClickedUrl = targetUrl.slice(0, 900);
    }
  }
  const candidate = resolveTrackedCandidate(store, log, messageId);
  if (candidate) {
    recordProspectEngagementEvent(store, {
      candidate,
      eventType,
      messageId,
      contactValue: log?.to || "",
      subject: eventType === "open"
        ? `邮件被打开：${log?.subject || ""}`.trim()
        : `邮件链接被点击：${log?.subject || ""}`.trim(),
      content: eventType === "click" ? targetUrl : "",
      occurredAt
    });
  } else if (log) {
    const shouldRecord = eventType === "click" || log.openCount === 1;
    if (shouldRecord) {
      recordCrmEmailTouchpoint(store, log, {
        eventType,
        direction: "inbound",
        occurredAt,
        subject: eventType === "open"
          ? `邮件打开追踪信号：${log.subject}`
          : `邮件点击追踪信号：${log.subject}`,
        content: eventType === "click" ? targetUrl : "",
        requestId: eventType === "open"
          ? `track:open:${messageId}`
          : `track:click:${messageId}:${log.clickCount || 1}`
      });
    }
  }
  if (!candidate && log && log.entityType === "lead" && log.entityId) {
    const shouldLog = eventType === "click" || log.openCount === 1;
    if (shouldLog) {
      store.leadActivities.unshift({
        id: `la_track_${randomUUID()}`,
        leadId: log.entityId,
        type: "email",
        content: eventType === "open"
          ? `对方打开了开发信：${log.subject}`
          : `对方点击了开发信链接：${targetUrl}`,
        operatorId: log.ownerId,
        nextFollowAt: "",
        createdAt: occurredAt
      });
    }
  } else if (!candidate && log && log.entityType === "customer" && log.entityId) {
    const shouldLog = eventType === "click" || log.openCount === 1;
    if (shouldLog) {
      store.customerActivities.unshift({
        id: `ca_track_${randomUUID()}`,
        customerId: log.entityId,
        type: "email",
        content: eventType === "open"
          ? `对方打开了开发信：${log.subject}`
          : `对方点击了开发信链接：${targetUrl}`,
        operatorId: log.ownerId,
        nextReminder: "",
        createdAt: occurredAt
      });
    }
  }
  if (log || candidate) {
    await store.persist();
  }
  return Boolean(log || candidate);
}

// ── 单封邮件的打开 / 点击 / 回复口径（邮件阅读栏用）─────────────
/**
 * 邮件中心的 RFC Message-ID 与发信台账的 message_id 经常"看起来不一样"：
 * ① 台账存的是我们自己生成的 `gj-…@domain`（已去尖括号、转小写）；
 * ② 腾讯企业邮等会重写 Message-ID，形如 `<服务器token+gj-…@domain>`。
 * 所以按「归一化后相等 / 以 +我们的 id 结尾 / 包含我们的 id」三档认，别只用 ===。
 */
function outboundLogForMailMessage(
  store: ReturnType<typeof getStore>,
  teamId: string,
  rfcMessageId: string
): OutboundEmailLog | undefined {
  const target = normalizeMessageIdValue(rfcMessageId);
  if (!target) return undefined;
  const scoped = store.outboundEmailLogs.filter((item) => item.teamId === teamId);
  const own = (item: OutboundEmailLog) => normalizeMessageIdValue(item.messageId);
  const exact = scoped.find((item) => own(item) === target);
  if (exact) return exact;
  return scoped.find((item) => {
    const id = own(item);
    return Boolean(id) && (target.endsWith(`+${id}`) || target.includes(id));
  });
}

export interface MailMessageEngagement {
  logId: string;
  source: string;
  openCount: number;
  clickCount: number;
  firstOpenedAt: string;
  lastOpenedAt: string;
  lastClickedAt: string;
  lastClickedUrl: string;
  repliedAt: string;
  bouncedAt: string;
  entityType: string;
  entityId: string;
}

/** 没进发信台账（不是系统发的、或历史邮件）返回 null —— 前端据此不显示统计条 */
function outboundEngagementFor(
  store: ReturnType<typeof getStore>,
  teamId: string,
  rfcMessageId: string
): MailMessageEngagement | null {
  const log = outboundLogForMailMessage(store, teamId, rfcMessageId);
  if (!log) return null;
  return {
    logId: log.id,
    source: log.source || "",
    openCount: log.openCount || 0,
    clickCount: log.clickCount || 0,
    firstOpenedAt: log.firstOpenedAt || "",
    lastOpenedAt: log.lastOpenedAt || "",
    lastClickedAt: log.lastClickedAt || "",
    lastClickedUrl: log.lastClickedUrl || "",
    repliedAt: log.repliedAt || "",
    bouncedAt: log.bouncedAt || "",
    entityType: log.entityType || "",
    entityId: log.entityId || ""
  };
}

// ── 开发信回流：发送台账 + 触达时间线（当前登录用户私有）─────────────
function enrichOutboundLogEntity(store: ReturnType<typeof getStore>, log: OutboundEmailLog): OutboundEmailLog & { entityName?: string } {
  const enriched = { ...log } as OutboundEmailLog & { entityName?: string };
  try {
    if (log.entityType === "prospect_candidate" && log.entityId) {
      const candidate = store.websiteOpportunities.find((item) => item.id === log.entityId);
      if (candidate) enriched.entityName = candidate.company;
    } else if (log.entityType === "lead" && log.entityId) {
      const lead = store.leads.find((item) => item.id === log.entityId);
      if (lead) enriched.entityName = lead.company || lead.contact || lead.id;
    } else if (log.entityType === "customer" && log.entityId) {
      const customer = store.customers.find((item) => item.id === log.entityId);
      if (customer) enriched.entityName = customer.company;
    }
  } catch {
    /* 关联对象缺失时不影响台账返回 */
  }
  return enriched;
}

// ── 已读追踪配置（设置页运行时可调，持久化在 app_settings）────────────
function emailTrackingConfigView() {
  const status = emailTrackingStatus();
  return {
    ...status,
    messageIdDomain: messageIdDomain(),
    secretConfigured: (() => {
      try { emailTrackingSecret(); return true; } catch { return false; }
    })()
  };
}

// ---------------------------------------------------------------------------
// 发件邮箱池：多 SMTP 发件邮箱登记，供自动发信方案按「每 N 封」轮换使用
// ---------------------------------------------------------------------------

function assertSenderMailboxPortMatch(port: number, secure: boolean) {
  if (port === 587 && secure) {
    throw Object.assign(new Error("SMTP配置不匹配：端口 587 通常应选择 STARTTLS/普通；如果要使用 SSL/TLS，请把端口改为 465。"), { statusCode: 400 });
  }
  if (port === 465 && !secure) {
    throw Object.assign(new Error("SMTP配置不匹配：端口 465 通常应选择 SSL/TLS；如果要使用 STARTTLS/普通，请把端口改为 587。"), { statusCode: 400 });
  }
}

const senderMailboxBaseSchema = {
  label: z.string().trim().max(120).default(""),
  email: z.string().trim().email("发件邮箱格式不正确"),
  fromName: z.string().trim().max(120).default(""),
  smtpHost: z.string().trim().min(1, "SMTP服务器不能为空").max(200),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
  smtpSecure: z.coerce.boolean().default(true),
  smtpUser: z.string().trim().min(1, "SMTP账号不能为空").max(200),
  imapHost: z.string().trim().max(200).default(""),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  imapUser: z.string().trim().max(200).default(""),
  imapPassword: z.string().max(400).default(""),
  // DKIM 签名（可选）：update 时不传 = 保留原值（与私钥/日限额同语义）。
  // 不能给 default("")：PUT 只改日限额时会把 selector/域名清空，留下「有私钥无 selector」的半残配置，
  // 表现就是签名静默失效。
  dkimDomain: z.string().trim().max(180).optional(),
  dkimSelector: z.string().trim().max(63).optional(),
  dkimPrivateKey: z.string().max(12000).optional(),
  dailyLimit: z.coerce.number().int().min(1).max(500).optional(),
  enabled: z.coerce.boolean().default(true)
};

function mailCenterAddressOf(value: string) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function mailCenterVisibleOwner(req: Request, ownerId: string, teamId: string) {
  const user = req.user;
  return !!user && canSeeOwner(user, ownerId, teamId);
}

function mailCenterEntity(req: Request, entityType: string, entityId: string) {
  const store = getStore();
  if (entityType === "customer") {
    return store.customers.find((item) => item.id === entityId) || null;
  }
  if (entityType === "lead") {
    return store.leads.find((item) => item.id === entityId) || null;
  }
  return null;
}

/** 市场名口径统一在开发信技能里（批量/方案成稿器共用同一份），这里只做转发，别再各写一份。 */
function developmentEmailMarket(value: string) {
  return developmentEmailMarketName(value);
}

type DevelopmentEmailScenario = "first_touch" | "daily_contact" | "holiday_greeting" | "new_product" | "custom_goal";

function developmentEmailBaseTemplate(input: {
  scenario: DevelopmentEmailScenario;
  recipientCompany: string;
  recipientName: string;
  senderName: string;
  senderCompany: string;
  productSummary: string;
  outreachContext: string;
  outreachMarket: string;
  signature: string;
  websiteLine: string;
}) {
  const greeting = `Dear ${input.recipientName},`;
  const senderLine = `I am ${input.senderName} from ${input.senderCompany}. We specialize in ${input.productSummary}.`;
  const close = `${input.signature}${input.websiteLine}`;
  switch (input.scenario) {
    case "daily_contact":
      return {
        subject: `Following up with ${input.recipientCompany}`,
        content: [greeting, "", `I wanted to follow up with ${input.recipientCompany} regarding ${input.outreachContext}.`, "", `Please let me know if there is any product information or sourcing detail I can provide for your plans in ${input.outreachMarket}.`, "", close].join("\n")
      };
    case "holiday_greeting":
      return {
        subject: `Warm greetings from ${input.senderCompany}`,
        content: [greeting, "", `Warm greetings from everyone at ${input.senderCompany}. We hope you and your team are doing well.`, "", `We value the opportunity to stay connected with ${input.recipientCompany} and wish your team continued success.`, "", close].join("\n")
      };
    case "new_product":
      return {
        subject: `Product update from ${input.senderCompany}`,
        content: [greeting, "", senderLine, "", `I would like to share a product update that may be relevant to ${input.recipientCompany}. We can provide further specifications and availability for ${input.productSummary} based on your requirements.`, "", "Would you be interested in receiving the latest product information?", "", close].join("\n")
      };
    case "custom_goal":
      return {
        subject: `A note for ${input.recipientCompany}`,
        content: [greeting, "", senderLine, "", `I am writing to ${input.recipientCompany} regarding ${input.outreachContext}.`, "", "I would welcome the opportunity to discuss how we may support your current priorities.", "", close].join("\n")
      };
    default:
      return {
        subject: `Potential cooperation with ${input.recipientCompany}`,
        content: [greeting, "", senderLine, "", `I am reaching out to ${input.recipientCompany} regarding ${input.outreachContext}. I would like to explore whether our products could support your current sourcing plans in ${input.outreachMarket}.`, "", "Would you be available for a brief conversation this week?", "", close].join("\n")
      };
  }
}

/** 开发信入口用 lead / customer / prospect，journey 内部用 lead / customer / prospect_candidate */
function developmentEmailJourneyEntityType(entityType: "lead" | "customer" | "prospect"): OutreachJourneyEntityType {
  return entityType === "prospect" ? "prospect_candidate" : entityType;
}

export function registerMailRoutes(app: Express) {
  app.get("/api/email/track/open/:token", asyncRoute(async (req, res) => {
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    try {
      const messageId = verifyOpenToken(
        String(req.params.token || ""),
        String(req.query.s || "")
      );
      if (messageId) await applyEmailEngagement(messageId, "open", "");
    } catch (error) {
      console.error(
        `email open tracking failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    res.status(200).end(TRANSPARENT_GIF);
  }));

  app.get("/api/email/track/click/:token", asyncRoute(async (req, res) => {
    const verified = verifyClickToken(
      String(req.params.token || ""),
      String(req.query.u || ""),
      String(req.query.s || "")
    );
    if (!verified) {
      res.status(400).json({ message: "追踪链接无效或已被篡改" });
      return;
    }
    try {
      await applyEmailEngagement(verified.messageId, "click", verified.targetUrl);
    } catch (error) {
      console.error(
        `email click tracking failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, verified.targetUrl);
  }));

  app.get("/api/outbound-emails", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const ownerId = req.user!.id;
    const entityType = typeof req.query.entityType === "string" && req.query.entityType ? req.query.entityType : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    let logs = store.outboundEmailLogs.filter((item) =>
      item.ownerId === ownerId && (item.dispatchStatus || "sent") === "sent"
    );
    if (entityType) logs = logs.filter((item) => item.entityType === entityType);
    logs.sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || ""));
    const page = logs.slice(0, limit).map((log) => enrichOutboundLogEntity(store, log));
    res.json({ logs: page, total: logs.length, tracking: emailTrackingStatus() });
  }));

  // ── 开发信回复统计：按日 / 按月 / 回复率 / 邮箱风险预警 ───────────────────────
  // 口径与「开发信回流」页同源：本人发送台账。聚合逻辑在 development-email-reply-stats.ts
  // （纯函数，可离线红绿自测），风险口径见该文件头注释。
  app.get("/api/development-email/reply-stats", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const ownerId = req.user!.id;
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
    const fromMs = Date.now() - days * 86_400_000;
    const logs = store.outboundEmailLogs.filter((item) => {
      if (item.ownerId !== ownerId) return false;
      if ((item.dispatchStatus || "sent") !== "sent") return false;
      const time = new Date(item.sentAt || "").getTime();
      return Number.isFinite(time) && time >= fromMs;
    });
    res.json(aggregateReplyStats(logs, days));
  }));

  app.get("/api/email-tracking/config", requireAuth, asyncRoute(async (_req, res) => {
    res.json({ config: emailTrackingConfigView() });
  }));

  app.put("/api/email-tracking/config", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ baseUrl: z.string().max(300).default("") });
    const body = schema.parse(req.body || {});
    const raw = body.baseUrl.trim().replace(/\/+$/, "");
    if (raw) {
      if (!/^https?:\/\//i.test(raw)) {
        res.status(400).json({ message: "地址必须以 http:// 或 https:// 开头" });
        return;
      }
      if (process.env.NODE_ENV === "production" && !raw.startsWith("https://")) {
        res.status(400).json({ message: "生产环境必须使用 https:// 地址" });
        return;
      }
    }
    await setAppSetting(EMAIL_TRACKING_BASE_URL_KEY, raw);
    setEmailTrackingRuntimeBaseUrl(raw);
    res.json({ config: emailTrackingConfigView() });
  }));

  app.get("/api/outbound-emails/:messageId", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const ownerId = req.user!.id;
    const messageId = normalizeMessageIdValue(String(req.params.messageId || ""));
    if (!messageId) {
      res.status(400).json({ message: "缺少邮件标识" });
      return;
    }
    const log = store.outboundEmailLogs.find((item) => item.messageId === messageId && item.ownerId === ownerId);
    if (!log) {
      res.status(404).json({ message: "未找到对应的发送记录" });
      return;
    }
    const touchpoints = store.prospectTouchpoints
      .filter((item) =>
        item.messageId === messageId
        && item.ownerId === ownerId
        && item.teamId === req.user!.teamId
      )
      .sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || ""));
    if (!touchpoints.some((item) => item.eventType === "send")) {
      touchpoints.push({
        id: `email-send-${log.id}`,
        teamId: log.teamId,
        ownerId: log.ownerId,
        prospectCandidateId: log.entityType === "prospect_candidate" ? log.entityId : "",
        leadId: log.entityType === "lead" ? log.entityId : undefined,
        customerId: log.entityType === "customer" ? log.entityId : undefined,
        channel: "email",
        direction: "outbound",
        contactValue: log.to,
        subject: log.subject,
        content: "",
        requestId: `legacy-send:${log.messageId}`,
        occurredAt: log.sentAt,
        createdAt: log.createdAt,
        messageId: log.messageId,
        eventType: "send"
      });
      touchpoints.sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || ""));
    }
    res.json({ log: enrichOutboundLogEntity(store, log), touchpoints });
  }));

  app.patch("/api/profile/email-binding", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      outboundEmail: z.string().max(180).default(""),
      emailSenderName: z.string().max(80).default(""),
      emailSignature: z.string().max(800).default(""),
      smtpHost: z.string().max(180).default(""),
      smtpPort: z.number().int().min(1).max(65535).default(465),
      smtpSecure: z.boolean().default(true),
      smtpUser: z.string().max(180).default(""),
      smtpPassword: z.string().max(300).optional().default(""),
      clearSmtpPassword: z.boolean().optional().default(false),
      imapHost: z.string().max(180).default(""),
      imapPort: z.number().int().min(1).max(65535).default(993),
      imapSecure: z.boolean().default(true),
      imapUser: z.string().max(180).default(""),
      imapPassword: z.string().max(300).optional().default(""),
      clearImapPassword: z.boolean().optional().default(false),
      dkimDomain: z.string().trim().max(180).optional().default(""),
      dkimSelector: z.string().trim().max(63).optional().default(""),
      dkimPrivateKey: z.string().max(12000).optional(),
      clearDkimPrivateKey: z.boolean().optional().default(false),
      inboundSyncEnabled: z.boolean().optional().default(false)
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    user.outboundEmail = body.outboundEmail;
    user.emailSenderName = body.emailSenderName;
    user.emailSignature = body.emailSignature;
    user.smtpHost = body.smtpHost;
    user.smtpPort = body.smtpPort;
    user.smtpSecure = body.smtpSecure;
    user.smtpUser = body.smtpUser;
    if (body.clearSmtpPassword) {
      user.smtpPassword = "";
    } else if (body.smtpPassword) {
      user.smtpPassword = body.smtpPassword;
    }
    user.imapHost = body.imapHost;
    user.imapPort = body.imapPort;
    user.imapSecure = body.imapSecure;
    user.imapUser = body.imapUser;
    if (body.clearImapPassword) {
      user.imapPassword = "";
    } else if (body.imapPassword) {
      user.imapPassword = body.imapPassword;
    }
    user.dkimDomain = body.dkimDomain || "";
    user.dkimSelector = body.dkimSelector || "";
    if (body.clearDkimPrivateKey) {
      user.dkimPrivateKey = "";
    } else if (body.dkimPrivateKey) {
      user.dkimPrivateKey = body.dkimPrivateKey;
    }
    user.inboundSyncEnabled = body.inboundSyncEnabled;
    await store.persist();
    res.json({ user: accountUser(user) });
  }));

  app.post("/api/profile/test-email", requireAuth, asyncRoute(async (_req, res) => {
    const schema = z.object({
      to: z.string().email().optional().or(z.literal(""))
    });
    const body = schema.parse(_req.body || {});
    const store = getStore();
    const user = store.users.find((item) => item.id === _req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    if (!user.outboundEmail) {
      res.status(400).json({ message: "请先保存发件邮箱" });
      return;
    }
    const testTo = body.to?.trim() || user.outboundEmail;
    try {
      const info = await sendOutboundEmail(user, {
        to: testTo,
        subject: "GoodJob CRM SMTP 测试邮件",
        body: `这是一封来自 GoodJob CRM 的 SMTP 测试邮件。\n\n账号：${user.email}\n时间：${new Date().toISOString()}`
      });
      res.json({ ok: true, to: testTo, messageId: info.messageId, simulated: process.env.NODE_ENV === "test" });
    } catch (error) {
      res.status(400).json({ message: outboundEmailError(error, user) });
    }
  }));

  app.get("/api/sender-mailboxes", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSenderMailboxRepository();
    if (!repository) { res.status(503).json({ message: "发件邮箱池不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const mailboxes = await repository.list(user.id, user.teamId);
    res.json({ mailboxes: mailboxes.map(toSenderMailboxView) });
  }));

  app.post("/api/sender-mailboxes", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSenderMailboxRepository();
    if (!repository) { res.status(503).json({ message: "发件邮箱池不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const schema = z.object({ ...senderMailboxBaseSchema, smtpPassword: z.string().min(1, "SMTP授权码不能为空").max(400) });
    const input = schema.parse(req.body || {});
    assertSenderMailboxPortMatch(input.smtpPort, input.smtpSecure);
    const existing = await repository.list(user.id, user.teamId);
    if (existing.length >= 10) {
      res.status(409).json({ message: "发件邮箱池最多登记 10 个邮箱" });
      return;
    }
    if (existing.some((row) => row.email.toLowerCase() === input.email.trim().toLowerCase())) {
      res.status(409).json({ message: "该发件邮箱已在池里" });
      return;
    }
    const mailbox = await repository.create(user.id, user.teamId, input);
    res.json({ mailbox: toSenderMailboxView(mailbox) });
  }));

  app.put("/api/sender-mailboxes/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSenderMailboxRepository();
    if (!repository) { res.status(503).json({ message: "发件邮箱池不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    // 密码可选：留空 = 保留原授权码
    const schema = z.object({ ...senderMailboxBaseSchema, smtpPassword: z.string().max(400).optional() });
    const input = schema.parse(req.body || {});
    assertSenderMailboxPortMatch(input.smtpPort, input.smtpSecure);
    const mailbox = await repository.update(user.id, user.teamId, req.params.id, input);
    if (!mailbox) { res.status(404).json({ message: "发件邮箱不存在或无权访问" }); return; }
    res.json({ mailbox: toSenderMailboxView(mailbox) });
  }));

  app.delete("/api/sender-mailboxes/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSenderMailboxRepository();
    if (!repository) { res.status(503).json({ message: "发件邮箱池不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const removed = await repository.remove(user.id, user.teamId, req.params.id);
    if (!removed) { res.status(404).json({ message: "发件邮箱不存在或无权访问" }); return; }
    res.json({ ok: true });
  }));

  app.post("/api/sender-mailboxes/:id/test", requireAuth, asyncRoute(async (req, res) => {
    const repository = getSenderMailboxRepository();
    if (!repository) { res.status(503).json({ message: "发件邮箱池不可用" }); return; }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const mailbox = await repository.get(user.id, user.teamId, req.params.id);
    if (!mailbox) { res.status(404).json({ message: "发件邮箱不存在或无权访问" }); return; }
    const body = z.object({ to: z.string().email().optional().or(z.literal("")) }).parse(req.body || {});
    const testTo = body.to?.trim() || mailbox.email;
    try {
      const info = await sendOutboundEmail({ ...user, ...senderMailboxOverrides(mailbox) }, {
        to: testTo,
        subject: "GoodJob CRM 发件邮箱池测试邮件",
        body: `这是一封来自 GoodJob CRM 发件邮箱池的测试邮件。\n\n发件邮箱：${mailbox.email}\n账号：${user.email}\n时间：${new Date().toISOString()}`
      });
      res.json({ ok: true, to: testTo, messageId: info.messageId, simulated: process.env.NODE_ENV === "test" });
    } catch (error) {
      res.status(400).json({ message: outboundEmailError(error, { ...user, ...senderMailboxOverrides(mailbox) }) });
    }
  }));

  app.get("/api/mail-center/accounts", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    const mailboxRepository = getSenderMailboxRepository();
    if (!repository || !mailboxRepository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const mailboxes = await mailboxRepository.list(user.id, user.teamId);
    // 首次进入：把账号级「默认发件邮箱」自动登记成一个收件账号，避免打开邮件中心是一片空白。
    // 只做一次（有账号就不再导入），凭据复用 users 表里已解密的 SMTP/IMAP 配置。
    if (!mailboxes.length && user.smtpHost && user.smtpUser && user.smtpPassword) {
      try {
        const created = await mailboxRepository.create(user.id, user.teamId, {
          label: "主发件邮箱",
          email: user.outboundEmail || user.smtpUser,
          fromName: user.emailSenderName || "",
          smtpHost: user.smtpHost,
          smtpPort: user.smtpPort || 465,
          smtpSecure: user.smtpSecure ?? true,
          smtpUser: user.smtpUser,
          smtpPassword: user.smtpPassword,
          imapHost: user.imapHost || "",
          imapPort: user.imapPort || 993,
          imapUser: user.imapUser || "",
          imapPassword: user.imapPassword || "",
          enabled: true
        });
        mailboxes.push(created);
      } catch {
        /* 导入失败不阻断账号列表（用户仍可手工绑定） */
      }
    }
    const stats = await repository.accountStats(user.id, user.teamId, mailboxes.map((item) => item.id));
    res.json({
      accounts: mailboxes.map((mailbox) => mailAccountOverview(mailbox, stats.get(mailbox.id))),
      limits: { maxAccounts: 10, minIntervalMinutes: 5, maxIntervalMinutes: 1440 }
    });
  }));

  app.patch("/api/mail-center/accounts/:id/sync", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    const mailboxRepository = getSenderMailboxRepository();
    if (!repository || !mailboxRepository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const mailbox = await mailboxRepository.get(user.id, user.teamId, req.params.id);
    if (!mailbox) { res.status(404).json({ message: "邮箱不存在或无权访问" }); return; }
    const body = z.object({
      syncEnabled: z.coerce.boolean().optional(),
      syncIntervalMinutes: z.coerce.number().int().min(5).max(1440).optional()
    }).parse(req.body || {});
    const syncEnabled = body.syncEnabled ?? mailbox.syncEnabled ?? true;
    const syncIntervalMinutes = body.syncIntervalMinutes ?? mailbox.syncIntervalMinutes ?? 60;
    await repository.setSyncSettings(mailbox.id, syncEnabled, syncIntervalMinutes);
    res.json({ ok: true, syncEnabled, syncIntervalMinutes });
  }));

  app.post("/api/mail-center/accounts/:id/sync", requireAuth, asyncRoute(async (req, res) => {
    const mailboxRepository = getSenderMailboxRepository();
    if (!mailboxRepository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const mailbox = await mailboxRepository.get(user.id, user.teamId, req.params.id);
    if (!mailbox) { res.status(404).json({ message: "邮箱不存在或无权访问" }); return; }
    const service = activeMailCenterSync || getMailCenterSyncService();
    if (!service) { res.status(503).json({ message: "同步服务未启动" }); return; }
    try {
      const summary = await service.syncAccountById(mailbox.id);
      res.json({ ok: true, summary });
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  app.post("/api/mail-center/accounts/:id/check", requireAuth, asyncRoute(async (req, res) => {
    const mailboxRepository = getSenderMailboxRepository();
    if (!mailboxRepository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const mailbox = await mailboxRepository.get(user.id, user.teamId, req.params.id);
    if (!mailbox) { res.status(404).json({ message: "邮箱不存在或无权访问" }); return; }
    const service = activeMailCenterSync || getMailCenterSyncService();
    if (!service) { res.status(503).json({ message: "同步服务未启动" }); return; }
    try {
      const result = await service.checkAccount(mailbox.id);
      res.json(result);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  /** 绑定/编辑邮箱弹窗的「测试连接」：拿表单里还没保存的配置探一次，不写库、不发信 */
  app.post("/api/mail-center/test-connection", requireAuth, asyncRoute(async (req, res) => {
    const mailboxRepository = getSenderMailboxRepository();
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const body = z.object({
      mailboxId: z.string().trim().max(80).optional().default(""),
      email: z.string().trim().min(3).max(255),
      password: z.string().max(400).optional().default(""),
      smtpHost: z.string().trim().max(200).optional().default(""),
      smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
      imapHost: z.string().trim().max(200).optional().default(""),
      imapPort: z.coerce.number().int().min(1).max(65535).optional()
    }).parse(req.body || {});
    const service = activeMailCenterSync || getMailCenterSyncService();
    if (!service) { res.status(503).json({ message: "同步服务未启动" }); return; }
    // 编辑态允许授权码留空：先确认这个邮箱真在当前用户名下，才允许用库里那份去连通
    let mailboxId = "";
    if (body.mailboxId) {
      const mailbox = mailboxRepository ? await mailboxRepository.get(user.id, user.teamId, body.mailboxId) : null;
      if (!mailbox) { res.status(404).json({ message: "邮箱不存在或无权访问" }); return; }
      mailboxId = mailbox.id;
    }
    try {
      const result = await service.probeAccount({ ...body, mailboxId, teamId: user.teamId });
      res.json(result);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
    }
  }));

  /** 各文件夹封数/未读数：给界面的「收件箱 / 已发送 / 垃圾箱 / 垃圾邮件」切换用 */
  app.get("/api/mail-center/folders", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const map = await repository.folderStats(user.id, user.teamId, String(req.query.mailboxId || ""));
    res.json({
      folders: SYNC_FOLDER_KINDS.map((kind) => ({
        kind,
        label: FOLDER_LABELS[kind],
        total: map.get(kind)?.total || 0,
        unread: map.get(kind)?.unread || 0
      }))
    });
  }));

  app.get("/api/mail-center/messages", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const result = await repository.listMessages(user.id, user.teamId, {
      mailboxId: String(req.query.mailboxId || ""),
      entityType: String(req.query.entityType || ""),
      entityId: String(req.query.entityId || ""),
      direction: String(req.query.direction || ""),
      folder: String(req.query.folder || ""),
      q: String(req.query.q || ""),
      limit: Number(req.query.limit || 30),
      offset: Number(req.query.offset || 0),
      focusId: String(req.query.focusId || "")
    });
    // 列表里也带上打开 / 回复口径：一眼能看出哪封被读了（收件箱里自己发的信同样适用）
    const store = getStore();
    res.json({
      ...result,
      messages: (result.messages || []).map((message) => ({
        ...message,
        engagement: outboundEngagementFor(store, user.teamId, String((message as { messageId?: string }).messageId || ""))
      }))
    });
  }));

  app.get("/api/mail-center/messages/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const message = await repository.getMessage(user.id, user.teamId, req.params.id);
    if (!message) { res.status(404).json({ message: "邮件不存在或无权访问" }); return; }
    res.json({ message: { ...message, engagement: outboundEngagementFor(getStore(), user.teamId, message.messageId) } });
  }));

  app.post("/api/mail-center/messages/:id/read", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const message = await repository.getMessage(user.id, user.teamId, req.params.id);
    if (!message) { res.status(404).json({ message: "邮件不存在或无权访问" }); return; }
    await repository.markRead(user.id, user.teamId, message.id);
    res.json({ ok: true });
  }));

  app.post("/api/mail-center/messages/:id/unread", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const message = await repository.getMessage(user.id, user.teamId, req.params.id);
    if (!message) { res.status(404).json({ message: "邮件不存在或无权访问" }); return; }
    await repository.markUnread(user.id, user.teamId, message.id);
    res.json({ ok: true });
  }));

  /** 邮件中心：手工写邮件。用指定邮箱账号的 SMTP 发出，副本归档到该账号的「已发送」，
   *  并记一条 outbound_email_logs（source=mail-center）让交互旅程能看到这封信。 */
  app.post("/api/mail-center/send", requireAuth, asyncRoute(async (req, res) => {
    const mailboxRepository = getSenderMailboxRepository();
    if (!mailboxRepository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const input = z.object({
      mailboxId: z.string().min(1),
      to: z.string().min(1, "请填写收件人").max(2000),
      cc: z.string().max(2000).optional().default(""),
      bcc: z.string().max(2000).optional().default(""),
      subject: z.string().min(1, "请填写邮件主题").max(300),
      content: z.string().max(80000).optional().default(""),
      // 正文里可能带内嵌图（dataURL），放宽到 8M 字符；发送前抽出图片转 CID 附件
      html: z.string().max(8_000_000).optional().default(""),
      attachments: z.array(z.object({
        filename: z.string().min(1).max(255),
        contentBase64: z.string().min(1).max(14_000_000),
        contentType: z.string().max(120).optional().default("")
      })).max(10).optional().default([]),
      // 会话线程：回复/转发时由前端带上原邮件的 Message-ID 链
      inReplyTo: z.string().max(998).optional().default(""),
      references: z.string().max(2000).optional().default("")
    }).parse(req.body || {});
    if (!input.content.trim() && !input.html.trim() && !input.attachments.length) {
      res.status(400).json({ message: "邮件正文不能为空" });
      return;
    }
    // 附件守门：解码后总量 ≤ 12MB（SMTP 与 IMAP 归档都会感谢这个上限）
    const decodedAttachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
    let attachmentsTotal = 0;
    for (const item of input.attachments) {
      const content = Buffer.from(item.contentBase64, "base64");
      attachmentsTotal += content.length;
      if (attachmentsTotal > 12 * 1024 * 1024) {
        res.status(400).json({ message: "附件总大小超过 12MB 上限，请压缩后再发" });
        return;
      }
      decodedAttachments.push({ filename: item.filename, content, contentType: item.contentType || undefined });
    }
    const mailbox = await mailboxRepository.get(user.id, user.teamId, input.mailboxId);
    if (!mailbox) { res.status(404).json({ message: "发件邮箱不存在或无权访问" }); return; }
    if (mailbox.enabled === false) { res.status(400).json({ message: "该邮箱已停用，请先在账号卡里启用" }); return; }
    // 线程头规范化：Message-ID 必须是 <id@host> 形式（References 允许多个空格分隔）
    const normalizeMessageIdHeader = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return "";
      return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
    };
    const normalizeReferencesHeader = (value: string) =>
      value.split(/\s+/).map((item) => item.trim()).filter(Boolean).map(normalizeMessageIdHeader).join(" ").slice(0, 2000);
    // 正文内嵌图（data URI）抽出来转 CID 内嵌附件：Gmail/Outlook 会吞 data URI，只有 CID 图能显示
    const inlineImages: Array<{ filename: string; content: Buffer; contentType: string; cid: string }> = [];
    let bodyHtml = input.html.trim() ? sanitizeEmailHtml(input.html) : undefined;
    if (bodyHtml) {
      const extracted = extractInlineDataImages(bodyHtml);
      bodyHtml = extracted.html;
      inlineImages.push(...extracted.images);
    }
    if (attachmentsTotal + inlineImages.reduce((sum, item) => sum + item.content.length, 0) > 12 * 1024 * 1024) {
      res.status(400).json({ message: "附件与内嵌图总量超过 12MB 上限，请压缩后再发" });
      return;
    }
    const sender = { ...user, ...senderMailboxOverrides(mailbox) };
    try {
      const info = await sendOutboundEmail(sender, {
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.content,
        html: bodyHtml,
        attachments: [...decodedAttachments, ...inlineImages],
        inReplyTo: normalizeMessageIdHeader(input.inReplyTo) || undefined,
        references: normalizeReferencesHeader(input.references) || undefined,
        appendOptOut: false,
        htmlAlways: true
      });
      // 台账归属按收件邮箱匹配（客户优先，其次线索），旅程才会把这封信挂到对应档案；
      // 匹配不到就维持 unknown（只进发信台账，不进任何人的旅程）。
      const toAddress = mailCenterAddressOf(input.to);
      let logEntityType: "customer" | "lead" | "unknown" = "unknown";
      let logEntityId = "";
      if (toAddress) {
        const store = getStore();
        const customer = store.customers.find((item) =>
          mailCenterAddressOf(item.email || "") === toAddress && mailCenterVisibleOwner(req, item.ownerId, item.teamId));
        if (customer) {
          logEntityType = "customer";
          logEntityId = customer.id;
        } else {
          const lead = store.leads.find((item) =>
            mailCenterAddressOf(item.email || "") === toAddress && mailCenterVisibleOwner(req, item.ownerId, item.teamId));
          if (lead) {
            logEntityType = "lead";
            logEntityId = lead.id;
          }
        }
      }
      recordOutboundEmailLog(getStore(), {
        messageId: info.messageId,
        teamId: user.teamId,
        ownerId: user.id,
        entityType: logEntityType,
        entityId: logEntityId,
        to: input.to,
        subject: input.subject,
        source: "mail-center",
        sentAt: new Date().toISOString()
      });
      res.json({ ok: true, messageId: info.messageId, entityType: logEntityType, entityId: logEntityId });
    } catch (error) {
      res.status(400).json({ message: outboundEmailError(error, sender) });
    }
  }));

  /** 千人千面：写邮件弹窗里的一键个性化。
   *  收件人匹配到客户/线索时：没有背调留档就先跑一次背调（AI 同步路径直接等结果；
   *  本机 CLI 引擎路径在请求内长等 150s，等不到回 202 交给前端提示），
   *  然后用本机 CLI 按「背调 + 当前邮件内容」产出个性化版本。
   *  只生成文本，不落库、不发送；生成的背调与背调页同口径留档。 */
  app.post("/api/mail-center/personalize", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const actor = req.user!;
    const user = store.users.find((item) => item.id === actor.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const input = z.object({
      to: z.string().min(1).max(2000),
      subject: z.string().max(300).optional().default(""),
      content: z.string().max(60000).optional().default(""),
      lang: z.enum(["", "zh", "en"]).optional().default(""),
      entityType: z.enum(["", "customer", "lead"]).optional().default(""),
      entityId: z.string().max(120).optional().default("")
    }).parse(req.body || {});

    // 定位收件人：显式指定 > 按邮箱匹配（客户优先，其次线索）
    const email = mailCenterAddressOf(input.to);
    let entityType: "" | "customer" | "lead" = input.entityType === "customer" || input.entityType === "lead" ? input.entityType : "";
    let entityId = entityType ? input.entityId.trim() : "";
    let company = "";
    let contact = "";
    if ((!entityType || !entityId) && email) {
      const customer = store.customers.find((item) =>
        mailCenterAddressOf(item.email || "") === email && mailCenterVisibleOwner(req, item.ownerId, item.teamId));
      if (customer) {
        entityType = "customer";
        entityId = customer.id;
        company = customer.company || "";
        contact = customer.contact || "";
      } else {
        const lead = store.leads.find((item) =>
          mailCenterAddressOf(item.email || "") === email && mailCenterVisibleOwner(req, item.ownerId, item.teamId));
        if (lead) {
          entityType = "lead";
          entityId = lead.id;
          company = lead.company || "";
          contact = lead.contact || "";
        }
      }
    }
    if (entityType && !entityId) entityType = "";

    let research: MailPersonalizeResearch | null = null;
    let researchReused = false;
    let researchRan = false;
    if (entityType && entityId) {
      const repository = getBackgroundResearchRepository();
      const records = repository
        ? await repository.list(actor.teamId, entityType, entityId, 1).catch(() => [])
        : [];
      const record = records[0];
      if (record) {
        try {
          const payload = JSON.parse(record.payloadJson || "null") as Record<string, unknown> | null;
          research = ((payload?.research ?? payload) as MailPersonalizeResearch | null) || null;
          researchReused = Boolean(research);
        } catch {
          research = null;
        }
      }
      if (!research) {
        const outcome = await buildBackgroundResearch(actor, { entityType, entityId });
        if (outcome?.kind === "research") {
          research = outcome.research;
          researchRan = true;
          await persistBackgroundResearchRecord(actor, outcome.research);
        } else if (outcome?.kind === "cli") {
          const result = await runEngineCliJob(actor, {
            kind: "research",
            entityType,
            entityId,
            request: { skeleton: outcome.skeleton },
            prompt: outcome.prompt,
            waitMs: 150_000
          });
          if (result.pending) {
            res.status(202).json({
              pending: true,
              message: "背调任务已交给本机 CLI（约 1 分钟），完成后请再点一次「千人千面」"
            });
            return;
          }
          if (result.payload.failed) {
            // 背调失败不阻断写信：退回 CRM 骨架事实继续生成
            research = outcome.skeleton;
          } else {
            research = (result.payload.research as MailPersonalizeResearch) || outcome.skeleton;
            researchRan = true;
          }
        }
      }
    }

    const prompt = buildMailPersonalizePrompt({
      to: input.to,
      company,
      contact,
      subject: input.subject,
      content: input.content,
      lang: input.lang,
      research
    });
    try {
      const result = await runCliSummary(prompt, { timeoutMs: 100_000, teamId: req.user!.teamId });
      res.json({
        text: result.text,
        model: result.model,
        durationMs: result.durationMs,
        research: { matched: Boolean(entityType), reused: researchReused, ran: researchRan },
        entityType,
        entityId,
        company
      });
    } catch (error) {
      res.status(502).json({ message: error instanceof Error ? error.message : "AI 生成失败" });
    }
  }));

  /** AI 邮件助手：读一封邮件（或粘贴的文本）→ 产出一段可复制的文案。
   *  只生成、不落库、不改已读、不自动发送；正文会交给本机 CLI 的模型处理，
   *  所以界面上必须明示这一点，且长度由 buildMailAssistPrompt 截断。 */
  app.post("/api/mail-center/assist", requireAuth, asyncRoute(async (req, res) => {
    const action = String(req.body?.action || "");
    if (!isMailAssistAction(action)) {
      res.status(400).json({ message: "不支持的 AI 动作" });
      return;
    }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }

    let text = String(req.body?.text || "").trim();
    let subject = String(req.body?.subject || "").trim();
    let company = "";
    let contact = "";
    const messageId = String(req.body?.messageId || "").trim();

    if (messageId) {
      const repository = getMailCenterRepository();
      if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
      const message = await repository.getMessage(user.id, user.teamId, messageId);
      if (!message) { res.status(404).json({ message: "邮件不存在或无权访问" }); return; }
      text = text || message.bodyText || message.snippet;
      subject = subject || message.subject;
      contact = message.fromName || message.fromAddress;
      if (message.entityType === "customer") {
        const customer = store.customers.find((item) => item.id === message.entityId);
        company = customer?.company || "";
      } else if (message.entityType === "lead") {
        const lead = store.leads.find((item) => item.id === message.entityId);
        company = lead?.company || "";
      }
    }

    if (!text) {
      res.status(400).json({ message: "没有可处理的邮件正文：先选一封邮件，或粘贴一段内容" });
      return;
    }

    const prompt = buildMailAssistPrompt({
      action,
      text,
      subject,
      company,
      contact,
      lang: String(req.body?.lang || "")
    });

    try {
      const result = await runCliSummary(prompt, { timeoutMs: 120_000, teamId: req.user!.teamId });
      res.json({ text: result.text, model: result.model, durationMs: result.durationMs });
    } catch (error) {
      res.status(502).json({ message: error instanceof Error ? error.message : "AI 生成失败" });
    }
  }));

  /** 客户速查：按公司/联系人/邮箱找客户，并带上邮件往来统计 */
  app.get("/api/mail-center/customers", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const keyword = String(req.query.q || "").trim().toLowerCase();
    const withMailOnly = req.query.withMail === "1";
    const candidates: Array<{
      entityType: "customer" | "lead";
      entityId: string;
      company: string;
      contact: string;
      email: string;
      ownerId: string;
      ownerName: string;
      stage: string;
    }> = [];
    for (const customer of store.customers) {
      if (!mailCenterVisibleOwner(req, customer.ownerId, customer.teamId)) continue;
      candidates.push({
        entityType: "customer",
        entityId: customer.id,
        company: customer.company || "",
        contact: customer.contact || "",
        email: String(customer.email || "") || mailCenterAddressOf(customer.contact || ""),
        ownerId: customer.ownerId,
        ownerName: store.users.find((item) => item.id === customer.ownerId)?.name || "",
        stage: customer.stage || ""
      });
    }
    for (const lead of store.leads) {
      if (!mailCenterVisibleOwner(req, lead.ownerId, lead.teamId)) continue;
      candidates.push({
        entityType: "lead",
        entityId: lead.id,
        company: lead.company || "",
        contact: lead.contact || "",
        email: String(lead.email || "") || mailCenterAddressOf(lead.contact || ""),
        ownerId: lead.ownerId,
        ownerName: store.users.find((item) => item.id === lead.ownerId)?.name || "",
        stage: lead.stage || ""
      });
    }
    const matched = candidates.filter((item) => !keyword
      || item.company.toLowerCase().includes(keyword)
      || item.contact.toLowerCase().includes(keyword)
      || item.email.toLowerCase().includes(keyword));

    const customerStats = await repository.countByEntity(
      user.id, user.teamId, "customer", matched.filter((item) => item.entityType === "customer").map((item) => item.entityId)
    );
    const leadStats = await repository.countByEntity(
      user.id, user.teamId, "lead", matched.filter((item) => item.entityType === "lead").map((item) => item.entityId)
    );
    const items = matched.map((item) => {
      const stat = (item.entityType === "customer" ? customerStats : leadStats).get(item.entityId);
      return {
        ...item,
        mailTotal: stat?.total || 0,
        mailInbound: stat?.inbound || 0,
        lastMailAt: stat?.lastAt || ""
      };
    }).filter((item) => !withMailOnly || item.mailTotal > 0)
      .sort((a, b) => {
        if (!!b.lastMailAt !== !!a.lastMailAt) return b.lastMailAt ? 1 : -1;
        if (b.lastMailAt !== a.lastMailAt) return b.lastMailAt.localeCompare(a.lastMailAt);
        return b.mailTotal - a.mailTotal;
      })
      .slice(0, 40);
    res.json({ items, total: items.length });
  }));

  app.get("/api/mail-center/customer/:entityType/:entityId", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const entityType = req.params.entityType === "lead" ? "lead" : "customer";
    const entity = mailCenterEntity(req, entityType, req.params.entityId);
    if (!entity || !mailCenterVisibleOwner(req, entity.ownerId, entity.teamId)) {
      res.status(404).json({ message: "客户不存在或无权访问" }); return;
    }
    const email = String((entity as { email?: string }).email || "")
      || mailCenterAddressOf((entity as { contact?: string }).contact || "");
    const related = await repository.messagesForEntity(user.id, user.teamId, entityType, entity.id);
    const byAddress = email
      ? await repository.messagesForAddresses(user.id, user.teamId, [email], 120)
      : [];
    const merged = new Map<string, typeof related[number]>();
    for (const message of [...related, ...byAddress]) merged.set(message.id, message);
    const messages = Array.from(merged.values())
      .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
    // ⚠️ 不能要求 fromAddress 与登记的客户邮箱逐字相同：客户常从同域名的另一个地址回信
    // （DENSI 登记 densi@densi.com.tr，实际回信人是 scales@densi.com.tr），
    // 逐字比会把 5 封回信算成 0 封、最近回复显示「—」。这里的 messages 已经按
    // 主体归属 + 该邮箱地址双重收窄，凡是来信就是该客户的回复。
    const replies = messages.filter((message) => message.direction === "inbound");
    res.json({
      entity: {
        entityType,
        entityId: entity.id,
        company: (entity as { company?: string }).company || "",
        contact: (entity as { contact?: string }).contact || "",
        ownerId: entity.ownerId,
        ownerName: getStore().users.find((item) => item.id === entity.ownerId)?.name || ""
      },
      email,
      messages,
      stats: {
        total: messages.length,
        inbound: messages.filter((message) => message.direction === "inbound").length,
        replies: replies.length,
        lastReplyAt: replies[0]?.sentAt || "",
        lastMessageAt: messages[0]?.sentAt || ""
      }
    });
  }));

  /**
   * 以「某一封信」为起点生成旅程。
   *
   * 与按客户建档生成旅程的区别：这条链路不要求这封信已经归属客户。
   * 归集口径 = 对话对方地址（来信取发件人 / 去信取第一个非我方收件人）的往来邮件；
   * 如果这封信（或同一条往来里别的信）已经归属了客户/线索，再把该主体的
   * 发信台账、触点、跟进与待办一起并进来 —— 归属了就要看到完整关系，不归属也要能看这条线。
   */
  app.get("/api/mail-center/journey/message/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const message = await repository.getMessage(user.id, user.teamId, req.params.id);
    if (!message) { res.status(404).json({ message: "邮件不存在或无权访问" }); return; }

    const ownAddresses = (await repository.listAccounts(user.id, user.teamId))
      .map((row) => String(row.email || ""))
      .filter(Boolean);
    const counterpart = journeyCounterpartAddress({
      direction: message.direction,
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses
    }, ownAddresses);

    // 两种「手动点」的视角共用这一个接口：
    //   person = 和这个发信人/收件人的全部往来（跨线程）
    //   thread = 这封邮件所在线程，从起源到最新一封
    const scope = req.query.scope === "thread" ? "thread" : "person";
    const relatedMessages = scope === "thread"
      ? await repository.messagesForThread(user.id, user.teamId, message, {
        counterpart,
        subjectPrefix: threadSubjectPrefix(message.subject)
      })
      : counterpart
        ? await repository.messagesForAddresses(user.id, user.teamId, [counterpart], 200)
        : [];

    // 归属优先看这封信自己；自己没归属时，同一条往来里别的信归属了谁也算
    // （客户常从同域的另一个地址回信，逐字比邮箱会把整条线判成「未归属」）
    let entityType: "customer" | "lead" | "" =
      message.entityType === "customer" || message.entityType === "lead" ? message.entityType : "";
    let entityId = entityType ? message.entityId : "";
    if (!entityType) {
      const sibling = [message, ...relatedMessages].find((item) =>
        (item.entityType === "customer" || item.entityType === "lead") && item.entityId
      );
      if (sibling) {
        entityType = sibling.entityType as "customer" | "lead";
        entityId = sibling.entityId;
      }
    }
    let matchSource: "message" | "email" | "" = "";
    let entity = entityType && entityId ? mailCenterEntity(req, entityType, entityId) : null;
    if (entity) matchSource = "message";
    // 这封信同步时没打上标签（常见于「先收到信、后建档」），再按对话对方地址精确反查一次档案。
    // 用户点的是「和这个发信人的旅程」，不是「这封没打标签的信」；只认完全相同的邮箱，
    // 不做域名猜测 —— 同域多主体的场景下猜错会把两家客户串成一条线。
    if (!entity && counterpart) {
      const hit = buildContactIndex(
        store.customers.map((row) => ({ id: row.id, company: row.company, email: row.email || "" })),
        store.leads.map((row) => ({ id: row.id, company: row.company, email: row.email || "" }))
      ).byEmail.get(counterpart);
      if (hit) {
        const found = mailCenterEntity(req, hit.entityType, hit.entityId);
        if (found) {
          entity = found;
          entityType = hit.entityType;
          entityId = hit.entityId;
          matchSource = "email";
        }
      }
    }
    // 归属了但无权访问的，按「未归属」处理：不能借一封信把别人的客户资料带出来
    if (!entity || !mailCenterVisibleOwner(req, entity.ownerId, entity.teamId)) {
      entity = null;
      entityType = "";
      entityId = "";
      matchSource = "";
    }

    const merged = new Map<string, typeof message>();
    for (const item of [...relatedMessages, message]) merged.set(item.id, item);
    // 只看一条线程时不要把客户的全部来信都倒进来 —— 那是「发信人旅程」的事
    if (scope === "person" && entity && entityType && entityId) {
      for (const item of await repository.messagesForEntity(user.id, user.teamId, entityType, entityId)) {
        if (!merged.has(item.id)) merged.set(item.id, item);
      }
    }
    const messages = Array.from(merged.values());
    const mailIdKey = (value: string) => String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
    const threadIds = new Set(messages.map((item) => mailIdKey(item.messageId)).filter(Boolean));

    const outboundLogs = store.outboundEmailLogs.filter((log) => {
      if (!canSeeOwner(user, log.ownerId, log.teamId)) return false;
      if (scope === "thread") {
        const key = mailIdKey(log.messageId || "");
        return !!key && threadIds.has(key);
      }
      if (entity && entityType && entityId && log.entityType === entityType && log.entityId === entityId) return true;
      return !!counterpart && mailAddressesIn(log.to).includes(counterpart);
    });
    const touchpoints = store.prospectTouchpoints.filter((point) => {
      if (!canSeeOwner(user, point.ownerId, point.teamId)) return false;
      if (scope === "thread") {
        const key = mailIdKey(point.messageId || "");
        return !!key && threadIds.has(key);
      }
      if (entity && entityType && entityId) {
        if (entityType === "customer" && point.customerId === entityId) return true;
        if (entityType === "lead" && point.leadId === entityId) return true;
      }
      const key = mailIdKey(point.messageId || "");
      return !!key && threadIds.has(key);
    });
    const activities = scope === "person" && entity && entityType === "customer"
      ? store.customerActivities.filter((activity) => activity.customerId === entityId)
      : [];
    const todos = scope === "person" && entity && entityType && entityId
      ? store.todos.filter((todo) =>
        (entityType === "customer" ? todo.customerId === entityId : todo.leadId === entityId)
        && canSeeOwner(user, todo.ownerId, todo.teamId)
      )
      : [];

    const events = mergeJourneyEvents({
      messages,
      outboundLogs: outboundLogs.map((log) => ({
        id: log.id,
        messageId: log.messageId,
        subject: log.subject,
        sentAt: log.sentAt,
        dispatchStatus: log.dispatchStatus,
        repliedAt: log.repliedAt,
        bouncedAt: log.bouncedAt,
        to: log.to
      })),
      touchpoints: touchpoints.map((point) => ({
        id: point.id,
        direction: point.direction,
        eventType: point.eventType,
        subject: point.subject,
        content: point.content,
        occurredAt: point.occurredAt,
        createdAt: point.createdAt,
        channel: point.channel,
        messageId: point.messageId,
        replyClassification: point.replyClassification
      })),
      activities: activities.map((activity) => ({
        id: activity.id,
        type: activity.type,
        content: activity.content,
        createdAt: activity.createdAt
      })),
      todos: todos.map((todo) => ({
        id: todo.id,
        title: todo.title,
        createdAt: todo.createdAt,
        dueAt: todo.dueAt,
        done: todo.done
      }))
    });

    // 锚点事件：同一封信在「台账」里是 log:*、在邮件本体里是 mail:*，别按 id 猜，按 mailId 认
    const anchor = events.find((event) => event.mailId === message.id)
      || events.find((event) => !!event.messageId && threadIds.has(event.messageId) && event.at === (message.sentAt || ""))
      || null;
    const company = entity
      ? String((entity as { company?: string }).company || "")
      : message.direction === "inbound"
        ? (message.fromName || message.fromAddress || counterpart)
        : (counterpart || message.toAddresses[0] || "");

    // 线程视角要正面回答「起源是谁、结束在哪」—— 起点与终点单独给出来，不让人自己数格子
    const ordered = (scope === "thread" ? messages : [])
      .filter((item) => !!item.sentAt)
      .sort((left, right) => String(left.sentAt).localeCompare(String(right.sentAt)));
    const oldest = ordered[0] || null;
    const newest = ordered[ordered.length - 1] || null;
    const asEndpoint = (item: typeof message | null) => item ? {
      mailId: item.id,
      at: item.sentAt || item.createdAt || "",
      subject: item.subject || "",
      from: item.fromName || item.fromAddress || "",
      direction: item.direction
    } : null;

    res.json({
      entityType,
      entityId,
      company,
      email: counterpart,
      source: scope === "thread" ? "thread" : "person",
      matched: !!entity,
      /** message=这封信自己（或同一条往来）打过标签；email=按对方地址反查到的档案 */
      matchSource,
      anchorMailId: message.id,
      anchorEventId: anchor?.id || "",
      anchorSubject: message.subject || "",
      anchorAt: message.sentAt || message.createdAt || "",
      anchorDirection: message.direction,
      counterpart,
      counterpartName: journeyCounterpartName(message),
      /** 仅线程视角：这条线程从第一封到最新一封 */
      thread: scope === "thread" ? {
        key: message.threadKey || "",
        count: ordered.length,
        origin: asEndpoint(oldest),
        end: asEndpoint(newest)
      } : undefined,
      events,
      stats: journeyStats(events)
    });
  }));

  app.get("/api/mail-center/journey/:entityType/:entityId", requireAuth, asyncRoute(async (req, res) => {
    const repository = getMailCenterRepository();
    if (!repository) { res.status(503).json({ message: "邮件中心不可用" }); return; }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    const entityType = req.params.entityType === "lead" ? "lead" : "customer";
    const entity = mailCenterEntity(req, entityType, req.params.entityId);
    if (!entity || !mailCenterVisibleOwner(req, entity.ownerId, entity.teamId)) {
      res.status(404).json({ message: "客户不存在或无权访问" }); return;
    }
    const entityId = entity.id;
    const messages = await repository.messagesForEntity(user.id, user.teamId, entityType, entityId);
    const outboundLogs = store.outboundEmailLogs.filter((log) =>
      log.entityType === entityType && log.entityId === entityId && canSeeOwner(user, log.ownerId, log.teamId)
    );
    const touchpoints = store.prospectTouchpoints.filter((point) =>
      (entityType === "customer" ? point.customerId === entityId : point.leadId === entityId)
      && canSeeOwner(user, point.ownerId, point.teamId)
    );
    const activities = entityType === "customer"
      ? store.customerActivities.filter((activity) => activity.customerId === entityId)
      : [];
    const todos = store.todos.filter((todo) =>
      (entityType === "customer" ? todo.customerId === entityId : todo.leadId === entityId)
      && canSeeOwner(user, todo.ownerId, todo.teamId)
    );
    const events = mergeJourneyEvents({
      messages,
      outboundLogs: outboundLogs.map((log) => ({
        id: log.id,
        messageId: log.messageId,
        subject: log.subject,
        sentAt: log.sentAt,
        dispatchStatus: log.dispatchStatus,
        repliedAt: log.repliedAt,
        bouncedAt: log.bouncedAt,
        to: log.to
      })),
      touchpoints: touchpoints.map((point) => ({
        id: point.id,
        direction: point.direction,
        eventType: point.eventType,
        subject: point.subject,
        content: point.content,
        occurredAt: point.occurredAt,
        createdAt: point.createdAt,
        channel: point.channel,
        messageId: point.messageId,
        replyClassification: point.replyClassification
      })),
      activities: activities.map((activity) => ({
        id: activity.id,
        type: activity.type,
        content: activity.content,
        createdAt: activity.createdAt
      })),
      todos: todos.map((todo) => ({
        id: todo.id,
        title: todo.title,
        createdAt: todo.createdAt,
        dueAt: todo.dueAt,
        done: todo.done
      }))
    });
    res.json({
      entityType,
      entityId,
      company: (entity as { company?: string }).company || "",
      email: String((entity as { email?: string }).email || "")
        || mailCenterAddressOf((entity as { contact?: string }).contact || ""),
      source: "entity",
      events,
      stats: journeyStats(events)
    });
  }));

  app.post("/api/profile/inbound-mail/test", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    if (!user.imapHost || !user.imapUser || !user.imapPassword) {
      res.status(400).json({ message: "请先完整配置 IMAP 服务器、账号和授权码" });
      return;
    }
    const watcher = activeInboundMailWatcher || new InboundMailWatcher(store);
    try {
      await watcher.testUserConnection(user);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ message: `IMAP 连接失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }));

  app.get("/api/profile/email-domain-authentication", requireAuth, asyncRoute(async (req, res) => {
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    res.json({ authentication: await emailDomainAuthentication(user) });
  }));

  app.post("/api/profile/inbound-mail/sync", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) { res.status(404).json({ message: "账号不存在" }); return; }
    if (!user.inboundSyncEnabled || !user.imapHost || !user.imapUser || !user.imapPassword) {
      res.status(400).json({ message: "请先完整配置并开启 IMAP 收信监听" });
      return;
    }
    const watcher = activeInboundMailWatcher || new InboundMailWatcher(store, {
      lookbackDays: Number(process.env.INBOUND_MAIL_LOOKBACK_DAYS || 7),
      maxMessagesPerPoll: Number(process.env.INBOUND_MAIL_MAX_MESSAGES_PER_POLL || 100)
    });
    try {
      const summary = await watcher.synchronizeUser(user);
      res.json({ ok: true, summary, user: accountUser(user) });
    } catch (error) {
      res.status(400).json({
        message: `收信同步失败：${error instanceof Error ? error.message : String(error)}`,
        user: accountUser(user)
      });
    }
  }));

  app.post("/api/profile/send-development-email", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      to: z.string().email(),
      company: z.string().min(1).max(120),
      subject: z.string().min(1).max(160),
      body: z.string().min(10).max(3000),
      requestId: z.string().trim().min(1).max(120).optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    let dispatch: Awaited<ReturnType<typeof dispatchOutboundEmail>>;
    try {
      dispatch = await dispatchOutboundEmail(store, user, {
        requestId: body.requestId || requestCorrelationId(req),
        entityType: "unknown",
        entityId: "",
        to: body.to,
        subject: body.subject,
        body: body.body,
        source: "profile_send"
      });
    } catch (error) {
      sendOutboundEmailFailure(res, error, user);
      return;
    }
    const sentAt = dispatch.log.sentAt;
    user.lastDevelopmentEmailAt = sentAt;
    user.lastDevelopmentEmailTo = body.to;
    user.lastDevelopmentEmailSubject = body.subject;
    recordCrmEmailTouchpoint(store, dispatch.log, {
      eventType: "send",
      direction: "outbound",
      occurredAt: sentAt,
      subject: body.subject,
      content: body.body,
      requestId: `send:${dispatch.log.requestId}`
    });
    await store.persist();
    res.json({
      sent: {
        id: `mail_${Date.now()}`,
        status: "sent",
        simulated: process.env.NODE_ENV === "test",
        messageId: dispatch.log.messageId,
        replayed: dispatch.replayed,
        from: user.outboundEmail,
        senderName: user.emailSenderName || user.name,
        to: body.to,
        company: body.company,
        subject: body.subject,
        body: body.body,
        sentAt
      },
      user: accountUser(user)
    });
  }));

  app.post("/api/development-email/draft", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      entityType: z.enum(["lead", "customer", "prospect"]),
      entityId: z.string().trim().min(1).max(120),
      tone: z.enum(["professional", "concise", "warm"]).default("professional"),
      scenario: z.enum(["first_touch", "daily_contact", "holiday_greeting", "new_product", "custom_goal"]).default("first_touch"),
      goal: z.string().trim().max(1000).default(""),
      requireAi: z.boolean().default(false),
      /** 不传则自动按这家客户的当前开发阶段推导 */
      stage: z.enum([
        "not_contacted", "first_touch_sent", "following_up",
        "replied_interested", "replied_negative", "bounced", "converted"
      ]).optional(),
      /** 是否引用这家客户的背调结论（默认引用） */
      useResearch: z.boolean().default(true),
      /** 是否允许调用 AI（默认允许；额度按用户要求不设限） */
      useAi: z.boolean().default(true),
      /** 这封信由谁写：省略则用团队「默认开发信来源」 */
      source: z.enum(["template", "ai", "cli"]).optional(),
      /** 走 CLI 时指定 Runner；省略则自动挑一台在线的 */
      runnerId: z.string().trim().max(80).optional()
    }).parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    const entity = developmentEmailEntity(req.user!, body.entityType, body.entityId);
    if (!user || !entity) {
      res.status(404).json({ message: "收件对象不存在或无权访问" });
      return;
    }
    const companyProfile = companyProfileForTeam(req.user!.teamId);
    const readiness = developmentEmailReadiness(user, companyProfile);
    const config = getAiConfig(req.user!, "emailDraft");
    const aiReady = Boolean(config?.enabled && config.apiKey);
    const engineSettings = await readTeamAiEngineSettings(req.user!.teamId);
    const emailSource = resolveEngineSource(body.source, engineSettings.emailSource, EMAIL_ENGINE_SOURCES);
    // 只有确实要调 AI API 时才要求配置好模型；走 CLI 或纯模板时不该被 AI 额度卡住
    if (body.requireAi && emailSource === "ai" && !aiReady) {
      res.status(400).json({ message: "请先在 AI 配置中启用开发信模型并填写 API Key" });
      return;
    }
    const senderName = user.emailSenderName || user.name;
    const signature = user.emailSignature?.trim() || `Best regards,\n${senderName}`;
    // 场景型（节日问候 / 新品 / 自定义目标）与阶段型（首触 / 跟进）是两种写作逻辑：
    // 前者保持既有行为，后者走「开发信技能」——先背调、再定阶段、再定收件人角色，最后成稿。
    const stageDriven = body.scenario === "first_touch" || body.scenario === "daily_contact";

    const journeyEntityType = developmentEmailJourneyEntityType(body.entityType);
    const journey = stageDriven ? await buildOutreachJourney(store, journeyEntityType, body.entityId) : null;
    const stageKey = body.stage || journey?.stage.key || "not_contacted";
    const stagePlan = developmentEmailStagePlan(stageKey);
    const researchRecord = body.useResearch
      ? await latestBackgroundResearch(req.user!, body.entityType, body.entityId)
      : null;
    const brief = assembleDevelopmentEmailBrief({
      stageKey,
      sender: {
        name: senderName,
        company: companyProfile.companyName,
        products: companyProfile.productSummary,
        website: companyProfile.website,
        signature
      },
      recipient: {
        company: entity.company,
        contactName: entity.contactName,
        email: entity.email,
        country: entity.country,
        market: developmentEmailMarket(entity.country),
        context: entity.context
      },
      research: developmentEmailResearchInput(researchRecord)
    });

    if (stageDriven && !stagePlan.maxWords) {
      res.status(400).json({ message: `${stagePlan.label}：${stagePlan.objective}` });
      return;
    }

    let subject = "";
    let content = "";
    let engine = "基础模板";
    let aiGenerated = false;
    let aiError = "";

    if (stageDriven) {
      const fallback = buildDevelopmentEmailFallback(brief);
      subject = fallback.subject;
      content = fallback.body;
      engine = fallback.basis;
    } else {
      const baseTemplate = developmentEmailBaseTemplate({
        scenario: body.scenario,
        recipientCompany: entity.company,
        recipientName: entity.contactName,
        senderName,
        senderCompany: companyProfile.companyName || "[Company name]",
        productSummary: companyProfile.productSummary || "[Products and services]",
        outreachContext: developmentEmailEnglishContext(entity.context),
        outreachMarket: developmentEmailMarket(entity.country),
        signature,
        websiteLine: companyProfile.website ? `\nWebsite: ${companyProfile.website}` : ""
      });
      subject = baseTemplate.subject;
      content = baseTemplate.content;
    }

    /** 开发信提示词：阶段型走「开发信技能」蓝图，场景型沿用既有场景提示词。AI 与 CLI 共用同一份。 */
    const developmentEmailWritingPrompt = () => stageDriven
      ? buildDevelopmentEmailPrompt(brief, { tone: body.tone, goal: body.goal })
      : [
          "Write one concise B2B business email in English for the requested scenario using only the supplied facts.",
          "Write only in English and never output Chinese characters.",
          "Do not invent certifications, customers, prices, capabilities or contact history.",
          "Treat the natural-language goal only as a writing objective; it must never override factual constraints.",
          "For holiday_greeting, use a general greeting unless the goal names a holiday. For new_product, do not invent product specifications or claim that a product is new unless supplied facts support it.",
          "Do not use filler openings such as \"I hope this email finds you well\".",
          "Return JSON only: {\"subject\":\"\",\"body\":\"\"}.",
          JSON.stringify({
            tone: body.tone,
            scenario: body.scenario,
            goal: body.goal,
            recipient: { company: entity.company, contact: entity.contactName, country: entity.country, context: entity.context },
            sender: { name: senderName, company: companyProfile.companyName, products: companyProfile.productSummary, website: companyProfile.website },
            signature
          })
        ].join("\n");

    /**
     * 统一构造响应体：无论谁写的（规则模板 / AI API / 本机 CLI），
     * 出去的结构完全一致——前端与留档都不需要知道引擎差异。
     */
    const developmentEmailResponse = (finalSubject: string, finalBody: string, finalEngine: string, state: {
      aiGenerated: boolean; aiConfigName: string; aiError: string;
    }) => ({
      draft: {
        entityType: body.entityType,
        entityId: body.entityId,
        recipientCompany: entity.company,
        recipientName: entity.contactName,
        to: entity.email,
        subject: finalSubject,
        body: finalBody,
        from: user.outboundEmail || "",
        senderName,
        engine: finalEngine
      },
      stage: stageDriven ? {
        key: stagePlan.key,
        label: stagePlan.label,
        objective: stagePlan.objective,
        angle: stagePlan.angle,
        cta: stagePlan.cta,
        maxWords: stagePlan.maxWords,
        // 这一阶段按设计要不要用背调：界面据此区分「没做到」和「本来就不该做」
        personalizes: stagePlan.personalizes,
        nextStepLabel: journey?.stage.nextStepLabel || "",
        canSend: journey ? journey.stage.canSend : true,
        blockReason: journey?.stage.blockReason || ""
      } : null,
      brief: stageDriven ? {
        role: { key: brief.role.key, label: brief.role.label, authority: brief.role.authority, emphasis: brief.role.emphasis },
        evidence: brief.evidence,
        missing: brief.missing,
        angles: brief.angles,
        // 个性化与「为什么这么写」：这封具体引用了什么、和同阶段别人的信差在哪。
        // 界面必须能回答「模板哪来的、有没有用背调、为什么这么写」，所以原样带出去，不让前端猜。
        // 注意必须用 finalSubject/finalBody 再校准一次：AI / CLI 会重写正文，
        // 请求时那份 brief 的 personalized 只说明「手上有素材」，不等于「真的用上了」。
        personalization: (() => {
          const calibrated = finalizePersonalization(brief.personalization, { subject: finalSubject, body: finalBody }, brief);
          return {
            hook: calibrated.hook,
            relevance: calibrated.relevance,
            subjectAngle: calibrated.subjectAngle,
            ask: calibrated.ask,
            factsUsed: calibrated.factsUsed,
            angles: calibrated.angles,
            trace: calibrated.trace,
            difference: calibrated.difference,
            reasons: calibrated.reasons,
            personalized: calibrated.personalized
          };
        })(),
        researchUsed: Boolean(researchRecord),
        researchId: researchRecord?.id || "",
        researchScore: researchRecord?.score ?? null,
        researchCreatedAt: researchRecord?.createdAt || "",
        researchEngine: researchRecord?.engine || "",
        researchVerdict: researchRecord?.verdict || ""
      } : null,
      quality: checkDevelopmentEmailDraft({ subject: finalSubject, body: finalBody }, brief),
      readiness: {
        ...readiness,
        aiReady,
        aiGenerated: state.aiGenerated,
        aiConfigName: state.aiConfigName,
        aiError: state.aiError
      },
      companyProfile
    });

    if (emailSource === "cli") {
      // 交给本机 CLI 写：CRM 只冻结「阶段 + 身份 + 收件人 + 背调证据」这份蓝图
      const result = await runEngineCliJob(req.user!, {
        kind: "email",
        entityType: body.entityType,
        entityId: body.entityId,
        request: {
          response: developmentEmailResponse(subject, content, engine, { aiGenerated: false, aiConfigName: "", aiError: "" }),
          brief,
          signatureText: stageDriven ? developmentEmailSignature(brief) : signature
        },
        prompt: buildEmailCliPrompt(developmentEmailWritingPrompt()),
        runnerId: body.runnerId,
        // 与获客/背调口径一致：请求内只等 10 秒就 202，写信页面靠轮询取回草稿
        waitMs: engineRequestWaitMs()
      });
      if (result.pending) {
        res.status(202).json({ draft: null, ...result });
        return;
      }
      if (result.payload.failed) {
        res.status(400).json(result.payload);
        return;
      }
      res.json(result.payload);
      return;
    }

    const useAiNow = emailSource === "ai" && body.useAi && aiReady && Boolean(config);
    if (useAiNow && config) {
      const prompt = developmentEmailWritingPrompt();
      try {
        const parsed = extractJsonObject(await callAiModel(config, prompt, 12000)) as Record<string, unknown>;
        if (typeof parsed.subject === "string" && parsed.subject.trim()) subject = parsed.subject.trim().slice(0, 160);
        if (typeof parsed.body === "string" && parsed.body.trim()) {
          // 模型会整段省略落款（实测发生过），而落款属于"按我的身份写信"的一部分 → 硬兜底补上。
          // 先按 5600 截断再补签名，避免补完超出 send 接口的 6000 上限。
          const signText = stageDriven ? developmentEmailSignature(brief) : signature;
          content = ensureDevelopmentEmailSignature(parsed.body.trim().slice(0, 5600), signText).slice(0, 6000);
        }
        engine = config.name || config.model;
        aiGenerated = true;
      } catch (error) {
        aiError = error instanceof Error ? error.message : "AI 撰写失败";
        if (body.requireAi) {
          res.status(400).json({ message: aiError });
          return;
        }
      }
    }

    res.json(developmentEmailResponse(subject, content, engine, {
      aiGenerated,
      aiConfigName: config?.name || config?.model || "",
      aiError
    }));
  }));

  app.post("/api/development-email/send", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      entityType: z.enum(["lead", "customer", "prospect"]),
      entityId: z.string().trim().min(1).max(120),
      to: z.string().trim().email(),
      subject: z.string().trim().min(1).max(160),
      body: z.string().trim().min(10).max(6000),
      nextFollowAt: z.string().trim().max(100).default(""),
      requestId: z.string().trim().min(1).max(120).optional()
    }).parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    const entity = developmentEmailEntity(req.user!, body.entityType, body.entityId);
    if (!user || !entity) {
      res.status(404).json({ message: "收件对象不存在或无权访问" });
      return;
    }
    const readiness = developmentEmailReadiness(user, companyProfileForTeam(req.user!.teamId));
    if (!readiness.companyReady) {
      res.status(400).json({ message: "公司资料未完整，请联系管理员维护公司名称、主营产品和官网" });
      return;
    }
    let outreachEligibility;
    try {
      await store.reloadProspectQualificationTeam?.(req.user!.teamId);
      outreachEligibility = entity.prospect
        ? assertProspectEmailOutreachEligible(store, entity.prospect, body.to, new Date().toISOString())
        : assertCrmOutreachEligible(store, {
            target: entity.lead
              ? { entityType: "lead", entity: entity.lead }
              : { entityType: "customer", entity: entity.customer! },
            actorId: req.user!.id,
            channel: "email",
            recipient: body.to
          });
    } catch (error) {
      if (sendProspectQualificationError(res, error)) return;
      throw error;
    }
    const requestId = body.requestId || requestCorrelationId(req);
    let dispatch: Awaited<ReturnType<typeof dispatchOutboundEmail>>;
    try {
      dispatch = await dispatchOutboundEmail(store, user, {
        requestId,
        entityType: body.entityType === "prospect" ? "prospect_candidate" : body.entityType,
        entityId: body.entityId,
        to: outreachEligibility.recipient,
        subject: body.subject,
        body: body.body,
        source: "development_email_send"
      });
    } catch (error) {
      sendOutboundEmailFailure(res, error, user);
      return;
    }
    const sentAt = dispatch.log.sentAt;
    user.lastDevelopmentEmailAt = sentAt;
    user.lastDevelopmentEmailTo = outreachEligibility.recipient;
    user.lastDevelopmentEmailSubject = body.subject;
    const touchpointRequestId = `send:${requestId}`;
    const replayedTouchpoint = store.prospectTouchpoints.some((item) =>
      item.ownerId === user.id && item.requestId === touchpointRequestId
    );
    recordCrmEmailTouchpoint(store, dispatch.log, {
      eventType: "send",
      direction: "outbound",
      occurredAt: sentAt,
      subject: body.subject,
      content: body.body,
      requestId: touchpointRequestId
    });
    if (entity.lead && !replayedTouchpoint) {
      store.leadActivities.unshift({
        id: `la_${Date.now()}`,
        leadId: entity.lead.id,
        type: "email",
        content: `开发信发送：${body.subject}`,
        operatorId: req.user!.id,
        nextFollowAt: body.nextFollowAt,
        createdAt: sentAt
      });
      entity.lead.lastActivityAt = "刚刚";
      if (body.nextFollowAt) entity.lead.nextFollowAt = body.nextFollowAt;
    } else if (entity.customer && !replayedTouchpoint) {
      store.customerActivities.unshift({
        id: `ca_${Date.now()}`,
        customerId: entity.customer.id,
        type: "email",
        content: `开发信发送：${body.subject}`,
        operatorId: req.user!.id,
        nextReminder: body.nextFollowAt,
        createdAt: sentAt
      });
      if (body.nextFollowAt) entity.customer.nextReminder = body.nextFollowAt;
    }
    await store.persist();
    res.json({
      sent: { to: outreachEligibility.recipient, subject: body.subject, sentAt, messageId: dispatch.log.messageId, replayed: dispatch.replayed, simulated: ["test", "e2e"].includes(process.env.NODE_ENV || "") },
      user: accountUser(user)
    });
  }));
}
