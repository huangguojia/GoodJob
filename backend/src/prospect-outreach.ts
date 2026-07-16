import { randomUUID } from "node:crypto";
import type { CrmStore } from "./store.js";
import type {
  ProspectOutreachChannel,
  ProspectReplyClassification,
  ProspectTouchpoint,
  Todo,
  WebsiteOpportunity
} from "./types.js";

type RecordTouchpointInput = {
  candidate: WebsiteOpportunity;
  actorId: string;
  channel: ProspectOutreachChannel;
  direction: "outbound" | "inbound";
  contactValue?: string;
  subject?: string;
  content?: string;
  replyClassification?: ProspectReplyClassification;
  requestId: string;
  occurredAt?: string;
  nextFollowAt?: string;
};

type FollowUpInput = {
  candidate: WebsiteOpportunity;
  channel: ProspectOutreachChannel;
  dueAt?: string;
  priority?: Todo["priority"];
  touchpointId?: string;
  reason?: string;
};

const channelLabels: Record<ProspectOutreachChannel, string> = {
  email: "邮件",
  whatsapp: "WhatsApp",
  call: "电话"
};

const replyLabels: Record<ProspectReplyClassification, string> = {
  clear_demand: "明确需求",
  interested_nurture: "有兴趣待培育",
  referral: "转介绍",
  no_current_demand: "当前无需求",
  rejected: "明确拒绝",
  unsubscribed: "要求退订",
  bounced: "联系方式退信",
  auto_unknown: "自动回复/待判断"
};

function dueText(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function followUpSchedule(
  classification: ProspectReplyClassification,
  occurredAt: string
) {
  const due = new Date(occurredAt);
  let priority: Todo["priority"] = "medium";
  if (classification === "clear_demand") {
    priority = "high";
  } else if (classification === "referral") {
    due.setDate(due.getDate() + 1);
  } else if (classification === "no_current_demand") {
    due.setDate(due.getDate() + 30);
  } else {
    due.setDate(due.getDate() + 3);
  }
  return { dueAt: dueText(due), priority };
}

function activeFollowUpTodo(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  channel: ProspectOutreachChannel
) {
  return store.todos.find((todo) =>
    todo.ownerId === candidate.ownerId
    && todo.teamId === candidate.teamId
    && todo.prospectCandidateId === candidate.id
    && todo.outreachChannel === channel
    && !todo.done
    && !todo.cancelledAt
  );
}

function nextTodoSortOrder(store: CrmStore, ownerId: string) {
  return Math.min(
    0,
    ...store.todos
      .filter((todo) => todo.ownerId === ownerId)
      .map((todo) => typeof todo.sortOrder === "number" ? todo.sortOrder : 0)
  ) - 1;
}

export function ensureProspectFollowUpTodo(
  store: CrmStore,
  input: FollowUpInput
) {
  const { candidate, channel } = input;
  const dueAt = input.dueAt || dueText(new Date(Date.now() + 3 * 86400000));
  const priority = input.priority || "medium";
  const leadText = candidate.leadId ? ` · 线索 ${candidate.leadId}` : "";
  const reasonText = input.reason ? ` · ${input.reason}` : "";
  const titlePrefix = candidate.leadId ? "跟进线索" : "跟进候选";
  const title = `${titlePrefix}：${candidate.company}（${channelLabels[channel]}）`;
  const related = `${candidate.company}${leadText}${reasonText}`;
  const existing = activeFollowUpTodo(store, candidate, channel);
  if (existing) {
    Object.assign(existing, {
      title,
      dueAt,
      priority,
      related,
      leadId: candidate.leadId,
      tenantProspectId: candidate.tenantProspectId,
      touchpointId: input.touchpointId || existing.touchpointId
    });
    return { todo: existing, created: false };
  }
  const todo: Todo = {
    id: `t_prospect_${randomUUID()}`,
    title,
    type: "other",
    priority,
    status: "pending",
    pinState: "",
    sortOrder: nextTodoSortOrder(store, candidate.ownerId),
    dueAt,
    ownerId: candidate.ownerId,
    teamId: candidate.teamId,
    related,
    done: false,
    createdAt: new Date().toISOString(),
    leadId: candidate.leadId,
    prospectCandidateId: candidate.id,
    tenantProspectId: candidate.tenantProspectId,
    outreachChannel: channel,
    touchpointId: input.touchpointId,
    triggerKey: `prospect-follow-up:${candidate.id}:${channel}`
  };
  store.todos.unshift(todo);
  return { todo, created: true };
}

function cancelChannelTodos(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  channel: ProspectOutreachChannel,
  reason: string,
  cancelledAt: string
) {
  const cancelled: Todo[] = [];
  store.todos.forEach((todo) => {
    if (todo.ownerId !== candidate.ownerId
      || todo.teamId !== candidate.teamId
      || todo.prospectCandidateId !== candidate.id
      || todo.outreachChannel !== channel
      || todo.done
      || todo.cancelledAt) return;
    Object.assign(todo, {
      done: true,
      cancelledAt,
      cancellationReason: reason,
      historyAt: cancelledAt,
      completionResult: reason
    });
    cancelled.push(todo);
  });
  return cancelled;
}

function normalizeContactValue(channel: ProspectOutreachChannel, value: string) {
  if (channel === "email") return value.trim().toLowerCase();
  return value.replaceAll(/\D/gu, "");
}

function matchingFormalChannel(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  channel: ProspectOutreachChannel,
  contactValue: string
) {
  if (!candidate.tenantProspectId) return undefined;
  const formalType = channel === "call" ? "phone" : channel;
  const matches = store.prospectContactChannels.filter((item) =>
    item.teamId === candidate.teamId
    && item.ownerId === candidate.ownerId
    && item.prospectId === candidate.tenantProspectId
    && item.channelType === formalType
  );
  if (!contactValue) return matches.at(-1);
  const normalized = normalizeContactValue(channel, contactValue);
  return matches.find((item) =>
    normalizeContactValue(channel, item.value) === normalized
  );
}

async function writeFormalReplyFact(
  store: CrmStore,
  input: RecordTouchpointInput,
  occurredAt: string
) {
  const candidate = input.candidate;
  const channel = matchingFormalChannel(
    store,
    candidate,
    input.channel,
    input.contactValue || ""
  );
  if (!channel || !candidate.tenantProspectId || !store.applyProspectQualification) {
    return false;
  }
  const base = {
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    actorId: input.actorId,
    prospectId: candidate.tenantProspectId,
    createdAt: occurredAt
  };
  if (input.replyClassification === "bounced") {
    await store.applyProspectQualification({
      ...base,
      kind: "verify_contact_channel",
      channelId: channel.id,
      status: "bounced",
      providerCode: "goodjob_manual_outreach",
      reasonCode: "outreach_bounced",
      verifiedAt: occurredAt,
      idempotencyKey: `outreach:${candidate.id}:${input.requestId}:bounced`
    });
    return true;
  }
  if (input.replyClassification === "rejected"
    || input.replyClassification === "unsubscribed") {
    await store.applyProspectQualification({
      ...base,
      kind: "set_suppression",
      scope: "organization_channel",
      action: "imposed",
      channelType: channel.channelType,
      reasonCode: input.replyClassification,
      reasonNote: input.content || replyLabels[input.replyClassification],
      effectiveAt: occurredAt,
      idempotencyKey:
        `outreach:${candidate.id}:${input.requestId}:suppression`
    });
    return true;
  }
  return false;
}

export async function recordProspectTouchpoint(
  store: CrmStore,
  input: RecordTouchpointInput
) {
  const candidate = input.candidate;
  if (candidate.ownerId !== input.actorId) {
    throw new Error("只有候选归属业务员可以记录触达");
  }
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error("触达请求编号不能为空");
  const replay = store.prospectTouchpoints.find((item) =>
    item.ownerId === candidate.ownerId
    && item.prospectCandidateId === candidate.id
    && item.requestId === requestId
  );
  if (replay) {
    return {
      touchpoint: replay,
      todo: activeFollowUpTodo(store, candidate, replay.channel),
      replayed: true
    };
  }
  const occurredAt = new Date(input.occurredAt || Date.now()).toISOString();
  if (input.direction === "inbound" && input.replyClassification) {
    await writeFormalReplyFact(store, input, occurredAt);
  }
  const touchpoint: ProspectTouchpoint = {
    id: `ptp_${randomUUID()}`,
    teamId: candidate.teamId,
    ownerId: candidate.ownerId,
    prospectCandidateId: candidate.id,
    tenantProspectId: candidate.tenantProspectId,
    organizationId: candidate.organizationId,
    leadId: candidate.leadId,
    channel: input.channel,
    direction: input.direction,
    contactValue: input.contactValue?.trim() || "",
    subject: input.subject?.trim() || "",
    content: input.content?.trim() || "",
    replyClassification: input.replyClassification,
    requestId,
    occurredAt,
    createdAt: new Date().toISOString()
  };
  store.prospectTouchpoints.unshift(touchpoint);
  candidate.lastTouchpointAt = occurredAt;
  candidate.lastTouchpointChannel = input.channel;
  candidate.statusChangedAt = occurredAt;

  if (input.direction === "outbound") {
    if (candidate.status !== "synced") candidate.status = "contacted";
    candidate.outreachState = "awaiting_reply";
    const dueAt = input.nextFollowAt
      || dueText(new Date(new Date(occurredAt).getTime() + 3 * 86400000));
    candidate.nextFollowAt = dueAt;
    const result = ensureProspectFollowUpTodo(store, {
      candidate,
      channel: input.channel,
      dueAt,
      priority: "medium",
      touchpointId: touchpoint.id,
      reason: "等待回复"
    });
    return { touchpoint, todo: result.todo, replayed: false };
  }

  const classification = input.replyClassification || "auto_unknown";
  candidate.lastReplyClassification = classification;
  if (classification === "rejected" || classification === "unsubscribed") {
    const reason = replyLabels[classification];
    candidate.status = "excluded";
    candidate.excludedReason = reason;
    candidate.outreachState = "suppressed";
    candidate.nextFollowAt = "";
    const cancelled = cancelChannelTodos(
      store,
      candidate,
      input.channel,
      reason,
      occurredAt
    );
    return { touchpoint, cancelled, replayed: false };
  }
  if (classification === "bounced") {
    candidate.invalidContactChannels = [
      ...new Set([...(candidate.invalidContactChannels || []), input.channel])
    ];
    if (candidate.status !== "synced") candidate.status = "preview";
    candidate.excludedReason = "";
    candidate.outreachState = "contact_invalid";
    candidate.nextFollowAt = "";
    const cancelled = cancelChannelTodos(
      store,
      candidate,
      input.channel,
      "联系方式退信，待补充有效联系方式",
      occurredAt
    );
    return { touchpoint, cancelled, replayed: false };
  }
  const schedule = followUpSchedule(classification, occurredAt);
  candidate.outreachState = "replied";
  candidate.nextFollowAt = schedule.dueAt;
  const result = ensureProspectFollowUpTodo(store, {
    candidate,
    channel: input.channel,
    dueAt: schedule.dueAt,
    priority: schedule.priority,
    touchpointId: touchpoint.id,
    reason: replyLabels[classification]
  });
  return { touchpoint, todo: result.todo, replayed: false };
}

export function migrateProspectFollowUpTodos(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  leadId: string
) {
  candidate.leadId = leadId;
  store.prospectTouchpoints.forEach((touchpoint) => {
    if (touchpoint.ownerId === candidate.ownerId
      && touchpoint.teamId === candidate.teamId
      && touchpoint.prospectCandidateId === candidate.id) {
      touchpoint.leadId = leadId;
    }
  });
  store.todos.forEach((todo) => {
    if (todo.ownerId !== candidate.ownerId
      || todo.teamId !== candidate.teamId
      || todo.prospectCandidateId !== candidate.id) return;
    todo.leadId = leadId;
    todo.title = todo.title.replace(/^跟进候选：/u, "跟进线索：");
    todo.related = `${candidate.company} · 线索 ${leadId}`;
  });
}

export function prospectReplyLabel(value?: ProspectReplyClassification) {
  return value ? replyLabels[value] : "";
}
