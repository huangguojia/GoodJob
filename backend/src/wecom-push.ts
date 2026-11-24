/**
 * 企业微信消息推送中心。
 *
 * 两种推送方式（官方接口）：
 *  - 自建应用：CorpID + AgentID + Secret → gettoken → message/send，能推给「某一个人」。
 *    收件人可以写邮箱（服务端用 user/get_userid_by_email 换成成员账号）或直接写成员账号。
 *    注意：2022 年后新建的自建应用必须在后台「企业可信 IP」里加上 CRM 服务器的公网 IP，否则 60020。
 *  - 群机器人：一个 Webhook 地址，推到群里，不需要可信 IP，但不能私聊指定人。
 *
 * 推什么由规则决定：开发信首次被打开 / 再次打开 / 点击链接 / 客户回信 / 广告表单新线索。
 * 事件来源见 crm-events.ts；同一个事件（同一封信的同一种动作）只推一次。
 */
import { randomUUID } from "node:crypto";
import { decryptSecretValue, encryptSecretValue } from "./credential-security.js";
import { onCrmEvent, emitCrmEvent, type CrmEvent } from "./crm-events.js";
import { readJsonSetting, writeJsonSetting } from "./json-settings.js";
import { getStore } from "./store.js";

export interface WecomPushRules {
  emailOpened: boolean;
  emailReopened: boolean;
  emailClicked: boolean;
  emailReplied: boolean;
  leadAds: boolean;
  /** 一轮开发信发完、总结 Excel 已发回各发件邮箱 */
  outreachSummary: boolean;
  /** 自动流一轮把信发完了（不等总结邮件，先报一句「发完了」） */
  outreachRound: boolean;
}

export interface WecomPushSettings {
  enabled: boolean;
  mode: "app" | "robot";
  corpId: string;
  agentId: string;
  secretEnc: string;
  robotWebhookEnc: string;
  /** 推给发这封信的业务员本人（按 CRM 账号邮箱匹配企业微信成员，仅自建应用模式） */
  sendToOwner: boolean;
  /** 额外接收人：邮箱或企业微信成员账号（UserID） */
  recipients: string[];
  rules: WecomPushRules;
  updatedAt: string;
  updatedBy: string;
}

export interface WecomPushLogEntry {
  id: string;
  at: string;
  key: string;
  event: string;
  title: string;
  recipients: string;
  status: "sent" | "failed" | "skipped";
  message: string;
}

export const DEFAULT_WECOM_RULES: WecomPushRules = {
  emailOpened: true,
  emailReopened: false,
  emailClicked: true,
  emailReplied: true,
  leadAds: true,
  outreachSummary: true,
  outreachRound: true
};

const emptySettings = (): WecomPushSettings => ({
  enabled: false,
  mode: "app",
  corpId: "",
  agentId: "",
  secretEnc: "",
  robotWebhookEnc: "",
  sendToOwner: false,
  recipients: [],
  rules: { ...DEFAULT_WECOM_RULES },
  updatedAt: "",
  updatedBy: ""
});

const settingsKey = (teamId: string) => `notify.wecom:${teamId}`;
const logKey = (teamId: string) => `notify.wecom.log:${teamId}`;
const LOG_LIMIT = 200;

/** 单实例写穿缓存：避免每次打开/点击/回复事件都查库并反序列化 200 条推送日志 */
const wecomSettingsCache = new Map<string, WecomPushSettings>();
const wecomLogCache = new Map<string, WecomPushLogEntry[]>();
const wecomSentKeyCache = new Map<string, Set<string>>();

function useWecomCache() {
  return process.env.NODE_ENV !== "test";
}

export function wecomApiBase() {
  return (process.env.WECOM_API_BASE_URL || "https://qyapi.weixin.qq.com").replace(/\/+$/u, "");
}

export async function readWecomSettings(teamId: string): Promise<WecomPushSettings> {
  if (useWecomCache()) {
    const cached = wecomSettingsCache.get(teamId);
    if (cached) return { ...cached, recipients: [...cached.recipients], rules: { ...cached.rules } };
  }
  const stored = await readJsonSetting<Partial<WecomPushSettings>>(settingsKey(teamId), {});
  const base = emptySettings();
  const normalized: WecomPushSettings = {
    ...base,
    ...stored,
    recipients: Array.isArray(stored.recipients) ? stored.recipients.map(String).filter(Boolean).slice(0, 20) : base.recipients,
    rules: { ...DEFAULT_WECOM_RULES, ...(stored.rules || {}) }
  };
  if (useWecomCache()) wecomSettingsCache.set(teamId, normalized);
  return { ...normalized, recipients: [...normalized.recipients], rules: { ...normalized.rules } };
}

export async function writeWecomSettings(teamId: string, settings: WecomPushSettings) {
  await writeJsonSetting(settingsKey(teamId), settings);
  if (useWecomCache()) {
    wecomSettingsCache.set(teamId, { ...settings, recipients: [...settings.recipients], rules: { ...settings.rules } });
  }
}

export function encryptWecomSecret(teamId: string, kind: "secret" | "robot", value: string) {
  return encryptSecretValue("wecom-push", `${teamId}|${kind}`, value);
}

function decryptWecomSecret(teamId: string, kind: "secret" | "robot", value: string) {
  try {
    return decryptSecretValue("wecom-push", `${teamId}|${kind}`, value);
  } catch {
    return "";
  }
}

export async function readWecomLog(teamId: string) {
  if (useWecomCache()) {
    const cached = wecomLogCache.get(teamId);
    if (cached) return [...cached];
  }
  const log = await readJsonSetting<WecomPushLogEntry[]>(logKey(teamId), []);
  if (useWecomCache()) {
    wecomLogCache.set(teamId, log);
    wecomSentKeyCache.set(teamId, new Set(log.filter((item) => item.status === "sent").map((item) => item.key)));
  }
  return [...log];
}

async function hasSentWecomKey(teamId: string, key: string) {
  if (useWecomCache()) {
    let keys = wecomSentKeyCache.get(teamId);
    if (!keys) {
      await readWecomLog(teamId);
      keys = wecomSentKeyCache.get(teamId);
    }
    return Boolean(keys?.has(key));
  }
  const log = await readWecomLog(teamId);
  return log.some((entry) => entry.key === key && entry.status === "sent");
}

async function appendWecomLog(teamId: string, entry: Omit<WecomPushLogEntry, "id" | "at">) {
  const log = await readWecomLog(teamId);
  const record: WecomPushLogEntry = { id: `wp_${randomUUID()}`, at: new Date().toISOString(), ...entry };
  log.unshift(record);
  const trimmed = log.slice(0, LOG_LIMIT);
  await writeJsonSetting(logKey(teamId), trimmed);
  if (useWecomCache()) {
    wecomLogCache.set(teamId, trimmed);
    if (record.status === "sent") {
      let keys = wecomSentKeyCache.get(teamId);
      if (!keys) {
        keys = new Set(trimmed.filter((item) => item.status === "sent").map((item) => item.key));
        wecomSentKeyCache.set(teamId, keys);
      } else {
        keys.add(record.key);
      }
    }
  }
}

// ---------- 企业微信官方接口 ----------
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const userIdCache = new Map<string, { userId: string; expiresAt: number }>();

/** 把企业微信 errcode 翻成人话（最常见的几种直接给出处理办法） */
export function wecomErrorText(errcode: number, errmsg: string) {
  const hints: Record<number, string> = {
    40001: "Secret 不对，或者不属于这个应用",
    40013: "CorpID 不对",
    40014: "访问令牌失效",
    42001: "访问令牌过期",
    40056: "AgentID 不对",
    60020: "CRM 服务器的公网 IP 不在这个应用的「企业可信 IP」里：到企业微信管理后台 → 应用管理 → 这个应用 → 企业可信 IP，把服务器 IP 加进去",
    46004: "企业微信里找不到这个成员",
    60111: "企业微信里找不到这个成员",
    46013: "这个邮箱没有绑定企业微信成员",
    81013: "接收人都不在这个应用的可见范围内：到应用的「可见范围」里把他加上",
    48002: "应用没有这个接口权限：通讯录读取需要在应用的「可见范围」里包含该成员",
    45009: "调用太频繁，稍后再试",
    93000: "群机器人 Webhook 地址无效",
    93004: "群机器人已被移出群或停用"
  };
  return `${hints[errcode] || errmsg || "企业微信返回错误"}（errcode ${errcode}）`;
}

async function wecomFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${wecomApiBase()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`企业微信接口 HTTP ${response.status}`);
  return body;
}

async function wecomAccessToken(corpId: string, secret: string, force = false) {
  const cacheKey = `${corpId}|${secret.slice(0, 6)}${secret.length}`;
  const cached = tokenCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = await wecomFetch(`/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`);
  const errcode = Number(body.errcode || 0);
  if (errcode !== 0) throw new Error(wecomErrorText(errcode, String(body.errmsg || "")));
  const token = String(body.access_token || "");
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + Math.max(300, Number(body.expires_in || 7200)) * 1000 });
  return token;
}

/** 调需要 access_token 的接口；令牌失效时自动换一次 */
async function wecomCall(corpId: string, secret: string, path: string, payload: unknown) {
  for (const force of [false, true]) {
    const token = await wecomAccessToken(corpId, secret, force);
    const body = await wecomFetch(`${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const errcode = Number(body.errcode || 0);
    if (!force && [40014, 42001, 41001].includes(errcode)) continue;
    return body;
  }
  return {};
}

/** 邮箱 → 企业微信成员账号：先按企业邮箱查，再按个人邮箱查 */
export async function resolveWecomUserId(corpId: string, secret: string, recipient: string) {
  const value = recipient.trim();
  if (!value.includes("@")) return value;
  const cacheKey = `${corpId}|${value.toLowerCase()}`;
  const cached = userIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;
  let lastError = "";
  for (const emailType of [1, 2]) {
    const body = await wecomCall(corpId, secret, "/cgi-bin/user/get_userid_by_email", { email: value, email_type: emailType });
    const errcode = Number(body.errcode || 0);
    if (errcode === 0 && body.userid) {
      const userId = String(body.userid);
      userIdCache.set(cacheKey, { userId, expiresAt: Date.now() + 24 * 3600_000 });
      return userId;
    }
    lastError = wecomErrorText(errcode, String(body.errmsg || ""));
  }
  throw new Error(`${value}：${lastError}`);
}

export interface WecomSendResult {
  ok: boolean;
  delivered: string[];
  failed: Array<{ recipient: string; reason: string }>;
  message: string;
}

/** 发一条 markdown 消息。recipients 为空时：应用模式什么都不发，机器人模式发到群里。 */
export async function sendWecomMarkdown(teamId: string, settings: WecomPushSettings, content: string, recipients: string[]): Promise<WecomSendResult> {
  if (settings.mode === "robot") {
    const webhook = decryptWecomSecret(teamId, "robot", settings.robotWebhookEnc);
    if (!webhook) return { ok: false, delivered: [], failed: [], message: "还没有填写群机器人 Webhook 地址" };
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const errcode = Number(body.errcode ?? (response.ok ? 0 : -1));
    return errcode === 0
      ? { ok: true, delivered: ["群机器人"], failed: [], message: "已推送到群" }
      : { ok: false, delivered: [], failed: [{ recipient: "群机器人", reason: wecomErrorText(errcode, String(body.errmsg || "")) }], message: wecomErrorText(errcode, String(body.errmsg || "")) };
  }

  const secret = decryptWecomSecret(teamId, "secret", settings.secretEnc);
  if (!settings.corpId || !settings.agentId || !secret) {
    return { ok: false, delivered: [], failed: [], message: "自建应用的 CorpID、AgentID、Secret 还没填全" };
  }
  const unique = [...new Set(recipients.map((item) => item.trim()).filter(Boolean))];
  if (!unique.length) return { ok: false, delivered: [], failed: [], message: "没有接收人" };
  const failed: WecomSendResult["failed"] = [];
  const userIds = new Map<string, string>();
  for (const recipient of unique) {
    try {
      userIds.set(await resolveWecomUserId(settings.corpId, secret, recipient), recipient);
    } catch (error) {
      failed.push({ recipient, reason: error instanceof Error ? error.message : "找不到这个成员" });
    }
  }
  if (!userIds.size) return { ok: false, delivered: [], failed, message: failed.map((item) => item.reason).join("；") };
  const body = await wecomCall(settings.corpId, secret, "/cgi-bin/message/send", {
    touser: [...userIds.keys()].join("|"),
    msgtype: "markdown",
    agentid: Number(settings.agentId),
    markdown: { content },
    enable_duplicate_check: 1,
    duplicate_check_interval: 600
  });
  const errcode = Number(body.errcode || 0);
  if (errcode !== 0) {
    const reason = wecomErrorText(errcode, String(body.errmsg || ""));
    return { ok: false, delivered: [], failed: [...failed, ...[...userIds.values()].map((recipient) => ({ recipient, reason }))], message: reason };
  }
  const invalid = String(body.invaliduser || "").split("|").filter(Boolean);
  for (const userId of invalid) failed.push({ recipient: userIds.get(userId) || userId, reason: "不在应用可见范围或账号无效" });
  const delivered = [...userIds.entries()].filter(([userId]) => !invalid.includes(userId)).map(([, recipient]) => recipient);
  return {
    ok: delivered.length > 0,
    delivered,
    failed,
    message: delivered.length ? `已推送给 ${delivered.join("、")}` : failed.map((item) => item.reason).join("；")
  };
}

// ---------- 事件 → 消息 ----------
function shortTime(iso: string) {
  const date = new Date(iso || Date.now());
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** markdown 里不能让客户内容打断格式 */
function safe(text: string, max = 120) {
  const value = String(text || "").replace(/[\r\n]+/g, " ").replace(/[<>`*]/g, "").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function ownerOf(ownerId: string) {
  return getStore().users.find((user) => user.id === ownerId);
}

export function renderWecomEvent(event: CrmEvent): { title: string; content: string; ruleKey: keyof WecomPushRules; dedupeKey: string } | null {
  const owner = "ownerId" in event ? ownerOf(event.ownerId) : undefined;
  const ownerLine = owner ? `\n> 负责人：${safe(owner.name, 30)}` : "";
  if (event.type === "email.opened") {
    const reopen = event.openCount > 1;
    return {
      title: reopen ? "开发信再次被打开" : "开发信被打开",
      ruleKey: reopen ? "emailReopened" : "emailOpened",
      dedupeKey: `open:${event.messageId}:${reopen ? event.openCount : 1}`,
      content: `**${reopen ? `开发信再次被打开（第 ${event.openCount} 次）` : "开发信被打开"}**\n> 客户：<font color="info">${safe(event.company || event.to, 60)}</font>\n> 收件人：${safe(event.to, 80)}\n> 主题：${safe(event.subject)}${ownerLine}\n> 时间：<font color="comment">${shortTime(event.occurredAt)}</font>`
    };
  }
  if (event.type === "email.clicked") {
    return {
      title: "开发信里的链接被点击",
      ruleKey: "emailClicked",
      dedupeKey: `click:${event.messageId}:${event.url}`,
      content: `**开发信里的链接被点击**\n> 客户：<font color="info">${safe(event.company || event.to, 60)}</font>\n> 收件人：${safe(event.to, 80)}\n> 主题：${safe(event.subject)}\n> 点击了：${safe(event.url, 100)}${ownerLine}\n> 时间：<font color="comment">${shortTime(event.occurredAt)}</font>`
    };
  }
  if (event.type === "email.replied") {
    return {
      title: "客户回信了",
      ruleKey: "emailReplied",
      dedupeKey: `reply:${event.messageId}:${event.replySubject}:${event.occurredAt.slice(0, 16)}`,
      content: `**<font color="warning">客户回信了</font>**\n> 客户：<font color="info">${safe(event.company || event.from, 60)}</font>\n> 发件人：${safe(event.from, 80)}\n> 回信主题：${safe(event.replySubject || event.subject)}\n> 原开发信：${safe(event.subject)}${event.snippet ? `\n> 内容：${safe(event.snippet, 160)}` : ""}${ownerLine}\n> 时间：<font color="comment">${shortTime(event.occurredAt)}</font>`
    };
  }
  if (event.type === "lead.ads") {
    return {
      title: "新的广告表单线索",
      ruleKey: "leadAds",
      dedupeKey: `lead:${event.leadId}`,
      content: `**新的 Facebook 表单线索**\n> 公司：<font color="info">${safe(event.company, 60)}</font>\n> 联系人：${safe(event.contact, 40)}${event.email ? `\n> 邮箱：${safe(event.email, 80)}` : ""}${event.phone ? `\n> 电话：${safe(event.phone, 40)}` : ""}${event.campaign ? `\n> 广告：${safe(event.campaign, 80)}` : ""}${ownerLine}\n> 时间：<font color="comment">${shortTime(event.occurredAt)}</font>`
    };
  }
  if (event.type === "outreach.round") {
    const failedLine = event.failed ? `\n> 失败：<font color="warning">${event.failed} 封</font>` : "";
    return {
      title: "自动流本轮已发完",
      ruleKey: "outreachRound",
      dedupeKey: `round:${event.batchId}`,
      content: `**自动流本轮开发信已发完**\n> 批次：${safe(event.batchLabel, 40)}\n> 已发出：<font color="info">${event.sent} 封</font> · 覆盖客户 ${event.customers} 家${failedLine}\n> 发件邮箱：${event.senders} 个\n> 发送总结（客户清单 / 背调详情 / 开发信原文）会随后寄到各发件邮箱${ownerLine}\n> 时间：<font color="comment">${shortTime(event.occurredAt)}</font>`
    };
  }
  if (event.type === "outreach.summary") {
    return {
      title: "开发信发送总结已发出",
      ruleKey: "outreachSummary",
      dedupeKey: `summary:${event.batchId}`,
      content: `**开发信发送总结已生成**\n> 批次：${safe(event.batchLabel, 40)}\n> 发件邮箱：${event.deliveries} 个（成功 ${event.sentEmails}${event.failedEmails ? ` · 失败 ${event.failedEmails}` : ""}）\n> 覆盖客户：${event.customers} 家 · 信件 ${event.letters} 封\n> 已发到各发件邮箱的收件箱，附件含客户清单、背调详情、开发信原文${ownerLine}\n> 时间：<font color="comment">${shortTime(event.occurredAt)}</font>`
    };
  }
  return null;
}

/** 这条事件该推给谁：额外接收人 + （可选）负责人本人的 CRM 邮箱 */
export function wecomRecipientsFor(settings: WecomPushSettings, ownerId: string) {
  const recipients = [...settings.recipients];
  if (settings.sendToOwner) {
    const owner = ownerOf(ownerId);
    if (owner?.email) recipients.push(owner.email);
  }
  return [...new Set(recipients.map((item) => item.trim()).filter(Boolean))];
}

/** 同一个公司的推送排队执行：两条相同事件几乎同时到达时，第二条要能看到第一条的推送记录（去重才可靠） */
const teamQueues = new Map<string, Promise<void>>();

export function deliverCrmEventToWecom(event: CrmEvent) {
  const previous = teamQueues.get(event.teamId) || Promise.resolve();
  const next = previous.then(() => deliverNow(event)).catch((error) => {
    console.warn(`[wecom-push] 推送失败：${error instanceof Error ? error.message : String(error)}`);
  });
  teamQueues.set(event.teamId, next);
  void next.finally(() => { if (teamQueues.get(event.teamId) === next) teamQueues.delete(event.teamId); });
  return next;
}

async function deliverNow(event: CrmEvent) {
  if (event.type === "mail.inbound") return;
  const rendered = renderWecomEvent(event);
  if (!rendered) return;
  const settings = await readWecomSettings(event.teamId);
  if (!settings.enabled || !settings.rules[rendered.ruleKey]) return;
  if (await hasSentWecomKey(event.teamId, rendered.dedupeKey)) return;
  const recipients = wecomRecipientsFor(settings, event.ownerId);
  try {
    const result = await sendWecomMarkdown(event.teamId, settings, rendered.content, recipients);
    await appendWecomLog(event.teamId, {
      key: rendered.dedupeKey,
      event: event.type,
      title: rendered.title,
      recipients: settings.mode === "robot" ? "群机器人" : recipients.join("、"),
      status: result.ok ? "sent" : "failed",
      message: result.message
    });
  } catch (error) {
    await appendWecomLog(event.teamId, {
      key: rendered.dedupeKey,
      event: event.type,
      title: rendered.title,
      recipients: recipients.join("、"),
      status: "failed",
      message: error instanceof Error ? error.message : "推送失败"
    });
  }
}

// ---------- 开发信台账辅助 ----------
const normalizeMessageId = (value: string) => String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();

/** 台账里这封信发给了哪家公司（客户 / 线索 / 搜客候选） */
export function outboundLogCompany(log: { entityType?: string; entityId?: string; to?: string }) {
  const store = getStore();
  if (!log.entityId) return "";
  if (log.entityType === "customer") return store.customers.find((item) => item.id === log.entityId)?.company || "";
  if (log.entityType === "lead") return store.leads.find((item) => item.id === log.entityId)?.company || "";
  if (log.entityType === "prospect_candidate" || log.entityType === "prospect") {
    return store.websiteOpportunities.find((item) => item.id === log.entityId)?.company || "";
  }
  return "";
}

/**
 * 邮件中心同步到一封来信：In-Reply-To 指向我们发出的开发信 → 记为回信，并发出 email.replied。
 * （IMAP 回信监听那条路径自己会发 email.replied，这里补的是只开了邮件中心同步的情况。）
 */
async function handleInboundMail(event: Extract<CrmEvent, { type: "mail.inbound" }>) {
  const target = normalizeMessageId(event.inReplyTo);
  if (!target) return;
  const store = getStore();
  const log = store.outboundEmailLogs.find((item) => item.teamId === event.teamId && normalizeMessageId(item.messageId) === target);
  if (!log) return;
  if (!log.repliedAt) {
    log.repliedAt = event.occurredAt;
    await store.persist().catch(() => undefined);
  }
  emitCrmEvent({
    type: "email.replied",
    teamId: log.teamId,
    ownerId: log.ownerId,
    logId: log.id,
    messageId: log.messageId,
    to: log.to || "",
    subject: log.subject || "",
    company: outboundLogCompany(log),
    from: event.from,
    replySubject: event.subject,
    snippet: event.snippet,
    occurredAt: event.occurredAt
  });
}

let registered = false;
export function registerWecomPushHandlers() {
  if (registered) return;
  registered = true;
  onCrmEvent(async (event) => {
    if (event.type === "mail.inbound") {
      await handleInboundMail(event);
      return;
    }
    await deliverCrmEventToWecom(event);
  });
}
