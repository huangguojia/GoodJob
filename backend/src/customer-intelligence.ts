import { createHash, randomUUID } from "node:crypto";
import type { CrmStore } from "./store.js";
import type {
  Customer,
  CustomerActivity,
  CustomerIntelligenceField,
  CustomerIntelligenceFieldKey,
  CustomerIntelligenceSuggestion,
  WebsiteOpportunity
} from "./types.js";

const FIELD_LABELS: Record<CustomerIntelligenceFieldKey, string> = {
  company: "公司名称",
  country: "国家/地区",
  contact: "联系人",
  documentContact: "联系资料"
};

function clean(value: unknown) {
  return String(value || "").trim().replace(/\s+/gu, " ");
}

function normalized(value: unknown) {
  return clean(value).toLocaleLowerCase();
}

function meaningful(value: unknown) {
  const text = normalized(value);
  return Boolean(text)
    && !["未知", "待维护", "待确认", "unknown", "n/a", "na"].includes(text);
}

function hashPayload(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function appendContactInfo(current: string, contact: string, contactInfo: string) {
  const parts = [clean(contact), clean(contactInfo)].filter(meaningful);
  const incoming = [...new Set(parts)].filter((part) =>
    !normalized(current).includes(normalized(part))
  ).join(" / ");
  if (!incoming) return "";
  if (!current) return incoming;
  return `${clean(current)} / ${incoming}`;
}

function candidateEvidence(candidate: WebsiteOpportunity) {
  const refs = (candidate.sourceEvidence || [])
    .flatMap((item) => [item.sourceUrl, item.officialWebsite])
    .map(clean)
    .filter(Boolean);
  return [...new Set([
    ...refs,
    clean(candidate.website)
  ].filter(Boolean))];
}

function suggestedField(
  key: CustomerIntelligenceFieldKey,
  currentValue: string,
  suggestedValue: string,
  evidenceSummary: string
): CustomerIntelligenceField | null {
  if (!meaningful(suggestedValue)
    || normalized(currentValue) === normalized(suggestedValue)) {
    return null;
  }
  return {
    key,
    label: FIELD_LABELS[key],
    currentValue: clean(currentValue),
    suggestedValue: clean(suggestedValue),
    evidenceSummary
  };
}

export interface GenerateCustomerIntelligenceInput {
  customer: Customer;
  candidate: WebsiteOpportunity;
  leadId?: string;
  sourceEventId?: string;
  observedAt?: string;
}

export function generateCustomerIntelligenceSuggestion(
  store: CrmStore,
  input: GenerateCustomerIntelligenceInput
) {
  const { customer, candidate } = input;
  if (customer.teamId !== candidate.teamId
    || customer.ownerId !== candidate.ownerId) {
    throw new Error("客户情报来源与客户归属不一致");
  }
  const evidenceSummary = clean(
    candidate.description
    || candidate.sourceEvidence?.at(-1)?.evidenceSummary
    || "智能获客再次发现该客户的新资料"
  );
  const documentContact = appendContactInfo(
    customer.documentContact,
    candidate.contact,
    candidate.contactInfo
  );
  const suggestedFields = [
    suggestedField(
      "company",
      customer.company,
      candidate.company,
      evidenceSummary
    ),
    suggestedField(
      "country",
      customer.country,
      candidate.country,
      evidenceSummary
    ),
    suggestedField(
      "contact",
      customer.contact,
      candidate.contact,
      evidenceSummary
    ),
    suggestedField(
      "documentContact",
      customer.documentContact,
      documentContact,
      evidenceSummary
    )
  ].filter(Boolean) as CustomerIntelligenceField[];
  const website = meaningful(candidate.website) ? clean(candidate.website) : "";
  const business = meaningful(candidate.business) ? clean(candidate.business) : "";
  const contactInfo = meaningful(candidate.contactInfo)
    ? clean(candidate.contactInfo)
    : "";
  if (!suggestedFields.length && !website && !business
    && !contactInfo && !evidenceSummary) {
    return { created: false, suggestion: null };
  }
  const evidenceRefs = candidateEvidence(candidate);
  const payloadHash = hashPayload({
    teamId: customer.teamId,
    ownerId: customer.ownerId,
    customerId: customer.id,
    prospectCandidateId: candidate.id,
    suggestedFields,
    website,
    business,
    contactInfo,
    evidenceSummary,
    evidenceRefs
  });
  const existing = store.customerIntelligenceSuggestions.find((item) =>
    item.teamId === customer.teamId
    && item.ownerId === customer.ownerId
    && item.customerId === customer.id
    && item.payloadHash === payloadHash
  );
  if (existing) {
    return { created: false, suggestion: existing };
  }
  const observedAt = input.observedAt || new Date().toISOString();
  const suggestion: CustomerIntelligenceSuggestion = {
    id: `cis_${payloadHash.slice(0, 40)}`,
    teamId: customer.teamId,
    ownerId: customer.ownerId,
    customerId: customer.id,
    prospectCandidateId: candidate.id,
    tenantProspectId: candidate.tenantProspectId,
    organizationId: candidate.organizationId,
    leadId: input.leadId || candidate.leadId,
    sourceEventId: input.sourceEventId,
    sourceLabel: clean(candidate.sourceLabel || candidate.source || "智能获客"),
    sourceUrl: evidenceRefs[0] || website,
    suggestedFields,
    website,
    business,
    contactInfo,
    evidenceSummary,
    evidenceRefs,
    payloadHash,
    status: "pending",
    acceptedFields: [],
    createdAt: observedAt,
    updatedAt: observedAt
  };
  store.customerIntelligenceSuggestions.unshift(suggestion);
  return { created: true, suggestion };
}

function ownedSuggestion(
  store: CrmStore,
  suggestionId: string,
  teamId: string,
  ownerId: string
) {
  const suggestion = store.customerIntelligenceSuggestions.find((item) =>
    item.id === suggestionId
    && item.teamId === teamId
    && item.ownerId === ownerId
  );
  if (!suggestion) throw new Error("客户情报不存在或无权访问");
  const customer = store.customers.find((item) =>
    item.id === suggestion.customerId
    && item.teamId === teamId
    && item.ownerId === ownerId
  );
  if (!customer) throw new Error("客户不存在或无权访问");
  return { suggestion, customer };
}

export function acceptCustomerIntelligence(
  store: CrmStore,
  input: {
    suggestionId: string;
    teamId: string;
    ownerId: string;
    selectedFields: CustomerIntelligenceFieldKey[];
    reviewedAt?: string;
  }
) {
  const { suggestion, customer } = ownedSuggestion(
    store,
    input.suggestionId,
    input.teamId,
    input.ownerId
  );
  if (suggestion.status !== "pending") {
    throw new Error("该客户情报已经处理");
  }
  const selected = [...new Set(input.selectedFields)];
  const fields = suggestion.suggestedFields.filter((item) =>
    selected.includes(item.key)
  );
  for (const field of fields) {
    if (clean(customer[field.key]) !== clean(field.currentValue)) {
      throw new Error(`客户${field.label}已发生变化，请刷新后重新核对`);
    }
  }
  for (const field of fields) {
    customer[field.key] = field.suggestedValue;
  }
  const reviewedAt = input.reviewedAt || new Date().toISOString();
  suggestion.status = "accepted";
  suggestion.acceptedFields = fields.map((item) => item.key);
  suggestion.reviewedBy = input.ownerId;
  suggestion.reviewedAt = reviewedAt;
  suggestion.reviewNote = fields.length
    ? `采纳字段：${fields.map((item) => item.label).join("、")}`
    : "仅采纳来源证据，不修改客户主档";
  suggestion.updatedAt = reviewedAt;
  const factParts = [
    suggestion.website ? `官网：${suggestion.website}` : "",
    suggestion.business ? `业务：${suggestion.business}` : "",
    suggestion.contactInfo ? `联系信息：${suggestion.contactInfo}` : ""
  ].filter(Boolean);
  const content = [
    `已采纳客户情报（${suggestion.sourceLabel}）`,
    suggestion.reviewNote,
    factParts.join("；"),
    suggestion.evidenceSummary
  ].filter(Boolean).join("。");
  const activity: CustomerActivity = {
    id: `ca_intel_${randomUUID()}`,
    customerId: customer.id,
    type: "note",
    content,
    operatorId: input.ownerId,
    nextReminder: "",
    createdAt: reviewedAt
  };
  store.customerActivities.unshift(activity);
  return { suggestion, customer, activity };
}

export function rejectCustomerIntelligence(
  store: CrmStore,
  input: {
    suggestionId: string;
    teamId: string;
    ownerId: string;
    reason?: string;
    reviewedAt?: string;
  }
) {
  const { suggestion, customer } = ownedSuggestion(
    store,
    input.suggestionId,
    input.teamId,
    input.ownerId
  );
  if (suggestion.status !== "pending") {
    throw new Error("该客户情报已经处理");
  }
  const reviewedAt = input.reviewedAt || new Date().toISOString();
  suggestion.status = "rejected";
  suggestion.acceptedFields = [];
  suggestion.reviewedBy = input.ownerId;
  suggestion.reviewedAt = reviewedAt;
  suggestion.reviewNote = clean(input.reason || "业务员确认不采纳");
  suggestion.updatedAt = reviewedAt;
  return { suggestion, customer };
}
