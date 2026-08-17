import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type { CrmStore } from "./store.js";
import type {
  OutboundEmailLog,
  ProspectReplyClassification,
  User,
  WebsiteOpportunity
} from "./types.js";
import { normalizeMessageIdValue } from "./email-tracking.js";
import { recordProspectTouchpoint } from "./prospect-outreach.js";
import { recordCrmEmailTouchpoint } from "./email-touchpoints.js";
import { randomUUID } from "node:crypto";

/**
 * 回信/退信监听：定时用 IMAP 轮询各业务员自己的收件箱，
 * 把回信、退信自动挂回对应的开发信（Message-ID 关联），并复用既有触达状态机。
 *
 * 设计原则：
 * - 只读收件箱，不删不改邮件；连接失败只写用户的同步状态，不影响主服务。
 * - 归属识别优先靠 In-Reply-To / References，兜底靠"发件人邮箱 + 最近一次发信"。
 * - 分类保守：能确定是退信/退订/拒绝才下判断，其余一律 auto_unknown 交给人工确认。
 */

export type InboundMailWatcherOptions = {
  pollMs?: number;
  lookbackDays?: number;
  overlapMinutes?: number;
  maxMessagesPerPoll?: number;
  maxSourceBytes?: number;
};

type InboundSyncSummary = {
  scanned: number;
  matched: number;
  replies: number;
  bounces: number;
  skipped: number;
  highestUid: number;
};

const BOUNCE_SENDER_PATTERN =
  /(mailer-daemon|postmaster|no-?reply@.*(mail|delivery)|delivery-?(status|subsystem))/i;
const BOUNCE_SUBJECT_PATTERN =
  /(undeliverable|undelivered|delivery status notification|delivery failure|failure notice|returned mail|mail delivery failed|退信|无法投递|投递失败)/i;
const AUTO_REPLY_SUBJECT_PATTERN =
  /(out of office|automatic reply|auto[- ]?reply|autoresponder|自动回复|自動回覆)/i;
const UNSUBSCRIBE_PATTERN =
  /(unsubscribe|opt[- ]?out|remove me from|stop sending|take me off|退订|取消订阅|不要再发)/i;
const REJECT_PATTERN =
  /(not interested|no interest|do not contact|don't contact|we are not looking|no thanks|不感兴趣|不需要|请勿再联系)/i;
const DEMAND_PATTERN =
  /(quotation|please quote|send.*(price|quote)|pricing|price list|moq|sample|proforma|catalog(ue)?|lead time|报价|价格表|样品|询盘|订单)/i;
const REFERRAL_PATTERN =
  /(contact|reach out to|speak with|forward(?:ed)? to|colleague|coworker|采购负责人|请联系|转给|同事)/i;
const NO_CURRENT_DEMAND_PATTERN =
  /(not now|no current (need|demand)|later this year|next quarter|keep.*on file|暂时不需要|目前没有需求|以后再联系|下个季度)/i;

function messageIdCandidates(parsed: ParsedMail) {
  const values: string[] = [];
  const push = (raw: unknown) => {
    if (!raw) return;
    const text = Array.isArray(raw) ? raw.join(" ") : String(raw);
    for (const match of text.matchAll(/<[^<>\s]+>/g)) {
      const normalized = normalizeMessageIdValue(match[0]);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }
  };
  push(parsed.inReplyTo);
  push(parsed.references as unknown);
  return values;
}

function bodyText(parsed: ParsedMail) {
  const text = (parsed.text || "").trim();
  if (text) return text;
  const html = typeof parsed.html === "string" ? parsed.html : "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function senderAddress(parsed: ParsedMail) {
  const from = parsed.from?.value?.[0]?.address || "";
  return from.trim().toLowerCase();
}

export function isBounceMessage(parsed: ParsedMail, rawSource: string) {
  const from = senderAddress(parsed);
  const subject = parsed.subject || "";
  if (BOUNCE_SENDER_PATTERN.test(from)) return true;
  if (BOUNCE_SUBJECT_PATTERN.test(subject)) return true;
  if (/content-type:\s*multipart\/report/i.test(rawSource)
    && /report-type=["']?delivery-status/i.test(rawSource)) {
    return true;
  }
  return false;
}

export function classifyInboundReply(parsed: ParsedMail): ProspectReplyClassification {
  const subject = parsed.subject || "";
  const content = `${subject}\n${bodyText(parsed)}`;
  if (UNSUBSCRIBE_PATTERN.test(content)) return "unsubscribed";
  if (REJECT_PATTERN.test(content)) return "rejected";
  const autoSubmitted = String(parsed.headers?.get("auto-submitted") || "");
  if (AUTO_REPLY_SUBJECT_PATTERN.test(subject)
    || (autoSubmitted && autoSubmitted.toLowerCase() !== "no")) {
    return "auto_unknown";
  }
  if (DEMAND_PATTERN.test(content)) return "clear_demand";
  if (REFERRAL_PATTERN.test(content)) return "referral";
  if (NO_CURRENT_DEMAND_PATTERN.test(content)) return "no_current_demand";
  return "auto_unknown";
}

/** 从退信正文里把原始 Message-ID / 原收件人抠出来，用于挂回原邮件。 */
export function extractBounceHints(rawSource: string) {
  const messageIds: string[] = [];
  for (const match of rawSource.matchAll(/message-id:\s*(<[^<>\s]+>)/gi)) {
    const normalized = normalizeMessageIdValue(match[1]);
    if (normalized && !messageIds.includes(normalized)) messageIds.push(normalized);
  }
  const recipients: string[] = [];
  for (const match of rawSource.matchAll(
    /(?:final-recipient|original-recipient|x-failed-recipients):\s*(?:rfc822;)?\s*([^\s<>;]+@[^\s<>;]+)/gi
  )) {
    const value = match[1].trim().toLowerCase();
    if (value && !recipients.includes(value)) recipients.push(value);
  }
  return { messageIds, recipients };
}

export class InboundMailWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly syncingUsers = new Set<string>();
  private readonly pollMs: number;
  private readonly lookbackDays: number;
  private readonly overlapMinutes: number;
  private readonly maxMessagesPerPoll: number;
  private readonly maxSourceBytes: number;

  constructor(private readonly store: CrmStore, options: InboundMailWatcherOptions = {}) {
    this.pollMs = options.pollMs ?? 120_000;
    this.lookbackDays = options.lookbackDays ?? 7;
    this.overlapMinutes = options.overlapMinutes ?? 15;
    this.maxMessagesPerPoll = options.maxMessagesPerPoll ?? 40;
    this.maxSourceBytes = options.maxSourceBytes ?? 2 * 1024 * 1024;
  }

  start() {
    if (this.timer) return;
    void this.synchronize();
    this.timer = setInterval(() => {
      void this.synchronize();
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  watchedUsers() {
    return this.store.users.filter((user) =>
      user.status === "active"
      && user.inboundSyncEnabled
      && !!user.imapHost
      && !!user.imapUser
      && !!user.imapPassword
    );
  }

  async synchronize() {
    if (this.running) return;
    this.running = true;
    let touched = false;
    try {
      const users = this.watchedUsers();
      for (let index = 0; index < users.length; index += 3) {
        const batch = users.slice(index, index + 3);
        await Promise.all(batch.map(async (user) => {
          try {
            await this.synchronizeUser(user, false);
          } catch {
            /* 单个邮箱失败只记录该账号状态，不阻断其他账号同步。 */
          }
          touched = true;
        }));
      }
      if (touched) await this.store.persist();
    } finally {
      this.running = false;
    }
  }

  async synchronizeUser(user: User, persist = true) {
    if (this.syncingUsers.has(user.id)) {
      throw new Error("该邮箱正在同步，请稍后再试");
    }
    this.syncingUsers.add(user.id);
    try {
      const summary = await this.syncUser(user);
      user.lastInboundSyncAt = new Date().toISOString();
      user.lastInboundSyncStatus = "ok";
      user.lastInboundSyncError = "";
      if (persist) await this.store.persist();
      return summary;
    } catch (error) {
      user.lastInboundSyncAt = new Date().toISOString();
      user.lastInboundSyncStatus = "error";
      user.lastInboundSyncError =
        error instanceof Error ? error.message : String(error || "IMAP 同步失败");
      if (persist) await this.store.persist();
      throw error;
    } finally {
      this.syncingUsers.delete(user.id);
    }
  }

  async testUserConnection(user: User) {
    const client = new ImapFlow({
      host: user.imapHost!,
      port: Number(user.imapPort || 993),
      secure: user.imapSecure ?? true,
      auth: { user: user.imapUser!, pass: user.imapPassword! },
      logger: false,
      emitLogs: false
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      lock.release();
      return { ok: true };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private sinceDate(user: User) {
    const fallback = Date.now() - this.lookbackDays * 86_400_000;
    if (!user.lastInboundSyncAt) return new Date(fallback);
    const last = new Date(user.lastInboundSyncAt).getTime();
    if (!Number.isFinite(last)) return new Date(fallback);
    return new Date(Math.max(fallback, last - this.overlapMinutes * 60_000));
  }

  async syncUser(user: User): Promise<InboundSyncSummary> {
    const summary: InboundSyncSummary = {
      scanned: 0, matched: 0, replies: 0, bounces: 0, skipped: 0, highestUid: 0
    };
    const client = new ImapFlow({
      host: user.imapHost!,
      port: Number(user.imapPort || 993),
      secure: user.imapSecure ?? true,
      auth: { user: user.imapUser!, pass: user.imapPassword! },
      logger: false,
      emitLogs: false
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailbox = client.mailbox;
        const uidValidity = mailbox ? mailbox.uidValidity.toString() : "";
        if (user.inboundUidValidity && uidValidity && user.inboundUidValidity !== uidValidity) {
          user.lastInboundUid = 0;
        }
        if (uidValidity) user.inboundUidValidity = uidValidity;
        const lastUid = Number(user.lastInboundUid || 0);
        const range = lastUid > 0
          ? { uid: `${lastUid + 1}:*` }
          : { since: this.sinceDate(user) };
        for await (const message of client.fetch(
          range,
          { uid: true, envelope: true, size: true, source: true }
        )) {
          if (summary.scanned >= this.maxMessagesPerPoll) break;
          summary.scanned += 1;
          if (message.uid) {
            summary.highestUid = Math.max(summary.highestUid, message.uid);
            user.lastInboundUid = Math.max(Number(user.lastInboundUid || 0), message.uid);
          }
          const source = message.source;
          if (!source || source.length > this.maxSourceBytes) {
            summary.skipped += 1;
            continue;
          }
          try {
            const applied = await this.applyMessage(user, source);
            if (applied === "reply") { summary.matched += 1; summary.replies += 1; }
            else if (applied === "bounce") { summary.matched += 1; summary.bounces += 1; }
            else summary.skipped += 1;
          } catch {
            summary.skipped += 1;
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return summary;
  }

  private findLog(user: User, messageIds: string[], fromAddress: string, recipients: string[]) {
    const owned = this.store.outboundEmailLogs.filter((item) => item.ownerId === user.id);
    for (const id of messageIds) {
      const hit = owned.find((item) => item.messageId === id);
      if (hit) return hit;
    }
    const addresses = [fromAddress, ...recipients].filter(Boolean);
    for (const address of addresses) {
      const hit = owned
        .filter((item) => (item.to || "").toLowerCase() === address)
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0];
      if (hit) return hit;
    }
    return undefined;
  }

  private candidateOfLog(log: OutboundEmailLog): WebsiteOpportunity | undefined {
    if (log.entityType !== "prospect_candidate" || !log.entityId) return undefined;
    return this.store.websiteOpportunities.find((item) => item.id === log.entityId);
  }

  async applyMessage(user: User, source: Buffer | string) {
    const rawSource = typeof source === "string" ? source : source.toString("utf8");
    const parsed = await simpleParser(rawSource);
    const bounce = isBounceMessage(parsed, rawSource);
    const hints = bounce ? extractBounceHints(rawSource) : { messageIds: [], recipients: [] };
    const ids = [...messageIdCandidates(parsed), ...hints.messageIds];
    const log = this.findLog(user, ids, senderAddress(parsed), hints.recipients);
    if (!log) return "unmatched" as const;

    const inboundMessageId = normalizeMessageIdValue(String(parsed.messageId || ""))
      || `${log.messageId}:${bounce ? "bounce" : "reply"}`;
    const inboundRequestId = `imap:${inboundMessageId}`;
    if (this.store.prospectTouchpoints.some((item) =>
      item.ownerId === log.ownerId && item.requestId === inboundRequestId
    )) return "duplicate" as const;
    const occurredAt = (parsed.date || new Date()).toISOString();
    const classification: ProspectReplyClassification = bounce
      ? "bounced"
      : classifyInboundReply(parsed);
    const subject = (parsed.subject || (bounce ? "退信通知" : "客户回信")).slice(0, 200);
    const content = bodyText(parsed).slice(0, 4000);

    if (bounce) {
      if (log.bouncedAt) return "duplicate" as const;
      log.bouncedAt = occurredAt;
    } else {
      if (log.repliedAt && log.repliedAt === occurredAt) return "duplicate" as const;
      log.repliedAt = log.repliedAt || occurredAt;
    }

    const candidate = this.candidateOfLog(log);
    let genericTouchpointId = "";
    if (candidate) {
      await recordProspectTouchpoint(this.store, {
        candidate,
        actorId: candidate.ownerId,
        recordMode: "inbound_reply",
        channel: "email",
        direction: "inbound",
        contactValue: senderAddress(parsed) || log.to,
        subject,
        content,
        replyClassification: classification,
        requestId: inboundRequestId,
        occurredAt,
        messageId: log.messageId,
        eventType: bounce ? "bounce" : "reply"
      });
    } else {
      genericTouchpointId = recordCrmEmailTouchpoint(this.store, log, {
        eventType: bounce ? "bounce" : "reply",
        direction: "inbound",
        occurredAt,
        subject,
        content,
        contactValue: senderAddress(parsed) || log.to,
        replyClassification: classification,
        requestId: inboundRequestId
      })?.id || "";
    }
    if (log.entityType === "lead" && log.entityId) {
      this.store.leadActivities.unshift({
        id: `la_imap_${inboundMessageId.slice(0, 24)}_${Date.now()}`,
        leadId: log.entityId,
        type: "email",
        content: bounce
          ? `开发信退信：${subject}`
          : `收到客户回信：${subject}`,
        operatorId: log.ownerId,
        nextFollowAt: "",
        createdAt: occurredAt
      });
    } else if (log.entityType === "customer" && log.entityId) {
      this.store.customerActivities.unshift({
        id: `ca_imap_${inboundMessageId.slice(0, 24)}_${Date.now()}`,
        customerId: log.entityId,
        type: "email",
        content: bounce
          ? `开发信退信：${subject}`
          : `收到客户回信：${subject}`,
        operatorId: log.ownerId,
        nextReminder: "",
        createdAt: occurredAt
      });
    }
    const followUpKey = `email-return:${inboundMessageId}:todo`;
    if (!candidate && !this.store.todos.some((item) => item.triggerKey === followUpKey)) {
      const relatedName = log.entityType === "lead"
        ? this.store.leads.find((item) => item.id === log.entityId)?.company
        : log.entityType === "customer"
          ? this.store.customers.find((item) => item.id === log.entityId)?.company
          : log.to;
      this.store.todos.unshift({
        id: `todo_email_${randomUUID()}`,
        title: bounce ? `处理开发信退信：${relatedName || log.to}` : `跟进客户回信：${relatedName || log.to}`,
        type: "customer",
        priority: "high",
        status: "pending",
        pinState: "",
        sortOrder: 0,
        dueAt: new Date(Date.now() + (bounce ? 0 : 24 * 60 * 60 * 1000)).toISOString(),
        ownerId: log.ownerId,
        teamId: log.teamId,
        related: relatedName || log.to,
        done: false,
        createdAt: new Date().toISOString(),
        historyAt: "",
        leadId: log.entityType === "lead" ? log.entityId : undefined,
        customerId: log.entityType === "customer" ? log.entityId : undefined,
        outreachChannel: "email",
        touchpointId: genericTouchpointId || undefined,
        triggerKey: followUpKey
      });
    }
    const notificationKey = `email-return:${inboundMessageId}`;
    if (!this.store.internalMessages.some((item) => item.idempotencyKey === notificationKey)) {
      const objectName = log.entityType === "lead"
        ? this.store.leads.find((item) => item.id === log.entityId)?.company
        : log.entityType === "customer"
          ? this.store.customers.find((item) => item.id === log.entityId)?.company
          : this.candidateOfLog(log)?.company;
      const now = new Date().toISOString();
      this.store.internalMessages.unshift({
        id: `msg_${randomUUID()}`,
        threadId: `email_${log.messageId}`.slice(0, 64),
        senderId: "system",
        recipientId: log.ownerId,
        teamId: log.teamId,
        type: "system",
        subject: bounce ? "开发信发生退信" : "收到开发信回复",
        content: `${objectName || log.to} · ${subject}`.slice(0, 5000),
        relatedType: "email_return",
        relatedId: log.messageId,
        idempotencyKey: notificationKey,
        readAt: "",
        createdAt: now,
        updatedAt: now
      });
    }
    return bounce ? ("bounce" as const) : ("reply" as const);
  }
}
