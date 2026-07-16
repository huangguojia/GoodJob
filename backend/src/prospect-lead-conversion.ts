import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  ProspectCoverageMemoryError,
  setTenantProspectDisposition
} from "./prospect-coverage-memory.js";
import {
  currentContactabilityDecision
} from "./prospect-qualification.js";
import type { CrmStore } from "./store.js";
import type {
  Lead,
  LeadActivity,
  LeadSourceEvent,
  ProspectContact,
  ProspectContactChannel,
  ProspectContactabilityDecision,
  TenantProspect
} from "./types.js";

export const PROSPECT_LEAD_CONVERSION_CONTRACT =
  "prospect-to-lead-human-confirmation-v1";
export const PROSPECT_LEAD_SOURCE_CHANNEL = "prospect_conversion";

export const convertProspectToLeadBodySchema = z.object({
  operationCode: z.literal("convert_prospect_to_lead_v1"),
  decisionId: z.string().trim().min(1).max(90),
  mode: z.enum(["create_new", "link_existing"]).default("create_new"),
  existingLeadId: z.string().trim().max(64).optional().default(""),
  company: z.string().trim().max(200).optional().default(""),
  contact: z.string().trim().max(100).optional().default(""),
  country: z.string().trim().max(80).optional().default(""),
  intent: z.enum(["高", "中", "低"]).optional().default("中"),
  estimatedAmount: z.number().nonnegative().max(999999999999).optional()
    .default(0),
  nextFollowAt: z.string().trim().max(100).optional().default(""),
  remark: z.string().trim().max(2000).optional().default("")
}).strict().superRefine((value, context) => {
  if (value.mode === "link_existing" && !value.existingLeadId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existingLeadId"],
      message: "关联已有线索时必须提供 existingLeadId"
    });
  }
  if (value.mode === "create_new" && value.existingLeadId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existingLeadId"],
      message: "新建线索时不能提供 existingLeadId"
    });
  }
});

export type ConvertProspectToLeadBody = z.infer<
  typeof convertProspectToLeadBodySchema
>;

export interface ConvertProspectToLeadPersistedInput
  extends ConvertProspectToLeadBody {
  teamId: string;
  ownerId: string;
  prospectId: string;
  idempotencyKey: string;
  convertedAt: string;
}

export interface ConvertProspectToLeadInput
  extends ConvertProspectToLeadPersistedInput {
  coverageSecret: string;
}

export interface ConvertProspectToLeadResult {
  replayed: boolean;
  created: boolean;
  lead: Lead;
  sourceEvent: LeadSourceEvent;
  activity: LeadActivity;
  prospect: TenantProspect;
  coverageEvent: ReturnType<
    typeof setTenantProspectDisposition
  >["event"];
}

type NormalizedConversion = ConvertProspectToLeadInput;

export class ProspectLeadConversionError extends Error {
  constructor(
    public readonly code:
      | "PROSPECT_LEAD_CONVERSION_INVALID"
      | "PROSPECT_LEAD_CONVERSION_NOT_FOUND"
      | "PROSPECT_LEAD_CONVERSION_NOT_APPROVED"
      | "PROSPECT_LEAD_CONVERSION_STALE"
      | "PROSPECT_LEAD_CONVERSION_ALREADY_COMPLETED"
      | "PROSPECT_LEAD_CONVERSION_NOT_ELIGIBLE"
      | "PROSPECT_LEAD_CONVERSION_IDEMPOTENCY_CONFLICT"
      | "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY"
      | "PROSPECT_LEAD_CONVERSION_MYSQL_TRANSACTION_REQUIRED"
      | "PROSPECT_LEAD_CONVERSION_CONCURRENCY_RETRY_EXHAUSTED"
      | "PROSPECT_LEAD_CONVERSION_COMMIT_OUTCOME_UNKNOWN",
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "ProspectLeadConversionError";
  }
}

function fail(
  code: ProspectLeadConversionError["code"],
  message: string,
  status = 409
): never {
  throw new ProspectLeadConversionError(code, message, status);
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    fail(
      "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
      "线索转换请求无法规范化",
      500
    );
  }
  return result;
}

function hmac(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update(canonical(value))
    .digest("hex");
}

function sameHash(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requiredText(value: unknown, label: string, max: number) {
  const text = String(value || "").trim();
  if (!text || text.length > max) {
    fail(
      "PROSPECT_LEAD_CONVERSION_INVALID",
      `${label}不能为空且不能超过 ${max} 个字符`,
      400
    );
  }
  return text;
}

function normalizedIso(value: unknown) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    fail(
      "PROSPECT_LEAD_CONVERSION_INVALID",
      "转换时间无效",
      400
    );
  }
  return date.toISOString();
}

function normalizeInput(
  raw: ConvertProspectToLeadInput
): NormalizedConversion {
  const parsed = convertProspectToLeadBodySchema.safeParse({
    operationCode: raw.operationCode,
    decisionId: raw.decisionId,
    mode: raw.mode,
    existingLeadId: raw.existingLeadId,
    company: raw.company,
    contact: raw.contact,
    country: raw.country,
    intent: raw.intent,
    estimatedAmount: raw.estimatedAmount,
    nextFollowAt: raw.nextFollowAt,
    remark: raw.remark
  });
  if (!parsed.success) {
    fail(
      "PROSPECT_LEAD_CONVERSION_INVALID",
      parsed.error.issues[0]?.message || "线索转换参数无效",
      400
    );
  }
  const idempotencyKey = requiredText(
    raw.idempotencyKey,
    "Idempotency-Key",
    200
  );
  if (idempotencyKey.length < 8
    || !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)) {
    fail(
      "PROSPECT_LEAD_CONVERSION_INVALID",
      "Idempotency-Key 格式无效",
      400
    );
  }
  const coverageSecret = requiredText(
    raw.coverageSecret,
    "候选覆盖密钥",
    500
  );
  if (Buffer.byteLength(coverageSecret, "utf8") < 32) {
    fail(
      "PROSPECT_LEAD_CONVERSION_INVALID",
      "候选覆盖密钥至少需要 32 字节",
      500
    );
  }
  return {
    ...parsed.data,
    teamId: requiredText(raw.teamId, "团队", 64),
    ownerId: requiredText(raw.ownerId, "负责人", 64),
    prospectId: requiredText(raw.prospectId, "候选客户", 90),
    idempotencyKey,
    convertedAt: normalizedIso(raw.convertedAt),
    coverageSecret
  };
}

function requestHash(input: NormalizedConversion) {
  return hmac(input.coverageSecret, {
    contract: PROSPECT_LEAD_CONVERSION_CONTRACT,
    teamId: input.teamId,
    ownerId: input.ownerId,
    prospectId: input.prospectId,
    decisionId: input.decisionId,
    mode: input.mode,
    existingLeadId: input.existingLeadId,
    company: input.company,
    contact: input.contact,
    country: input.country,
    intent: input.intent,
    estimatedAmount: input.estimatedAmount,
    nextFollowAt: input.nextFollowAt,
    remark: input.remark
  });
}

export function prospectLeadConversionIds(
  raw: ConvertProspectToLeadInput
) {
  const input = normalizeInput(raw);
  const keyHash = hmac(input.coverageSecret, {
    contract: PROSPECT_LEAD_CONVERSION_CONTRACT,
    operation: "convert_to_lead",
    teamId: input.teamId,
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey
  });
  return {
    leadId: `lead_${hmac(input.coverageSecret, {
      type: "lead",
      keyHash
    }).slice(0, 40)}`,
    sourceEventId: `lse_${hmac(input.coverageSecret, {
      type: "source_event",
      keyHash
    }).slice(0, 40)}`,
    activityId: `la_${hmac(input.coverageSecret, {
      type: "activity",
      keyHash
    }).slice(0, 40)}`
  };
}

function sourcePayload(event: LeadSourceEvent) {
  try {
    return JSON.parse(event.rawPayload) as Record<string, unknown>;
  } catch {
    fail(
      "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
      "线索来源审计载荷损坏",
      500
    );
  }
}

function findProspect(store: CrmStore, input: NormalizedConversion) {
  const matches = store.tenantProspects.filter((item) =>
    item.id === input.prospectId && item.teamId === input.teamId
  );
  if (matches.length !== 1) {
    fail(
      "PROSPECT_LEAD_CONVERSION_NOT_FOUND",
      "候选客户不存在或无权访问",
      404
    );
  }
  return matches[0]!;
}

function findApprovedDecision(
  store: CrmStore,
  input: NormalizedConversion
): ProspectContactabilityDecision {
  const selected = store.prospectContactabilityDecisions.find((item) =>
    item.id === input.decisionId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.prospectId === input.prospectId
  );
  if (!selected || selected.status !== "approved_contactable"
    || selected.approvedBy !== input.ownerId) {
    fail(
      "PROSPECT_LEAD_CONVERSION_NOT_APPROVED",
      "当前业务员没有可用于转换的人工批准记录"
    );
  }
  const current = currentContactabilityDecision(store, {
    teamId: selected.teamId,
    ownerId: selected.ownerId,
    prospectId: selected.prospectId,
    campaignId: selected.campaignId,
    campaignVersion: selected.campaignVersion,
    channelId: selected.channelId,
    at: input.convertedAt
  });
  if (!current || current.id !== selected.id
    || current.status !== "approved_contactable") {
    fail(
      "PROSPECT_LEAD_CONVERSION_STALE",
      "候选资格或联系方式已变化，请重新审核后再转线索"
    );
  }
  return selected;
}

function findApprovedChannel(
  store: CrmStore,
  input: NormalizedConversion,
  decision: ProspectContactabilityDecision
) {
  const channel = store.prospectContactChannels.find((item) =>
    item.id === decision.channelId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.prospectId === input.prospectId
  );
  const contact = channel
    ? store.prospectContacts.find((item) =>
        item.id === channel.contactId
        && item.teamId === input.teamId
        && item.ownerId === input.ownerId
        && item.prospectId === input.prospectId
      )
    : undefined;
  if (!channel || !contact) {
    fail(
      "PROSPECT_LEAD_CONVERSION_STALE",
      "人工批准的联系人或联系方式已不可用"
    );
  }
  return { channel, contact };
}

function sourceUrl(
  store: CrmStore,
  input: NormalizedConversion,
  channel: ProspectContactChannel
) {
  return store.prospectEvidence.find((item) =>
    item.id === channel.sourceEvidenceId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.prospectId === input.prospectId
  )?.sourceRef.slice(0, 500) || "";
}

function leadContactName(
  input: NormalizedConversion,
  contact: ProspectContact
) {
  return input.contact || contact.name || contact.department || contact.title;
}

function conversionLead(
  input: NormalizedConversion,
  leadId: string,
  company: string,
  contact: ProspectContact,
  channel: ProspectContactChannel,
  decision: ProspectContactabilityDecision,
  sourceRef: string
): Lead {
  const email = channel.channelType === "email" ? channel.value : "";
  const phone = ["phone", "whatsapp"].includes(channel.channelType)
    ? channel.value
    : "";
  return {
    id: leadId,
    company,
    contact: leadContactName(input, contact),
    country: input.country,
    email,
    phone,
    wechat: "",
    source: "智能获客人工确认",
    intent: input.intent,
    stage: "新线索",
    status: "new",
    ownerId: input.ownerId,
    teamId: input.teamId,
    estimatedAmount: input.estimatedAmount,
    nextFollowAt: input.nextFollowAt,
    lastActivityAt: "刚刚",
    remark: input.remark,
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: PROSPECT_LEAD_SOURCE_CHANNEL,
    sourceCampaign: decision.campaignId,
    externalId: input.prospectId,
    sourceUrl: sourceRef,
    createdAt: input.convertedAt
  };
}

function commitLocalState(store: CrmStore, local: CrmStore) {
  store.leads.splice(0, store.leads.length, ...local.leads);
  store.leadActivities.splice(
    0,
    store.leadActivities.length,
    ...local.leadActivities
  );
  store.leadSourceEvents.splice(
    0,
    store.leadSourceEvents.length,
    ...local.leadSourceEvents
  );
  store.tenantProspects.splice(
    0,
    store.tenantProspects.length,
    ...local.tenantProspects
  );
  store.prospectCoverageEvents.splice(
    0,
    store.prospectCoverageEvents.length,
    ...local.prospectCoverageEvents
  );
}

function convertOnLocalStore(
  local: CrmStore,
  input: NormalizedConversion
): ConvertProspectToLeadResult {
  const ids = prospectLeadConversionIds(input);
  const conversionRequestHash = requestHash(input);
  const prospect = findProspect(local, input);
  const priorSource = local.leadSourceEvents.find((item) =>
    item.id === ids.sourceEventId
  );
  const otherSource = local.leadSourceEvents.find((item) =>
    item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.channel === PROSPECT_LEAD_SOURCE_CHANNEL
    && item.externalId === input.prospectId
    && item.id !== ids.sourceEventId
  );

  if (otherSource) {
    fail(
      "PROSPECT_LEAD_CONVERSION_ALREADY_COMPLETED",
      "该候选客户已经使用其他确认请求转为线索"
    );
  }

  if (priorSource) {
    const payload = sourcePayload(priorSource);
    if (!sameHash(
      String(payload.conversionRequestHash || ""),
      conversionRequestHash
    )) {
      fail(
        "PROSPECT_LEAD_CONVERSION_IDEMPOTENCY_CONFLICT",
        "该 Idempotency-Key 已用于不同的线索转换请求"
      );
    }
    const priorLead = local.leads.find((item) =>
      item.id === priorSource.leadId
      && item.teamId === input.teamId
      && item.ownerId === input.ownerId
    );
    const priorActivity = local.leadActivities.find((item) =>
      item.id === ids.activityId && item.leadId === priorSource.leadId
    );
    if (!priorLead || !priorActivity
      || prospect.status !== "converted"
      || prospect.leadId !== priorLead.id) {
      fail(
        "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
        "线索转换审计链与候选状态不一致",
        500
      );
    }
    const disposition = setTenantProspectDisposition(local, {
      teamId: input.teamId,
      ownerId: input.ownerId,
      prospectId: input.prospectId,
      requestId: `lead-conversion:${input.idempotencyKey}`,
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "link_crm",
      reasonCode: "HUMAN_CONFIRMED_LEAD_CONVERSION",
      effectiveAt: priorSource.occurredAt,
      leadId: priorLead.id,
      coverageSecret: input.coverageSecret
    });
    if (!disposition.idempotent) {
      fail(
        "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
        "线索转换幂等事件缺失",
        500
      );
    }
    return {
      replayed: true,
      created: Boolean(payload.createdLead),
      lead: structuredClone(priorLead),
      sourceEvent: structuredClone(priorSource),
      activity: structuredClone(priorActivity),
      prospect: disposition.prospect,
      coverageEvent: disposition.event
    };
  }

  if (prospect.status === "converted" || prospect.leadId) {
    fail(
      "PROSPECT_LEAD_CONVERSION_ALREADY_COMPLETED",
      "该候选客户已经转为线索"
    );
  }
  if (prospect.status !== "active"
    || prospect.exclusionMode !== "none"
    || prospect.queueState === "suppressed") {
    fail(
      "PROSPECT_LEAD_CONVERSION_NOT_ELIGIBLE",
      "该候选客户当前处于排除、禁止联系或不可转换状态"
    );
  }

  const decision = findApprovedDecision(local, input);
  const { channel, contact } = findApprovedChannel(local, input, decision);
  const organization = local.organizations.find((item) =>
    item.id === prospect.organizationId
    && item.teamId === input.teamId
    && item.status === "active"
  );
  if (!organization) {
    fail(
      "PROSPECT_LEAD_CONVERSION_NOT_ELIGIBLE",
      "候选客户的企业身份不存在或已失效"
    );
  }

  const created = input.mode === "create_new";
  let lead: Lead;
  if (created) {
    if (local.leads.some((item) => item.id === ids.leadId)) {
      fail(
        "PROSPECT_LEAD_CONVERSION_DATA_INTEGRITY",
        "线索转换标识发生冲突",
        500
      );
    }
    lead = conversionLead(
      input,
      ids.leadId,
      input.company || organization.legalName,
      contact,
      channel,
      decision,
      sourceUrl(local, input, channel)
    );
    local.leads.unshift(lead);
  } else {
    const existing = local.leads.find((item) =>
      item.id === input.existingLeadId
      && item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && !item.deletedAt
    );
    if (!existing) {
      fail(
        "PROSPECT_LEAD_CONVERSION_NOT_FOUND",
        "已有线索不存在或无权访问",
        404
      );
    }
    lead = existing;
  }

  const sourceRef = sourceUrl(local, input, channel);
  const sourceEvent: LeadSourceEvent = {
    id: ids.sourceEventId,
    leadId: lead.id,
    sourceType: "outbound",
    channel: PROSPECT_LEAD_SOURCE_CHANNEL,
    campaign: decision.campaignId,
    externalId: input.prospectId,
    sourceUrl: sourceRef,
    occurredAt: input.convertedAt,
    receivedAt: input.convertedAt,
    rawPayload: JSON.stringify({
      contract: PROSPECT_LEAD_CONVERSION_CONTRACT,
      conversionRequestHash,
      createdLead: created,
      prospectId: input.prospectId,
      organizationId: prospect.organizationId,
      decisionId: decision.id,
      channelId: channel.id,
      contactId: contact.id,
      approvedAt: decision.approvedAt
    }),
    ownerId: input.ownerId,
    teamId: input.teamId
  };
  const activity: LeadActivity = {
    id: ids.activityId,
    leadId: lead.id,
    type: "system",
    content: created
      ? "候选客户经人工确认转为正式线索"
      : "经人工确认关联智能获客候选客户",
    operatorId: input.ownerId,
    nextFollowAt: created ? lead.nextFollowAt : "",
    createdAt: input.convertedAt
  };
  local.leadSourceEvents.unshift(sourceEvent);
  local.leadActivities.unshift(activity);

  let disposition;
  try {
    disposition = setTenantProspectDisposition(local, {
      teamId: input.teamId,
      ownerId: input.ownerId,
      prospectId: input.prospectId,
      requestId: `lead-conversion:${input.idempotencyKey}`,
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "link_crm",
      reasonCode: "HUMAN_CONFIRMED_LEAD_CONVERSION",
      effectiveAt: input.convertedAt,
      leadId: lead.id,
      coverageSecret: input.coverageSecret
    });
  } catch (error) {
    if (error instanceof ProspectCoverageMemoryError
      && error.code === "PROSPECT_COVERAGE_REPLAY_CONFLICT") {
      fail(
        "PROSPECT_LEAD_CONVERSION_IDEMPOTENCY_CONFLICT",
        "该 Idempotency-Key 已用于不同的候选处置请求"
      );
    }
    throw error;
  }
  return {
    replayed: false,
    created,
    lead: structuredClone(lead),
    sourceEvent: structuredClone(sourceEvent),
    activity: structuredClone(activity),
    prospect: disposition.prospect,
    coverageEvent: disposition.event
  };
}

export function convertProspectToLead(
  store: CrmStore,
  raw: ConvertProspectToLeadInput
): ConvertProspectToLeadResult {
  if (store.mode === "mysql") {
    fail(
      "PROSPECT_LEAD_CONVERSION_MYSQL_TRANSACTION_REQUIRED",
      "MySQL 线索转换必须通过专用事务提交",
      500
    );
  }
  const input = normalizeInput(raw);
  const local = {
    ...store,
    mode: "memory",
    leads: structuredClone(store.leads),
    leadActivities: structuredClone(store.leadActivities),
    leadSourceEvents: structuredClone(store.leadSourceEvents),
    tenantProspects: structuredClone(store.tenantProspects),
    prospectCoverageEvents: structuredClone(store.prospectCoverageEvents),
    async persist() {
      // The caller commits the prepared in-memory state atomically.
    },
    async readBarrier() {
      // The conversion snapshot is synchronous and process-local.
    }
  } as CrmStore;
  const result = convertOnLocalStore(local, input);
  commitLocalState(store, local);
  return result;
}
