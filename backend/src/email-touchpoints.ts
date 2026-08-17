import { randomUUID } from "node:crypto";
import type { CrmStore } from "./store.js";
import type {
  OutboundEmailLog,
  ProspectReplyClassification,
  ProspectTouchpoint,
  ProspectTouchpointEventType
} from "./types.js";
import { normalizeMessageIdValue } from "./email-tracking.js";

export function recordCrmEmailTouchpoint(
  store: CrmStore,
  log: OutboundEmailLog,
  input: {
    eventType: ProspectTouchpointEventType;
    direction: "outbound" | "inbound";
    occurredAt: string;
    subject?: string;
    content?: string;
    contactValue?: string;
    replyClassification?: ProspectReplyClassification;
    requestId?: string;
  }
) {
  const messageId = normalizeMessageIdValue(log.messageId);
  const requestId = input.requestId?.trim()
    || `email:${input.eventType}:${messageId}:${input.occurredAt}`;
  const existing = store.prospectTouchpoints.find((item) =>
    item.ownerId === log.ownerId
    && item.requestId === requestId
  );
  if (existing) return existing;
  const touchpoint: ProspectTouchpoint = {
    id: `ptp_${randomUUID()}`,
    teamId: log.teamId,
    ownerId: log.ownerId,
    prospectCandidateId: "",
    leadId: log.entityType === "lead" ? log.entityId : undefined,
    customerId: log.entityType === "customer" ? log.entityId : undefined,
    channel: "email",
    direction: input.direction,
    contactValue: input.contactValue?.trim() || log.to,
    subject: input.subject?.trim() || log.subject,
    content: input.content?.trim() || "",
    replyClassification: input.replyClassification,
    requestId,
    occurredAt: input.occurredAt,
    createdAt: new Date().toISOString(),
    messageId,
    eventType: input.eventType
  };
  store.prospectTouchpoints.unshift(touchpoint);
  return touchpoint;
}
