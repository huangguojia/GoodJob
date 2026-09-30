import { buildProspectScorecard } from "./prospect-scorecard.js";
import { currentApprovedProspectDecision } from "./prospect-qualification-workflow.js";
import type { CrmStore } from "./store.js";
import type {
  Customer,
  Lead,
  ProspectContactChannelType,
  ProspectOutreachChannel,
  WebsiteOpportunity
} from "./types.js";

export type CrmOutreachEntity =
  | { entityType: "candidate"; entity: WebsiteOpportunity }
  | { entityType: "lead"; entity: Lead }
  | { entityType: "customer"; entity: Customer };

export type CrmOutreachEligibility = {
  mode: "prospect_managed" | "historical";
  channel: ProspectOutreachChannel;
  recipient: string;
  candidate?: WebsiteOpportunity;
};

export class ProspectOutreachEligibilityError extends Error {
  constructor(
    public readonly code:
      | "PROSPECT_OUTREACH_NOT_RESOLVED"
      | "PROSPECT_OUTREACH_NOT_OWNED"
      | "PROSPECT_OUTREACH_DO_NOT_CONTACT"
      | "PROSPECT_OUTREACH_NOT_ACTIVE"
      | "PROSPECT_OUTREACH_NOT_VQA"
      | "PROSPECT_OUTREACH_NOT_APPROVED"
      | "PROSPECT_OUTREACH_CHANNEL_MISMATCH"
      | "PROSPECT_OUTREACH_CHANNEL_UNSUPPORTED"
      | "PROSPECT_OUTREACH_RECIPIENT_MISSING",
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "ProspectOutreachEligibilityError";
  }
}

function fail(
  code: ProspectOutreachEligibilityError["code"],
  message: string,
  status = 409
): never {
  throw new ProspectOutreachEligibilityError(code, message, status);
}

function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizePhone(value: string) {
  return value.trim().replace(/[\s()-]/gu, "");
}

function normalizeRecipient(channel: ProspectOutreachChannel, value: string) {
  return channel === "email" ? normalizeEmail(value) : normalizePhone(value);
}

function formalChannelType(
  channel: ProspectOutreachChannel
): ProspectContactChannelType {
  return channel === "call" ? "phone" : channel;
}

function parsedProspectId(rawPayload: string) {
  try {
    const value = JSON.parse(rawPayload) as { prospectId?: unknown };
    return typeof value.prospectId === "string" ? value.prospectId : "";
  } catch {
    return "";
  }
}

function leadLineage(store: CrmStore, lead: Lead) {
  const sources = store.leadSourceEvents
    .filter((item) =>
      item.leadId === lead.id
      && item.teamId === lead.teamId
      && item.ownerId === lead.ownerId
      && item.channel === "prospect_conversion"
    )
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  const prospectIds = new Set(sources.flatMap((item) => [
    item.externalId,
    parsedProspectId(item.rawPayload)
  ]).filter(Boolean));
  const candidate = store.websiteOpportunities.find((item) =>
    item.teamId === lead.teamId
    && item.ownerId === lead.ownerId
    && (item.leadId === lead.id
      || Boolean(item.tenantProspectId && prospectIds.has(item.tenantProspectId)))
  );
  return { managed: sources.length > 0, candidate };
}

function customerLineage(store: CrmStore, customer: Customer) {
  const acquisitions = store.customerAcquisitionSourceEvents
    .filter((item) =>
      item.customerId === customer.id
      && item.teamId === customer.teamId
      && item.ownerId === customer.ownerId
      && item.prospectId
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const prospectIds = new Set(acquisitions.map((item) => item.prospectId));
  const candidate = store.websiteOpportunities.find((item) =>
    item.teamId === customer.teamId
    && item.ownerId === customer.ownerId
    && (item.customerId === customer.id
      || Boolean(item.tenantProspectId && prospectIds.has(item.tenantProspectId)))
  );
  return { managed: acquisitions.length > 0, candidate };
}

function candidateLineage(
  store: CrmStore,
  target: CrmOutreachEntity
): { managed: boolean; candidate?: WebsiteOpportunity } {
  if (target.entityType === "candidate") {
    return { managed: true, candidate: target.entity };
  }
  return target.entityType === "lead"
    ? leadLineage(store, target.entity)
    : customerLineage(store, target.entity);
}

function historicalRecipient(
  target: Exclude<CrmOutreachEntity, { entityType: "candidate" }>,
  channel: ProspectOutreachChannel
) {
  if (target.entityType === "lead") {
    return channel === "email" ? target.entity.email : target.entity.phone;
  }
  if (channel !== "email") return target.entity.whatsapp || "";
  return `${target.entity.documentContact || ""} ${target.entity.contact || ""}`
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] || "";
}

function assertOwnedAndUsable(
  target: CrmOutreachEntity,
  actorId: string
) {
  if (target.entity.ownerId !== actorId) {
    fail(
      "PROSPECT_OUTREACH_NOT_OWNED",
      "只有对象归属业务员可以发起真实外联",
      403
    );
  }
  if (target.entityType === "lead"
    && (target.entity.deletedAt || target.entity.status === "invalid")) {
    fail(
      "PROSPECT_OUTREACH_DO_NOT_CONTACT",
      "线索已删除或标记为无效，不能发起外联"
    );
  }
  if (target.entityType === "customer"
    && target.entity.poolStatus === "public") {
    fail(
      "PROSPECT_OUTREACH_NOT_OWNED",
      "公海客户必须先领取后才能发起外联",
      403
    );
  }
}

function assertManagedCandidateEligible(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  target: CrmOutreachEntity,
  channel: ProspectOutreachChannel,
  recipient: string,
  _at: string
): CrmOutreachEligibility {
  if (candidate.ownerId !== target.entity.ownerId
    || candidate.teamId !== target.entity.teamId) {
    fail(
      "PROSPECT_OUTREACH_NOT_RESOLVED",
      "搜客血缘与当前 CRM 对象归属不一致"
    );
  }
  // 2026-09-13 按需求移除客户资格审核链：不再要求企业身份归一、VQA 资格审核、
  // 人工可联系批准与通道一致性。仅保留用户显式设置的禁联 / 排除 / 抑制保护。
  const prospect = candidate.tenantProspectId
    ? store.tenantProspects.find((item) =>
        item.id === candidate.tenantProspectId
        && item.teamId === candidate.teamId
        && item.organizationId === candidate.organizationId)
    : undefined;
  if (prospect?.status === "do_not_contact") {
    fail(
      "PROSPECT_OUTREACH_DO_NOT_CONTACT",
      "该企业已进入永久禁止联系名单"
    );
  }
  if (candidate.status === "synced") {
    fail(
      "PROSPECT_OUTREACH_NOT_ACTIVE",
      "候选已转为线索，请通过线索或客户发起外联"
    );
  }
  if (candidate.status === "excluded"
    || candidate.outreachState === "suppressed"
    || (prospect
      && (prospect.exclusionMode !== "none"
        || prospect.queueState === "suppressed"))) {
    fail(
      "PROSPECT_OUTREACH_NOT_ACTIVE",
      "搜客对象当前处于排除、抑制或不可联系状态"
    );
  }
  return {
    mode: "prospect_managed",
    channel,
    recipient,
    candidate
  };
}

export function assertCrmOutreachEligible(
  store: CrmStore,
  input: {
    target: CrmOutreachEntity;
    actorId: string;
    channel: ProspectOutreachChannel;
    recipient: string;
    at?: string;
  }
): CrmOutreachEligibility {
  assertOwnedAndUsable(input.target, input.actorId);
  const recipient = input.recipient.trim();
  if (!recipient) {
    fail(
      "PROSPECT_OUTREACH_RECIPIENT_MISSING",
      "外联目标不能为空",
      400
    );
  }
  const lineage = candidateLineage(store, input.target);
  if (lineage.managed) {
    if (!lineage.candidate) {
      fail(
        "PROSPECT_OUTREACH_NOT_RESOLVED",
        "CRM 对象带有搜客血缘，但对应候选资格记录不存在"
      );
    }
    return assertManagedCandidateEligible(
      store,
      lineage.candidate,
      input.target,
      input.channel,
      recipient,
      input.at || new Date().toISOString()
    );
  }
  if (input.target.entityType === "candidate") {
    fail(
      "PROSPECT_OUTREACH_NOT_RESOLVED",
      "候选搜客对象缺少正式血缘"
    );
  }
  const expected = historicalRecipient(input.target, input.channel);
  if (!expected) {
    fail(
      "PROSPECT_OUTREACH_RECIPIENT_MISSING",
      "历史 CRM 对象没有可用的已保存联系方式",
      400
    );
  }
  if (normalizeRecipient(input.channel, recipient)
    !== normalizeRecipient(input.channel, expected)) {
    fail(
      "PROSPECT_OUTREACH_CHANNEL_MISMATCH",
      "实际收件目标必须与 CRM 中已保存的联系方式一致",
      400
    );
  }
  return {
    mode: "historical",
    channel: input.channel,
    recipient: expected
  };
}

export function assertProspectEmailOutreachEligible(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  recipient: string,
  at = new Date().toISOString()
) {
  const result = assertCrmOutreachEligible(store, {
    target: { entityType: "candidate", entity: candidate },
    actorId: candidate.ownerId,
    channel: "email",
    recipient,
    at
  });
  // 资格审核链移除后，正式身份与人工批准记录可能不存在，返回可空值。
  const prospect = candidate.tenantProspectId
    ? store.tenantProspects.find((item) =>
        item.id === candidate.tenantProspectId
        && item.teamId === candidate.teamId) ?? null
    : null;
  const approved = currentApprovedProspectDecision(store, candidate, at);
  return {
    prospect,
    scorecard: buildProspectScorecard(store, candidate, at),
    decision: approved?.decision ?? null,
    channel: approved?.channel ?? null,
    recipient: result.recipient
  };
}

export type ProspectEmailOutreachState = "ready" | "missing_email" | "blocked";

export interface ProspectEmailOutreachEligibility {
  ready: boolean;
  state: ProspectEmailOutreachState;
  /** 展示用短标签：可发信 / 缺邮箱 / 已抑制 */
  label: string;
  code: string;
  message: string;
  recipient: string;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const EMAIL_STATE_LABELS: Record<ProspectEmailOutreachState, string> = {
  ready: "可发信",
  missing_email: "缺邮箱",
  blocked: "已抑制"
};

function firstEmail(...values: Array<string | undefined>) {
  for (const value of values) {
    const match = String(value || "").match(EMAIL_PATTERN);
    if (match) return match[0].trim();
  }
  return "";
}

/**
 * 候选名单的"发信资格灯"。
 *
 * 复用 assertProspectEmailOutreachEligible 的同一套判定分支，但把「抛错」改成三态返回值
 * （可发信 / 缺邮箱 / 已抑制），并附带原始错误码与原因，供列表批量渲染 —— 不产生任何副作用，
 * 也绝不因为某个候选不可发信而让整个清单接口失败。
 *
 * @param recipientOverride 当调用方已知目标邮箱（如用户手动填入）时传入；
 *   缺省时按「人工批准通道值 → 最近一次发信 → contactInfo → contact → 官网抽取邮箱」依次取第一个。
 */
export function evaluateProspectEmailOutreachEligibility(
  store: CrmStore,
  candidate: WebsiteOpportunity,
  at = new Date().toISOString(),
  recipientOverride = ""
): ProspectEmailOutreachEligibility {
  const approved = currentApprovedProspectDecision(store, candidate, at);
  const approvedEmail = approved && approved.channel.channelType === formalChannelType("email")
    ? approved.channel.value
    : "";
  const extracted = (candidate.extractedContacts || [])
    .map((item) => (item.emails || []).join(" "))
    .join(" ");
  const recipient = firstEmail(
    recipientOverride,
    approvedEmail,
    candidate.lastDevelopmentEmailTo,
    candidate.contactInfo,
    candidate.contact,
    extracted
  );
  if (!recipient) {
    return {
      ready: false,
      state: "missing_email",
      label: EMAIL_STATE_LABELS.missing_email,
      code: "PROSPECT_OUTREACH_RECIPIENT_MISSING",
      message: "该候选还没有可用邮箱，先补全联系方式",
      recipient: ""
    };
  }
  try {
    const result = assertProspectEmailOutreachEligible(store, candidate, recipient, at);
    return {
      ready: true,
      state: "ready",
      label: EMAIL_STATE_LABELS.ready,
      code: "READY",
      message: "可直接发信",
      recipient: result.recipient
    };
  } catch (error) {
    if (error instanceof ProspectOutreachEligibilityError) {
      return {
        ready: false,
        state: "blocked",
        label: EMAIL_STATE_LABELS.blocked,
        code: error.code,
        message: error.message,
        recipient: ""
      };
    }
    throw error;
  }
}
