import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { developmentEmailAngles } from "./development-email-skill.js";
import type { CrmStore } from "./store.js";
import type {
  Customer,
  Lead,
  OutboundEmailLog,
  ProspectReplyClassification,
  ProspectTouchpoint,
  WebsiteOpportunity
} from "./types.js";

// ---------------------------------------------------------------------------
// 客户开发信过程档案（outreach journey）
//
// 解决的问题：发信批次 / 自动方案只能看到「某一次任务发到哪一步」，
// 看不到「这个客户从头到现在经历了什么」。本模块把散落在
// prospect_touchpoints / outbound_email_logs / 批次明细 / 背调记录里的信息，
// 按「客户主体」聚合成一条可留档、可跳转、可继续按阶段发信的完整时间线。
//
// 设计约束：
// - 只读聚合，不新建业务数据；唯二写入口是背调留档表与「按阶段发下一封」（后者复用既有发信通道）。
// - 阶段是「推导值」而不是落库字段：口径来自触达轨迹，改口径不需要迁移数据。
// ---------------------------------------------------------------------------

export type OutreachJourneyEntityType = "customer" | "lead" | "prospect_candidate";

export type OutreachJourneyStageKey =
  | "not_contacted"
  | "first_touch_sent"
  | "following_up"
  | "replied_interested"
  | "replied_negative"
  | "bounced"
  | "converted";

export interface OutreachJourneyStageMeta {
  key: OutreachJourneyStageKey;
  label: string;
  tone: "gray" | "amber" | "green" | "red" | "blue";
  description: string;
  nextStepLabel: string;
  canSend: boolean;
  blockReason: string;
}

const STAGE_META: Record<OutreachJourneyStageKey, OutreachJourneyStageMeta> = {
  not_contacted: {
    key: "not_contacted",
    label: "未接触",
    tone: "gray",
    description: "还没有给这家客户发过开发信。",
    nextStepLabel: "发送首封开发信",
    canSend: true,
    blockReason: ""
  },
  first_touch_sent: {
    key: "first_touch_sent",
    label: "已发首触",
    tone: "amber",
    description: "首封开发信已投出，正在等待客户回复。",
    nextStepLabel: "发送第 2 封（补充价值与案例）",
    canSend: true,
    blockReason: ""
  },
  following_up: {
    key: "following_up",
    label: "跟进中",
    tone: "amber",
    description: "已发出 2 封及以上，客户仍未回复。",
    nextStepLabel: "发送下一封跟进（收尾式提醒）",
    canSend: true,
    blockReason: ""
  },
  replied_interested: {
    key: "replied_interested",
    label: "已回复·可推进",
    tone: "green",
    description: "客户已回信，属于可继续推进的信号。",
    nextStepLabel: "发送回复跟进信（承接需求）",
    canSend: true,
    blockReason: ""
  },
  replied_negative: {
    key: "replied_negative",
    label: "已回复·明确拒绝",
    tone: "red",
    description: "客户明确拒绝或要求退订，系统已停止向其发送。",
    nextStepLabel: "不再发送",
    canSend: false,
    blockReason: "客户已明确拒绝或要求退订，任何继续发送都会违反外发合规约束。"
  },
  bounced: {
    key: "bounced",
    label: "联系方式退信",
    tone: "red",
    description: "收件地址无效导致退信，需要先补充有效联系方式。",
    nextStepLabel: "先补充有效联系方式",
    canSend: false,
    blockReason: "上一次投递被退回，同一个地址再发还会失败；请先在客户资料里补一个有效邮箱。"
  },
  converted: {
    key: "converted",
    label: "已转线索 / 客户",
    tone: "blue",
    description: "这家客户已经回流到正式线索或客户档案，后续按正式业务流程跟进。",
    nextStepLabel: "在线索 / 客户流程中跟进",
    canSend: true,
    blockReason: ""
  }
};

export function outreachJourneyStageMeta(key: OutreachJourneyStageKey) {
  return STAGE_META[key];
}

const REPLY_LABELS: Record<ProspectReplyClassification, string> = {
  clear_demand: "明确需求",
  interested_nurture: "有兴趣待培育",
  referral: "转介绍",
  no_current_demand: "当前无需求",
  rejected: "明确拒绝",
  unsubscribed: "要求退订",
  bounced: "联系方式退信",
  auto_unknown: "自动回复 / 待判断"
};

const NEGATIVE_CLASSIFICATIONS: ProspectReplyClassification[] = ["rejected", "unsubscribed"];

export function outreachReplyLabel(value?: ProspectReplyClassification) {
  return value ? REPLY_LABELS[value] || value : "";
}

// ---------------------------------------------------------------------------
// 主体解析：把 customer / lead / prospect_candidate 三种入口归一到一条链
// customer ←(leads.convertedCustomerId)— lead ←(leads.externalId)— candidate
// ---------------------------------------------------------------------------

export interface OutreachJourneyEntity {
  entityType: OutreachJourneyEntityType;
  entityId: string;
  company: string;
  contact: string;
  email: string;
  country: string;
  website: string;
  ownerId: string;
  teamId: string;
  ownerName: string;
  customerId: string;
  leadId: string;
  candidateId: string;
  convertedToLead: boolean;
  convertedToCustomer: boolean;
  suppressed: boolean;
  suppressedReason: string;
  nextFollowAt: string;
}

function ownerNameOf(store: CrmStore, ownerId: string) {
  return store.users.find((user) => user.id === ownerId)?.name || "";
}

function emailFromCandidate(candidate: WebsiteOpportunity) {
  const direct = (candidate.contactInfo || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  return direct
    || (candidate.extractedContacts || []).flatMap((item) => item.emails || [])[0]
    || candidate.lastDevelopmentEmailTo
    || "";
}

export function resolveOutreachJourneyEntity(
  store: CrmStore,
  entityType: OutreachJourneyEntityType,
  entityId: string
): OutreachJourneyEntity | undefined {
  const id = (entityId || "").trim();
  if (!id) return undefined;

  let customer: Customer | undefined;
  let lead: Lead | undefined;
  let candidate: WebsiteOpportunity | undefined;

  if (entityType === "customer") {
    customer = store.customers.find((item) => item.id === id);
    if (!customer) return undefined;
    lead = store.leads.find((item) => item.convertedCustomerId === customer!.id && !item.deletedAt);
    if (lead?.externalId) candidate = store.websiteOpportunities.find((item) => item.id === lead!.externalId);
  } else if (entityType === "lead") {
    lead = store.leads.find((item) => item.id === id && !item.deletedAt);
    if (!lead) return undefined;
    if (lead.convertedCustomerId) customer = store.customers.find((item) => item.id === lead!.convertedCustomerId);
    if (lead.externalId) candidate = store.websiteOpportunities.find((item) => item.id === lead!.externalId);
  } else {
    candidate = store.websiteOpportunities.find((item) => item.id === id);
    if (!candidate) return undefined;
    if (candidate.leadId) lead = store.leads.find((item) => item.id === candidate!.leadId && !item.deletedAt);
    if (candidate.customerId) customer = store.customers.find((item) => item.id === candidate!.customerId);
    if (!customer && lead?.convertedCustomerId) {
      customer = store.customers.find((item) => item.id === lead!.convertedCustomerId);
    }
  }

  const ownerId = customer?.ownerId || lead?.ownerId || candidate?.ownerId || "";
  const teamId = customer?.teamId || lead?.teamId || candidate?.teamId || "";
  const suppressedReason = candidate?.excludedReason || "";

  return {
    entityType,
    entityId: id,
    company: customer?.company || lead?.company || candidate?.company || "",
    contact: customer?.contact || lead?.contact || candidate?.contact || "",
    email: customer?.email || lead?.email || (candidate ? emailFromCandidate(candidate) : ""),
    country: customer?.country || lead?.country || candidate?.country || "",
    website: customer?.website || candidate?.website || "",
    ownerId,
    teamId,
    ownerName: ownerNameOf(store, ownerId),
    customerId: customer?.id || "",
    leadId: lead?.id || "",
    candidateId: candidate?.id || "",
    convertedToLead: Boolean(lead),
    convertedToCustomer: Boolean(customer),
    suppressed: Boolean(suppressedReason),
    suppressedReason,
    nextFollowAt: candidate?.nextFollowAt || lead?.nextFollowAt || customer?.nextReminder || ""
  };
}

// ---------------------------------------------------------------------------
// 轨迹收集与聚合
// ---------------------------------------------------------------------------

export interface OutreachJourneyEmail {
  messageId: string;
  index: number;
  subject: string;
  bodyPreview: string;
  body: string;
  recipient: string;
  sentAt: string;
  source: string;
  sourceLabel: string;
  batchId: string;
  batchName: string;
  dispatchStatus: string;
  dispatchError: string;
  openCount: number;
  clickCount: number;
  firstOpenedAt: string;
  lastOpenedAt: string;
  lastClickedAt: string;
  repliedAt: string;
  bouncedAt: string;
}

export interface OutreachJourneyReply {
  id: string;
  occurredAt: string;
  eventType: string;
  classification: string;
  classificationLabel: string;
  subject: string;
  content: string;
  contactValue: string;
  messageId: string;
}

export interface OutreachJourneyTimelineEntry {
  kind: "send" | "open" | "click" | "reply" | "bounce" | "research" | "convert" | "reject";
  at: string;
  title: string;
  detail: string;
  tone: "gray" | "amber" | "green" | "red" | "blue";
}

const SOURCE_LABELS: Record<string, string> = {
  prospect_batch_send: "手动批次（搜客候选）",
  lead_batch_send: "手动批次（线索）",
  prospect_send: "搜客清单单发",
  development_email_send: "开发信工坊",
  agent_send: "AI Agent 发送",
  lead_send: "线索单发",
  outreach_plan: "自动发送方案",
  journey_stage_send: "开发信档案 · 按阶段发送"
};

export function outreachSourceLabel(source: string) {
  return SOURCE_LABELS[source] || source || "手动发送";
}

function textPreview(value: string, limit = 160) {
  const text = (value || "")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizeMessageId(value?: string) {
  return (value || "").trim().replace(/^</u, "").replace(/>$/u, "").toLowerCase();
}

interface JourneyScope {
  candidateIds: Set<string>;
  leadIds: Set<string>;
  customerIds: Set<string>;
}

function journeyScope(entity: OutreachJourneyEntity): JourneyScope {
  return {
    candidateIds: new Set([entity.candidateId].filter(Boolean)),
    leadIds: new Set([entity.leadId].filter(Boolean)),
    customerIds: new Set([entity.customerId].filter(Boolean))
  };
}

function touchpointInScope(touchpoint: ProspectTouchpoint, scope: JourneyScope) {
  if (touchpoint.prospectCandidateId && scope.candidateIds.has(touchpoint.prospectCandidateId)) return true;
  if (touchpoint.leadId && scope.leadIds.has(touchpoint.leadId)) return true;
  if (touchpoint.customerId && scope.customerIds.has(touchpoint.customerId)) return true;
  return false;
}

function logInScope(log: OutboundEmailLog, scope: JourneyScope) {
  if (log.entityType === "lead" && scope.leadIds.has(log.entityId)) return true;
  if (log.entityType === "customer" && scope.customerIds.has(log.entityId)) return true;
  if (log.entityType === "prospect_candidate" && scope.candidateIds.has(log.entityId)) return true;
  return false;
}

/** 找出该实体挂在哪几个批次 / 方案上（用于档案里显示"这一封是哪一批发的"） */
function batchLabelsFor(store: CrmStore, scope: JourneyScope) {
  const labels = new Map<string, string>();
  const matchItem = (item: { candidateId: string; leadId?: string }) =>
    (item.candidateId && scope.candidateIds.has(item.candidateId))
    || Boolean(item.leadId && scope.leadIds.has(item.leadId));
  for (const batch of store.prospectOutreachBatches) {
    if (batch.items.some(matchItem)) labels.set(batch.id, `手动批次 · ${batch.createdAt.slice(0, 16).replace("T", " ")}`);
  }
  for (const plan of store.prospectOutreachPlans) {
    if (plan.items.some(matchItem)) labels.set(plan.id, `自动方案 · ${plan.name}`);
  }
  return labels;
}

function collectOutreachEmails(
  store: CrmStore,
  scope: JourneyScope,
  batchLabels: Map<string, string>
): OutreachJourneyEmail[] {
  const indexByMessageId = new Map<string, OutreachJourneyEmail>();
  const indexByFallback = new Map<string, OutreachJourneyEmail>();
  const list: OutreachJourneyEmail[] = [];

  /**
   * 同一封信可能在两条链路各留一份记录：
   * ①投递台账 outbound_email_logs（一定有 messageId）
   * ②触达轨迹 prospect_touchpoints（新数据有 messageId，历史数据可能没有）
   * 因此按「messageId 优先、收件人+发送时刻兜底」两轮合并，避免同一封信被数成两封。
   */
  const fallbackKeyOf = (email: OutreachJourneyEmail) =>
    `${(email.recipient || "").toLowerCase()}|${email.sentAt}`;

  const mergeInto = (existing: OutreachJourneyEmail, incoming: OutreachJourneyEmail) => {
    Object.assign(existing, {
      ...incoming,
      messageId: existing.messageId || incoming.messageId,
      index: existing.index || incoming.index,
      body: existing.body || incoming.body,
      bodyPreview: existing.bodyPreview || incoming.bodyPreview,
      subject: existing.subject || incoming.subject,
      recipient: existing.recipient || incoming.recipient,
      source: existing.source || incoming.source,
      sourceLabel: existing.sourceLabel || incoming.sourceLabel,
      batchId: existing.batchId || incoming.batchId,
      batchName: existing.batchName || incoming.batchName,
      dispatchError: existing.dispatchError || incoming.dispatchError,
      openCount: Math.max(existing.openCount, incoming.openCount),
      clickCount: Math.max(existing.clickCount, incoming.clickCount),
      firstOpenedAt: existing.firstOpenedAt || incoming.firstOpenedAt,
      lastOpenedAt: existing.lastOpenedAt || incoming.lastOpenedAt,
      lastClickedAt: existing.lastClickedAt || incoming.lastClickedAt,
      repliedAt: existing.repliedAt || incoming.repliedAt,
      bouncedAt: existing.bouncedAt || incoming.bouncedAt
    });
  };

  const put = (email: OutreachJourneyEmail) => {
    if (email.messageId) {
      const existing = indexByMessageId.get(email.messageId);
      if (existing) {
        mergeInto(existing, email);
        return;
      }
      // 台账有 Message-ID、触达记录没有：靠兜底键认领已存在的那条
      const orphan = indexByFallback.get(fallbackKeyOf(email));
      if (orphan && !orphan.messageId) {
        mergeInto(orphan, email);
        indexByMessageId.set(email.messageId, orphan);
        indexByFallback.set(fallbackKeyOf(orphan), orphan);
        return;
      }
      const created = { ...email };
      list.push(created);
      indexByMessageId.set(email.messageId, created);
      indexByFallback.set(fallbackKeyOf(created), created);
      return;
    }
    const existing = indexByFallback.get(fallbackKeyOf(email));
    if (existing) {
      mergeInto(existing, email);
      return;
    }
    const created = { ...email };
    list.push(created);
    indexByFallback.set(fallbackKeyOf(created), created);
  };

  for (const log of store.outboundEmailLogs) {
    if (!logInScope(log, scope)) continue;
    put({
      messageId: normalizeMessageId(log.messageId),
      index: 0,
      subject: log.subject,
      bodyPreview: "",
      body: "",
      recipient: log.to,
      sentAt: log.sentAt,
      source: log.source,
      sourceLabel: outreachSourceLabel(log.source),
      batchId: "",
      batchName: "",
      dispatchStatus: log.dispatchStatus || "sent",
      dispatchError: log.dispatchError || "",
      openCount: log.openCount || 0,
      clickCount: log.clickCount || 0,
      firstOpenedAt: log.firstOpenedAt || "",
      lastOpenedAt: log.lastOpenedAt || "",
      lastClickedAt: log.lastClickedAt || "",
      repliedAt: log.repliedAt || "",
      bouncedAt: log.bouncedAt || ""
    });
  }

  for (const touchpoint of store.prospectTouchpoints) {
    if (!touchpointInScope(touchpoint, scope)) continue;
    if (touchpoint.direction !== "outbound") continue;
    if (touchpoint.eventType && touchpoint.eventType !== "send") continue;
    const messageId = normalizeMessageId(touchpoint.messageId);
    put({
      messageId,
      index: 0,
      subject: touchpoint.subject,
      bodyPreview: textPreview(touchpoint.content),
      body: touchpoint.content,
      recipient: touchpoint.contactValue,
      sentAt: touchpoint.occurredAt,
      source: "",
      sourceLabel: "",
      batchId: "",
      batchName: "",
      dispatchStatus: "sent",
      dispatchError: "",
      openCount: 0,
      clickCount: 0,
      firstOpenedAt: "",
      lastOpenedAt: "",
      lastClickedAt: "",
      repliedAt: "",
      bouncedAt: ""
    });
  }

  // 批次明细补充「第几封 / 属于哪个批次」——冻结载荷里没有 messageId，
  // 用收件人 + 发送时间就近匹配属于哪一批。
  for (const batch of store.prospectOutreachBatches) {
    for (const item of batch.items) {
      for (const step of item.steps) {
        if (step.status !== "sent" || !step.sentAt) continue;
        if (!item.recipient) continue;
        const target = list.find((email) =>
          !email.batchId
          && email.recipient
          && email.recipient.toLowerCase() === item.recipient.toLowerCase()
          && Math.abs(new Date(email.sentAt).getTime() - new Date(step.sentAt).getTime()) < 6 * 3600_000
        );
        if (!target) continue;
        target.batchId = batch.id;
        target.batchName = batchLabels.get(batch.id) || "";
        target.index = step.index + 1;
        target.subject = target.subject || step.subject;
        target.body = target.body || step.body;
        target.bodyPreview = target.bodyPreview || textPreview(step.body);
      }
    }
  }
  for (const plan of store.prospectOutreachPlans) {
    for (const item of plan.items) {
      for (const step of item.steps) {
        if (step.status !== "sent" || !step.sentAt) continue;
        if (!item.recipient) continue;
        const target = list.find((email) =>
          !email.batchId
          && email.recipient
          && email.recipient.toLowerCase() === item.recipient.toLowerCase()
          && Math.abs(new Date(email.sentAt).getTime() - new Date(step.sentAt).getTime()) < 6 * 3600_000
        );
        if (!target) continue;
        target.batchId = plan.id;
        target.batchName = batchLabels.get(plan.id) || "";
        target.index = step.index + 1;
        target.subject = target.subject || step.subject;
        target.body = target.body || step.body;
        target.bodyPreview = target.bodyPreview || textPreview(step.body);
      }
    }
  }

  const emails = [...list]
    .filter((email) => Boolean(email.sentAt))
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  emails.forEach((email, position) => {
    if (!email.index) email.index = position + 1;
    if (!email.sourceLabel) email.sourceLabel = outreachSourceLabel(email.source);
  });
  return emails;
}

function collectReplies(store: CrmStore, scope: JourneyScope): OutreachJourneyReply[] {
  return store.prospectTouchpoints
    .filter((touchpoint) => touchpointInScope(touchpoint, scope))
    .filter((touchpoint) => touchpoint.direction === "inbound")
    .filter((touchpoint) => touchpoint.eventType === "reply"
      || touchpoint.eventType === "bounce"
      || Boolean(touchpoint.replyClassification))
    .map((touchpoint) => ({
      id: touchpoint.id,
      occurredAt: touchpoint.occurredAt,
      eventType: touchpoint.eventType || "reply",
      classification: touchpoint.replyClassification || "",
      classificationLabel: outreachReplyLabel(touchpoint.replyClassification),
      subject: touchpoint.subject,
      content: touchpoint.content,
      contactValue: touchpoint.contactValue,
      messageId: normalizeMessageId(touchpoint.messageId)
    }))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

export interface OutreachJourneyStageSnapshot {
  key: OutreachJourneyStageKey;
  label: string;
  tone: OutreachJourneyStageMeta["tone"];
  description: string;
  nextStepLabel: string;
  canSend: boolean;
  blockReason: string;
  outboundCount: number;
  lastSentAt: string;
  lastReplyAt: string;
  lastReplyClassification: string;
  lastReplyLabel: string;
}

function deriveStage(
  entity: OutreachJourneyEntity,
  emails: OutreachJourneyEmail[],
  replies: OutreachJourneyReply[]
): OutreachJourneyStageSnapshot {
  const outboundCount = emails.length;
  const lastSentAt = emails.at(-1)?.sentAt || "";
  const lastReply = replies.at(-1);
  const lastReplyAt = lastReply?.occurredAt || "";
  const lastReplyClassification = lastReply?.classification || "";

  let key: OutreachJourneyStageKey;
  if (lastReply?.eventType === "bounce" || lastReplyClassification === "bounced") {
    key = "bounced";
  } else if (NEGATIVE_CLASSIFICATIONS.includes(lastReplyClassification as ProspectReplyClassification)) {
    key = "replied_negative";
  } else if (lastReply) {
    key = "replied_interested";
  } else if (entity.convertedToCustomer || entity.convertedToLead) {
    key = "converted";
  } else if (outboundCount >= 2) {
    key = "following_up";
  } else if (outboundCount === 1) {
    key = "first_touch_sent";
  } else {
    key = "not_contacted";
  }

  const meta = STAGE_META[key];
  let blockReason = meta.blockReason;
  let canSend = meta.canSend;
  if (canSend && !entity.email) {
    canSend = false;
    blockReason = "这家客户还没有可用邮箱，先补充联系方式再发信。";
  }
  return {
    key,
    label: meta.label,
    tone: meta.tone,
    description: meta.description,
    nextStepLabel: meta.nextStepLabel,
    canSend,
    blockReason,
    outboundCount,
    lastSentAt,
    lastReplyAt,
    lastReplyClassification,
    lastReplyLabel: outreachReplyLabel(lastReplyClassification as ProspectReplyClassification)
  };
}

// ---------------------------------------------------------------------------
// 背调留档（background_research_records）
// ---------------------------------------------------------------------------

export interface BackgroundResearchRecord {
  id: string;
  teamId: string;
  ownerId: string;
  entityType: string;
  entityId: string;
  company: string;
  country: string;
  score: number;
  verdict: string;
  summary: string;
  engine: string;
  crmOnly: boolean;
  payloadJson: string;
  createdAt: string;
  createdBy: string;
}

export async function ensureOutreachJourneySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS background_research_records (
      id VARCHAR(80) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL DEFAULT '',
      owner_id VARCHAR(64) NOT NULL DEFAULT '',
      entity_type VARCHAR(30) NOT NULL DEFAULT '',
      entity_id VARCHAR(90) NOT NULL DEFAULT '',
      company VARCHAR(255) NOT NULL DEFAULT '',
      country VARCHAR(80) NOT NULL DEFAULT '',
      score INT NOT NULL DEFAULT 0,
      verdict VARCHAR(160) NOT NULL DEFAULT '',
      summary TEXT NULL,
      engine VARCHAR(200) NOT NULL DEFAULT '',
      crm_only TINYINT(1) NOT NULL DEFAULT 0,
      payload_json JSON NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      KEY idx_bg_research_entity (team_id, entity_type, entity_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

interface BackgroundResearchRow extends RowDataPacket {
  id: string;
  team_id: string;
  owner_id: string;
  entity_type: string;
  entity_id: string;
  company: string;
  country: string;
  score: number;
  verdict: string;
  summary: string | null;
  engine: string;
  crm_only: number;
  payload_json: unknown;
  created_by: string;
  created_at: Date | string;
}

function toIso(value: Date | string | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToRecord(row: BackgroundResearchRow): BackgroundResearchRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    company: row.company,
    country: row.country,
    score: Number(row.score || 0),
    verdict: row.verdict,
    summary: row.summary || "",
    engine: row.engine,
    crmOnly: Boolean(row.crm_only),
    payloadJson: typeof row.payload_json === "string"
      ? row.payload_json
      : JSON.stringify(row.payload_json || null),
    createdAt: toIso(row.created_at),
    createdBy: row.created_by
  };
}

export class MysqlBackgroundResearchRepository {
  constructor(private readonly pool: Pool) {}

  async save(record: Omit<BackgroundResearchRecord, "id" | "createdAt"> & { id?: string }) {
    const id = record.id || `bgr_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO background_research_records
        (id, team_id, owner_id, entity_type, entity_id, company, country,
         score, verdict, summary, engine, crm_only, payload_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         company=VALUES(company), country=VALUES(country), score=VALUES(score),
         verdict=VALUES(verdict), summary=VALUES(summary), engine=VALUES(engine),
         crm_only=VALUES(crm_only), payload_json=VALUES(payload_json)`,
      [
        id,
        record.teamId,
        record.ownerId,
        record.entityType,
        record.entityId,
        record.company.slice(0, 255),
        record.country.slice(0, 80),
        Math.max(0, Math.min(100, Math.round(record.score || 0))),
        record.verdict.slice(0, 160),
        record.summary,
        record.engine.slice(0, 200),
        record.crmOnly ? 1 : 0,
        record.payloadJson,
        record.createdBy
      ]
    );
    return id;
  }

  async list(teamId: string, entityType: string, entityId: string, limit = 20) {
    const [rows] = await this.pool.query<BackgroundResearchRow[]>(
      `SELECT * FROM background_research_records
        WHERE team_id = ? AND entity_type = ? AND entity_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      [teamId, entityType, entityId, Math.max(1, Math.min(100, limit))]
    );
    return rows.map(rowToRecord);
  }
}

let backgroundResearchRepository: MysqlBackgroundResearchRepository | null = null;

export function setBackgroundResearchRepository(value: MysqlBackgroundResearchRepository | null) {
  backgroundResearchRepository = value;
}

export function getBackgroundResearchRepository() {
  return backgroundResearchRepository;
}

// ---------------------------------------------------------------------------
// 档案聚合
// ---------------------------------------------------------------------------

export interface OutreachJourneyResearchSummary {
  id: string;
  score: number;
  verdict: string;
  summary: string;
  engine: string;
  crmOnly: boolean;
  createdAt: string;
  createdBy: string;
  createdByName: string;
}

export interface OutreachJourneyView {
  entity: OutreachJourneyEntity;
  stage: OutreachJourneyStageSnapshot;
  emails: OutreachJourneyEmail[];
  replies: OutreachJourneyReply[];
  timeline: OutreachJourneyTimelineEntry[];
  research: {
    latest: OutreachJourneyResearchSummary | null;
    history: OutreachJourneyResearchSummary[];
    /** 背调 × 开发信关联：每封已发信依据的是哪次背调、角度有没有真的写进信里 */
    links: OutreachJourneyResearchLink[];
    coverage: { total: number; linked: number; verified: number };
  };
  batches: Array<{ id: string; label: string }>;
  stats: {
    outboundCount: number;
    replyCount: number;
    openCount: number;
    clickCount: number;
    bounceCount: number;
    firstSentAt: string;
    lastSentAt: string;
    lastEventAt: string;
  };
}

/** 一封已发开发信与背调留档的配对（配对规则：写信时刻最近的一次背调） */
export interface OutreachJourneyResearchLink {
  emailIndex: number;
  messageId: string;
  subject: string;
  sentAt: string;
  /** false = 写这封信时还没有任何背调留档 */
  linked: boolean;
  researchId: string;
  researchScore: number | null;
  researchVerdict: string;
  researchEngine: string;
  researchCreatedAt: string;
  /** 发信时背调已存在多少天（衡量新鲜度；>60 提示"背调偏旧，建议重跑"） */
  researchAgeDays: number | null;
  /** 背调提供的可引用角度；used = 主题/正文里实际写到了 */
  angles: Array<{ keyword: string; angle: string; used: boolean }>;
  /** 这次背调留档里的结构化事实条数 */
  factsCount: number;
  /** 至少一个角度真的命中了正文 */
  verified: boolean;
}

function summarizeResearch(
  record: BackgroundResearchRecord,
  nameOf: (id: string) => string
): OutreachJourneyResearchSummary {
  return {
    id: record.id,
    score: record.score,
    verdict: record.verdict,
    summary: record.summary,
    engine: record.engine,
    crmOnly: record.crmOnly,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    createdByName: nameOf(record.createdBy)
  };
}

/** 背调留档 payload → 写信蓝图用的事实 / 机会（与 server.ts developmentEmailResearchInput 同口径） */
function researchPayloadForLink(record: BackgroundResearchRecord) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(record.payloadJson || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const facts = Array.isArray(payload.facts)
    ? payload.facts.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      const label = typeof raw.label === "string" ? raw.label : "";
      const value = typeof raw.value === "string" ? raw.value : "";
      return label || value ? [{ label, value }] : [];
    }).slice(0, 18)
    : [];
  const opportunities = Array.isArray(payload.opportunities)
    ? payload.opportunities.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 4)
    : [];
  return { facts, opportunities };
}

/**
 * 背调 × 开发信配对（推导值，不落库——与「阶段是推导值」同一哲学，历史数据天然覆盖）：
 * 每封已发信按「写信时刻最近的一次背调留档」配对；角度集用与写信蓝图完全相同的
 * developmentEmailAngles 从该次背调文本里提取，再检测主题/正文里是否真的写到了
 * （大小写不敏感的包含匹配），得出「背调有没有真的用上」的验证结论。
 */
export function buildOutreachResearchLinks(
  emails: OutreachJourneyEmail[],
  records: BackgroundResearchRecord[]
): OutreachJourneyResearchLink[] {
  const asc = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return emails.map((email) => {
    let source: BackgroundResearchRecord | null = null;
    for (let i = asc.length - 1; i >= 0; i -= 1) {
      const record = asc[i]!;
      if (record.createdAt && record.createdAt <= email.sentAt) {
        source = record;
        break;
      }
    }
    if (!source) {
      return {
        emailIndex: email.index,
        messageId: email.messageId,
        subject: email.subject,
        sentAt: email.sentAt,
        linked: false,
        researchId: "",
        researchScore: null,
        researchVerdict: "",
        researchEngine: "",
        researchCreatedAt: "",
        researchAgeDays: null,
        angles: [],
        factsCount: 0,
        verified: false
      };
    }
    const { facts, opportunities } = researchPayloadForLink(source);
    // 与 assembleDevelopmentEmailBrief 同口径：事实 + 机会 + 摘要一起喂给角度提取
    const angles = developmentEmailAngles(
      facts.map((fact) => `${fact.label} ${fact.value}`).join(" "),
      opportunities.join(" "),
      source.summary
    );
    const haystack = `${email.subject || ""}\n${email.body || email.bodyPreview || ""}`.toLowerCase();
    const marked = angles.map((angle) => ({
      ...angle,
      used: Boolean(angle.keyword) && haystack.includes(angle.keyword.toLowerCase())
    }));
    const ageMs = new Date(email.sentAt).getTime() - new Date(source.createdAt).getTime();
    return {
      emailIndex: email.index,
      messageId: email.messageId,
      subject: email.subject,
      sentAt: email.sentAt,
      linked: true,
      researchId: source.id,
      researchScore: source.score,
      researchVerdict: source.verdict,
      researchEngine: source.engine,
      researchCreatedAt: source.createdAt,
      researchAgeDays: Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 86_400_000)) : null,
      angles: marked,
      factsCount: facts.length,
      verified: marked.some((angle) => angle.used)
    };
  });
}

export async function buildOutreachJourney(
  store: CrmStore,
  entityType: OutreachJourneyEntityType,
  entityId: string,
  options: { researchLimit?: number } = {}
): Promise<OutreachJourneyView | undefined> {
  const entity = resolveOutreachJourneyEntity(store, entityType, entityId);
  if (!entity) return undefined;
  const scope = journeyScope(entity);
  const batchLabels = batchLabelsFor(store, scope);
  const emails = collectOutreachEmails(store, scope, batchLabels);
  const replies = collectReplies(store, scope);
  const stage = deriveStage(entity, emails, replies);

  const nameOf = (id: string) => ownerNameOf(store, id);
  const repository = getBackgroundResearchRepository();
  const researchKeys: Array<{ type: string; id: string }> = [];
  if (entity.customerId) researchKeys.push({ type: "customer", id: entity.customerId });
  if (entity.leadId) researchKeys.push({ type: "lead", id: entity.leadId });
  let researchRecords: BackgroundResearchRecord[] = [];
  if (repository) {
    const collected: BackgroundResearchRecord[] = [];
    for (const key of researchKeys) {
      collected.push(...await repository.list(entity.teamId, key.type, key.id, options.researchLimit || 10));
    }
    researchRecords = collected
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.researchLimit || 10);
  }

  const timeline: OutreachJourneyTimelineEntry[] = [];
  for (const email of emails) {
    timeline.push({
      kind: "send",
      at: email.sentAt,
      title: `第 ${email.index} 封已发出 · ${email.subject || "（无主题）"}`,
      detail: `${email.sourceLabel}${email.batchName ? ` · ${email.batchName}` : ""} → ${email.recipient || "（未记录收件人）"}`,
      tone: "green"
    });
    if (email.openCount) {
      timeline.push({
        kind: "open",
        at: email.lastOpenedAt || email.sentAt,
        title: `客户打开了第 ${email.index} 封（累计 ${email.openCount} 次）`,
        detail: email.subject,
        tone: "blue"
      });
    }
    if (email.clickCount) {
      timeline.push({
        kind: "click",
        at: email.lastClickedAt || email.sentAt,
        title: `客户点击了第 ${email.index} 封里的链接（累计 ${email.clickCount} 次）`,
        detail: email.subject,
        tone: "blue"
      });
    }
  }
  for (const reply of replies) {
    const isBounce = reply.eventType === "bounce" || reply.classification === "bounced";
    const isNegative = NEGATIVE_CLASSIFICATIONS.includes(reply.classification as ProspectReplyClassification);
    timeline.push({
      kind: isBounce ? "bounce" : isNegative ? "reject" : "reply",
      at: reply.occurredAt,
      title: isBounce
        ? "投递退信：收件地址无效"
        : `客户回复${reply.classificationLabel ? ` · ${reply.classificationLabel}` : ""}`,
      detail: textPreview(reply.content, 220) || reply.subject || "（无正文摘要）",
      tone: isBounce || isNegative ? "red" : "green"
    });
  }
  for (const record of researchRecords) {
    timeline.push({
      kind: "research",
      at: record.createdAt,
      title: `AI 背调（评分 ${record.score} · ${textPreview(record.verdict, 40) || "未给结论"}）`,
      detail: textPreview(record.summary, 200) || record.engine,
      tone: "blue"
    });
  }
  if (entity.convertedToLead || entity.convertedToCustomer) {
    const convertedAt = emails.at(-1)?.sentAt || replies.at(-1)?.occurredAt || "";
    timeline.push({
      kind: "convert",
      at: convertedAt,
      title: entity.convertedToCustomer ? "已回流为客户档案" : "已回流为正式线索",
      detail: [entity.leadId ? `线索 ${entity.leadId}` : "", entity.customerId ? `客户 ${entity.customerId}` : ""].filter(Boolean).join(" · "),
      tone: "blue"
    });
  }
  timeline.sort((a, b) => b.at.localeCompare(a.at));

  return {
    entity,
    stage,
    emails,
    replies,
    timeline,
    research: (() => {
      const links = buildOutreachResearchLinks(emails, researchRecords);
      return {
        latest: researchRecords[0] ? summarizeResearch(researchRecords[0], nameOf) : null,
        history: researchRecords.map((record) => summarizeResearch(record, nameOf)),
        links,
        coverage: {
          total: emails.length,
          linked: links.filter((link) => link.linked).length,
          verified: links.filter((link) => link.verified).length
        }
      };
    })(),
    batches: [...batchLabels.entries()].map(([id, label]) => ({ id, label })),
    stats: {
      outboundCount: emails.length,
      replyCount: replies.filter((reply) => reply.eventType !== "bounce" && reply.classification !== "bounced").length,
      openCount: emails.reduce((sum, email) => sum + (email.openCount || 0), 0),
      clickCount: emails.reduce((sum, email) => sum + (email.clickCount || 0), 0),
      bounceCount: replies.filter((reply) => reply.eventType === "bounce" || reply.classification === "bounced").length,
      firstSentAt: emails.at(0)?.sentAt || "",
      lastSentAt: emails.at(-1)?.sentAt || "",
      lastEventAt: timeline.at(0)?.at || ""
    }
  };
}

// ---------------------------------------------------------------------------
// 发信明细列表（跨批次 / 方案的收件人总览）
// ---------------------------------------------------------------------------

export interface OutreachJourneyListItem {
  entityType: OutreachJourneyEntityType;
  entityId: string;
  company: string;
  contact: string;
  email: string;
  country: string;
  ownerName: string;
  stageKey: OutreachJourneyStageKey;
  stageLabel: string;
  stageTone: OutreachJourneyStageMeta["tone"];
  outboundCount: number;
  lastSentAt: string;
  lastSubject: string;
  replyCount: number;
  lastReplyAt: string;
  lastReplyLabel: string;
  bounceCount: number;
  openCount: number;
  converted: boolean;
  convertedTo: string;
  nextFollowAt: string;
  researchScore: number | null;
  researchAt: string;
}

export interface OutreachJourneyOverview {
  items: OutreachJourneyListItem[];
  summary: {
    total: number;
    byStage: Record<string, number>;
    replied: number;
    converted: number;
    bounced: number;
  };
}

/**
 * 明细聚合的数据量控制：
 * 只遍历「有发信痕迹」的实体（touchpoints / outboundEmailLogs 里出现过的），
 * 不去扫全量客户池，避免在客户量大时拖慢首屏。
 */
export async function listOutreachJourneyOverview(
  store: CrmStore,
  options: { ownerId?: string; teamId?: string } = {}
): Promise<OutreachJourneyOverview> {
  const ownerFilter = options.ownerId || "";
  const seen = new Set<string>();
  const targets: Array<{ entityType: OutreachJourneyEntityType; entityId: string }> = [];
  const push = (entityType: OutreachJourneyEntityType, entityId: string) => {
    if (!entityId) return;
    const key = `${entityType}:${entityId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ entityType, entityId });
  };

  for (const touchpoint of store.prospectTouchpoints) {
    if (ownerFilter && touchpoint.ownerId !== ownerFilter) continue;
    if (touchpoint.customerId) push("customer", touchpoint.customerId);
    if (touchpoint.leadId) push("lead", touchpoint.leadId);
    if (touchpoint.prospectCandidateId) push("prospect_candidate", touchpoint.prospectCandidateId);
  }
  for (const log of store.outboundEmailLogs) {
    if (ownerFilter && log.ownerId !== ownerFilter) continue;
    if (log.entityType === "customer" || log.entityType === "lead" || log.entityType === "prospect_candidate") {
      push(log.entityType, log.entityId);
    }
  }

  const items: OutreachJourneyListItem[] = [];
  for (const target of targets) {
    const entity = resolveOutreachJourneyEntity(store, target.entityType, target.entityId);
    if (!entity || !entity.company) continue;
    if (ownerFilter && entity.ownerId !== ownerFilter) continue;
    if (options.teamId && entity.teamId !== options.teamId) continue;
    const scope = journeyScope(entity);
    const labels = batchLabelsFor(store, scope);
    const emails = collectOutreachEmails(store, scope, labels);
    const replies = collectReplies(store, scope);
    const stage = deriveStage(entity, emails, replies);
    const researchRepository = getBackgroundResearchRepository();
    const research = researchRepository && entity.customerId
      ? (await researchRepository.list(entity.teamId, "customer", entity.customerId, 1))[0]
      : undefined;
    items.push({
      entityType: entity.entityType,
      entityId: entity.entityId,
      company: entity.company,
      contact: entity.contact,
      email: entity.email,
      country: entity.country,
      ownerName: entity.ownerName,
      stageKey: stage.key,
      stageLabel: stage.label,
      stageTone: stage.tone,
      outboundCount: emails.length,
      lastSentAt: emails.at(-1)?.sentAt || "",
      lastSubject: emails.at(-1)?.subject || "",
      replyCount: stage.key === "replied_interested" || stage.key === "replied_negative" ? 1 : 0,
      lastReplyAt: stage.lastReplyAt,
      lastReplyLabel: stage.lastReplyLabel,
      bounceCount: replies.filter((reply) => reply.eventType === "bounce" || reply.classification === "bounced").length,
      openCount: emails.reduce((sum, email) => sum + (email.openCount || 0), 0),
      converted: entity.convertedToCustomer || entity.convertedToLead,
      convertedTo: entity.convertedToCustomer ? "客户档案" : entity.convertedToLead ? "正式线索" : "",
      nextFollowAt: entity.nextFollowAt,
      researchScore: research ? research.score : null,
      researchAt: research ? research.createdAt : ""
    });
  }

  items.sort((a, b) => (b.lastSentAt || "").localeCompare(a.lastSentAt || ""));

  const byStage: Record<string, number> = {};
  for (const item of items) byStage[item.stageKey] = (byStage[item.stageKey] || 0) + 1;

  return {
    items,
    summary: {
      total: items.length,
      byStage,
      replied: items.filter((item) => item.stageKey === "replied_interested" || item.stageKey === "replied_negative").length,
      converted: items.filter((item) => item.converted).length,
      bounced: items.filter((item) => item.stageKey === "bounced").length
    }
  };
}

// ---------------------------------------------------------------------------
// 按阶段生成「下一封」草稿
//
// 只产出草稿，发送仍走人工确认 + 既有发信通道（dispatchOutboundEmail）。
// 这样做既满足「按阶段发开发信」，又守住 operation-contract 的
//「外部动作必须先冻结载荷再确认」约束。
// ---------------------------------------------------------------------------

export interface OutreachJourneyDraft {
  stageKey: OutreachJourneyStageKey;
  stepIndex: number;
  subject: string;
  body: string;
  tips: string[];
}

/** 联系人字段常见占位值：不能拿它当称呼，否则会写出「Hi 待维护」 */
const PLACEHOLDER_CONTACTS = new Set(["待维护", "未维护", "待补充", "未知", "无", "-", "—", "n/a", "na", "todo", "tbd"]);

function defaultContactName(entity: OutreachJourneyEntity) {
  const name = (entity.contact || "").trim();
  if (!name || PLACEHOLDER_CONTACTS.has(name.toLowerCase())) return "there";
  return name.split(/\s+/u)[0] || name;
}

export function buildOutreachJourneyDraft(
  entity: OutreachJourneyEntity,
  stage: OutreachJourneyStageSnapshot,
  emails: OutreachJourneyEmail[]
): OutreachJourneyDraft {
  const name = defaultContactName(entity);
  const company = entity.company || "your company";
  // 封数以「档案里实际发过的封数」与「阶段快照的已发计数」中的较大者为准：
  // 前者更精确，后者保证只拿到阶段快照（无邮件明细）时也能推对下一封的序位。
  const sentCount = Math.max(emails.length, stage.outboundCount || 0);
  const stepIndex = sentCount + 1;
  const lastSubject = emails.at(-1)?.subject || "";

  const footer = [
    "",
    "Best regards,",
    "{{sender}}"
  ].join("\n");

  if (stage.key === "replied_interested") {
    const replyHint = emails.length ? `Thanks again for getting back to us about "${lastSubject}".` : "Thanks for getting back to us.";
    return {
      stageKey: stage.key,
      stepIndex,
      subject: `Re: ${lastSubject || `${company} × our supply proposal`}`,
      body: [
        `Hi ${name},`,
        "",
        replyHint,
        "To move things forward I prepared a short summary of what we can deliver:",
        "  · product / model range that fits your market",
        "  · MOQ, lead time and packaging options",
        "  · reference customers in your region",
        "Could you share the specification or target price you are working with? Then I will come back with a concrete quotation.",
        footer
      ].join("\n"),
      tips: [
        "客户已回复，这封信的目标是「把兴趣转成明确需求」，不要重新做一遍公司介绍。",
        "如果客户在回信里提了具体问题，先逐条回答，再补充上面的信息。"
      ]
    };
  }

  if (stage.key === "converted") {
    return {
      stageKey: stage.key,
      stepIndex,
      subject: `${company} — keeping the conversation going`,
      body: [
        `Hi ${name},`,
        "",
        `This company has already been moved into our CRM as ${entity.convertedToCustomer ? "a customer record" : "a formal lead"}, so the follow-up now runs in the regular pipeline stage.`,
        "If you still want an outreach-format email, treat this as a soft check-in:",
        "  · confirm the current requirement is still valid",
        "  · confirm who the decision maker is",
        footer
      ].join("\n"),
      tips: [
        "这家客户已经回流到正式线索/客户，建议直接在线索或客户流程里跟进，不要再用开发信节奏打扰。"
      ]
    };
  }

  if (stepIndex <= 1) {
    return {
      stageKey: stage.key,
      stepIndex,
      subject: `${company} — reliable supply partner for your market`,
      body: [
        `Hi ${name},`,
        "",
        `I am reaching out because we work with importers and distributors in ${entity.country || "your market"} on the product line you carry.`,
        "What we usually help with:",
        "  · stable supply with consistent quality control",
        "  · flexible MOQ for a first trial order",
        "  · export documentation handled end to end",
        "Would it make sense to send you our catalogue and a price indication for your reference?",
        footer
      ].join("\n"),
      tips: [
        "首触信不要堆参数，只做「我是谁 + 我能解决什么 + 一个轻量提问」。",
        "确认收件人是采购决策人；如果是 info@ 这类通用邮箱，回复率会明显偏低。"
      ]
    };
  }

  if (stepIndex === 2) {
    return {
      stageKey: stage.key,
      stepIndex,
      subject: `Re: ${lastSubject || `${company} — supply proposal`}`,
      body: [
        `Hi ${name},`,
        "",
        "Following up on my previous email — I did not want this to get buried in your inbox.",
        "A quick note on why buyers pick us:",
        "  · we have shipped to similar distributors in your region",
        "  · we support OEM / ODM and private label",
        "  · sample order can be arranged before any bulk commitment",
        "If this is not the right time, just let me know and I will follow up later.",
        footer
      ].join("\n"),
      tips: [
        "第 2 封要给「新信息」（案例 / 资质 / 样品政策），只重复第一封等于白发。",
        "结尾留一个体面的退出选项，可以降低被标记为垃圾邮件的概率。"
      ]
    };
  }

  return {
    stageKey: stage.key,
    stepIndex,
    subject: `Re: ${lastSubject || `${company} — closing the loop`}`,
    body: [
      `Hi ${name},`,
      "",
      "I have written a couple of times without hearing back, so I will keep this one short.",
      "If sourcing this product is on your roadmap, I am happy to send a quotation.",
      "If not, tell me and I will close your file — no hard feelings.",
      footer
    ].join("\n"),
    tips: [
      "这一封是收尾信：明确「再没回音就归档」，避免长期无效投递。",
      "发出后仍无回复，建议把这家客户标记为暂停跟进，把额度让给更有意向的客户。"
    ]
  };
}
