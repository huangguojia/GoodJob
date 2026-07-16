import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  PROSPECT_LEAD_CONVERSION_CONTRACT,
  PROSPECT_LEAD_SOURCE_CHANNEL
} from "./prospect-lead-conversion.js";
import {
  ProspectCoverageMemoryError,
  setTenantProspectDisposition
} from "./prospect-coverage-memory.js";
import type { CrmStore } from "./store.js";
import type {
  Customer,
  CustomerAcquisitionSourceEvent,
  CustomerActivity,
  Lead,
  LeadActivity,
  LeadSourceEvent,
  TenantProspect
} from "./types.js";

export const PROSPECT_CUSTOMER_CONVERSION_CONTRACT =
  "prospect-to-customer-human-confirmation-v1";

export const convertProspectToCustomerBodySchema = z.object({
  operationCode: z.literal("convert_prospect_to_customer_v1"),
  leadId: z.string().trim().min(1).max(64),
  mode: z.enum(["create_new", "link_existing"]).default("create_new"),
  existingCustomerId: z.string().trim().max(64).optional().default(""),
  company: z.string().trim().max(200).optional().default(""),
  contact: z.string().trim().max(100).optional().default(""),
  country: z.string().trim().max(80).optional().default(""),
  nextReminder: z.string().trim().max(100).optional().default("")
}).strict().superRefine((value, context) => {
  if (value.mode === "link_existing" && !value.existingCustomerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existingCustomerId"],
      message: "关联已有客户时必须提供 existingCustomerId"
    });
  }
  if (value.mode === "create_new" && value.existingCustomerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["existingCustomerId"],
      message: "新建客户时不能提供 existingCustomerId"
    });
  }
  if (value.mode === "link_existing"
    && (value.company || value.contact || value.country
      || value.nextReminder)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mode"],
      message: "关联已有客户时不能覆盖客户主档字段"
    });
  }
});

export type ConvertProspectToCustomerBody = z.infer<
  typeof convertProspectToCustomerBodySchema
>;

export interface ConvertProspectToCustomerPersistedInput
  extends ConvertProspectToCustomerBody {
  teamId: string;
  ownerId: string;
  prospectId: string;
  idempotencyKey: string;
  convertedAt: string;
}

export interface ConvertProspectToCustomerInput
  extends ConvertProspectToCustomerPersistedInput {
  coverageSecret: string;
}

export interface ConvertProspectToCustomerResult {
  replayed: boolean;
  created: boolean;
  customer: Customer;
  lead: Lead;
  sourceEvent: CustomerAcquisitionSourceEvent;
  customerActivity: CustomerActivity;
  leadActivity: LeadActivity;
  prospect: TenantProspect;
  coverageEvent: ReturnType<
    typeof setTenantProspectDisposition
  >["event"];
}

type NormalizedConversion = ConvertProspectToCustomerInput;

export class ProspectCustomerConversionError extends Error {
  constructor(
    public readonly code:
      | "PROSPECT_CUSTOMER_CONVERSION_INVALID"
      | "PROSPECT_CUSTOMER_CONVERSION_NOT_FOUND"
      | "PROSPECT_CUSTOMER_CONVERSION_SOURCE_INVALID"
      | "PROSPECT_CUSTOMER_CONVERSION_NOT_ELIGIBLE"
      | "PROSPECT_CUSTOMER_CONVERSION_ALREADY_COMPLETED"
      | "PROSPECT_CUSTOMER_CONVERSION_CUSTOMER_BINDING_CONFLICT"
      | "PROSPECT_CUSTOMER_CONVERSION_ORGANIZATION_OWNERSHIP_CONFLICT"
      | "PROSPECT_CUSTOMER_CONVERSION_IDEMPOTENCY_CONFLICT"
      | "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY"
      | "PROSPECT_CUSTOMER_CONVERSION_MYSQL_TRANSACTION_REQUIRED"
      | "PROSPECT_CUSTOMER_CONVERSION_CONCURRENCY_RETRY_EXHAUSTED"
      | "PROSPECT_CUSTOMER_CONVERSION_COMMIT_OUTCOME_UNKNOWN",
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "ProspectCustomerConversionError";
  }
}

function fail(
  code: ProspectCustomerConversionError["code"],
  message: string,
  status = 409
): never {
  throw new ProspectCustomerConversionError(code, message, status);
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
      "客户转换请求无法规范化",
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
      "PROSPECT_CUSTOMER_CONVERSION_INVALID",
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
      "PROSPECT_CUSTOMER_CONVERSION_INVALID",
      "转换时间无效",
      400
    );
  }
  return date.toISOString();
}

function normalizeInput(
  raw: ConvertProspectToCustomerInput
): NormalizedConversion {
  const parsed = convertProspectToCustomerBodySchema.safeParse({
    operationCode: raw.operationCode,
    leadId: raw.leadId,
    mode: raw.mode,
    existingCustomerId: raw.existingCustomerId,
    company: raw.company,
    contact: raw.contact,
    country: raw.country,
    nextReminder: raw.nextReminder
  });
  if (!parsed.success) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_INVALID",
      parsed.error.issues[0]?.message || "客户转换参数无效",
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
      "PROSPECT_CUSTOMER_CONVERSION_INVALID",
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
      "PROSPECT_CUSTOMER_CONVERSION_INVALID",
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
    contract: PROSPECT_CUSTOMER_CONVERSION_CONTRACT,
    teamId: input.teamId,
    ownerId: input.ownerId,
    prospectId: input.prospectId,
    leadId: input.leadId,
    mode: input.mode,
    existingCustomerId: input.existingCustomerId,
    company: input.company,
    contact: input.contact,
    country: input.country,
    nextReminder: input.nextReminder
  });
}

export function prospectCustomerConversionIds(
  raw: ConvertProspectToCustomerInput
) {
  const input = normalizeInput(raw);
  const processingKeyHash = hmac(input.coverageSecret, {
    contract: PROSPECT_CUSTOMER_CONVERSION_CONTRACT,
    operation: "convert_to_customer",
    teamId: input.teamId,
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey
  });
  return {
    processingKeyHash,
    customerId: `c_${hmac(input.coverageSecret, {
      type: "customer",
      processingKeyHash
    }).slice(0, 40)}`,
    sourceEventId: `case_${hmac(input.coverageSecret, {
      type: "customer_acquisition_source",
      processingKeyHash
    }).slice(0, 40)}`,
    customerActivityId: `ca_${hmac(input.coverageSecret, {
      type: "customer_activity",
      processingKeyHash
    }).slice(0, 40)}`,
    leadActivityId: `la_${hmac(input.coverageSecret, {
      type: "lead_activity",
      processingKeyHash
    }).slice(0, 40)}`
  };
}

function findProspect(store: CrmStore, input: NormalizedConversion) {
  const matches = store.tenantProspects.filter((item) =>
    item.id === input.prospectId && item.teamId === input.teamId
  );
  if (matches.length !== 1) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_NOT_FOUND",
      "候选客户不存在或无权访问",
      404
    );
  }
  return matches[0]!;
}

function findLead(
  store: CrmStore,
  input: NormalizedConversion,
  prospect: TenantProspect
) {
  const lead = store.leads.find((item) =>
    item.id === input.leadId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && !item.deletedAt
  );
  if (!lead || prospect.leadId !== lead.id) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_NOT_FOUND",
      "线索不存在或无权访问",
      404
    );
  }
  return lead;
}

function sourcePayload(event: LeadSourceEvent) {
  try {
    return JSON.parse(event.rawPayload) as Record<string, unknown>;
  } catch {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_SOURCE_INVALID",
      "线索来源审计载荷损坏",
      500
    );
  }
}

function findLeadSource(
  store: CrmStore,
  input: NormalizedConversion,
  prospect: TenantProspect,
  lead: Lead
) {
  const matches = store.leadSourceEvents.filter((item) =>
    item.teamId === input.teamId
    && item.ownerId === input.ownerId
    && item.leadId === lead.id
    && item.channel === PROSPECT_LEAD_SOURCE_CHANNEL
    && item.externalId === prospect.id
  );
  if (matches.length !== 1) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_SOURCE_INVALID",
      "线索缺少唯一、可信的智能获客来源链"
    );
  }
  const source = matches[0]!;
  const payload = sourcePayload(source);
  if (payload.contract !== PROSPECT_LEAD_CONVERSION_CONTRACT
    || payload.prospectId !== prospect.id
    || payload.organizationId !== prospect.organizationId) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_SOURCE_INVALID",
      "线索来源链与候选企业身份不一致"
    );
  }
  return source;
}

function findExistingCustomer(
  store: CrmStore,
  input: NormalizedConversion
) {
  const customer = store.customers.find((item) =>
    item.id === input.existingCustomerId
    && item.teamId === input.teamId
    && item.ownerId === input.ownerId
  );
  if (!customer) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_NOT_FOUND",
      "已有客户不存在或无权访问",
      404
    );
  }
  return customer;
}

function newCustomer(
  input: NormalizedConversion,
  lead: Lead,
  customerId: string
): Customer {
  return {
    id: customerId,
    company: input.company || lead.company,
    country: input.country || lead.country || "未知",
    contact: input.contact || lead.contact || "待维护",
    ownerId: input.ownerId,
    teamId: input.teamId,
    stage: "询盘",
    amount: 0,
    health: 72,
    nextReminder: input.nextReminder || lead.nextFollowAt,
    wecomBound: false,
    billingName: "",
    billingAddress: "",
    documentContact: "",
    defaultPortDischarge: "",
    defaultIncoterm: "",
    defaultPaymentTerm: ""
  };
}

function commitLocalState(store: CrmStore, local: CrmStore) {
  store.customers.splice(0, store.customers.length, ...local.customers);
  store.customerActivities.splice(
    0,
    store.customerActivities.length,
    ...local.customerActivities
  );
  store.customerAcquisitionSourceEvents.splice(
    0,
    store.customerAcquisitionSourceEvents.length,
    ...local.customerAcquisitionSourceEvents
  );
  store.leads.splice(0, store.leads.length, ...local.leads);
  store.leadActivities.splice(
    0,
    store.leadActivities.length,
    ...local.leadActivities
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
): ConvertProspectToCustomerResult {
  const ids = prospectCustomerConversionIds(input);
  const conversionRequestHash = requestHash(input);
  const prospect = findProspect(local, input);
  const lead = findLead(local, input, prospect);
  const leadSource = findLeadSource(local, input, prospect, lead);
  const replayEvents = local.customerAcquisitionSourceEvents.filter((item) =>
    item.id === ids.sourceEventId
    || (
      item.teamId === input.teamId
      && item.ownerId === input.ownerId
      && item.processingKeyHash === ids.processingKeyHash
    )
  );
  if (replayEvents.length > 1) {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
      "同一客户转换处理键存在多条来源审计",
      500
    );
  }
  const prior = replayEvents[0];
  if (prior) {
    if (!sameHash(prior.requestHash, conversionRequestHash)) {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_IDEMPOTENCY_CONFLICT",
        "该 Idempotency-Key 已用于不同的客户转换请求"
      );
    }
    const customer = local.customers.find((item) =>
      item.id === prior.customerId
      && item.teamId === input.teamId
      && item.ownerId === input.ownerId
    );
    const customerActivity = local.customerActivities.find((item) =>
      item.id === ids.customerActivityId
      && item.customerId === prior.customerId
    );
    const leadActivity = local.leadActivities.find((item) =>
      item.id === ids.leadActivityId && item.leadId === lead.id
    );
    if (!customer || !customerActivity || !leadActivity
      || prior.prospectId !== prospect.id
      || prior.organizationId !== prospect.organizationId
      || prior.leadId !== lead.id
      || prior.leadSourceEventId !== leadSource.id
      || lead.convertedCustomerId !== customer.id
      || prospect.customerId !== customer.id) {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
        "客户转换审计链与 CRM 状态不一致",
        500
      );
    }
    const disposition = setTenantProspectDisposition(local, {
      teamId: input.teamId,
      ownerId: input.ownerId,
      prospectId: input.prospectId,
      requestId: `customer-conversion:${input.idempotencyKey}`,
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "link_crm",
      reasonCode: "HUMAN_CONFIRMED_CUSTOMER_CONVERSION",
      effectiveAt: prior.createdAt,
      leadId: lead.id,
      customerId: customer.id,
      coverageSecret: input.coverageSecret
    });
    if (!disposition.idempotent) {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
        "客户转换幂等覆盖事件缺失",
        500
      );
    }
    return {
      replayed: true,
      created: prior.mode === "create_new",
      customer: structuredClone(customer),
      lead: structuredClone(lead),
      sourceEvent: structuredClone(prior),
      customerActivity: structuredClone(customerActivity),
      leadActivity: structuredClone(leadActivity),
      prospect: disposition.prospect,
      coverageEvent: disposition.event
    };
  }

  const organizationEvents = local.customerAcquisitionSourceEvents.filter(
    (item) =>
      item.teamId === input.teamId
      && item.organizationId === prospect.organizationId
  );
  if (organizationEvents.length) {
    const ownCompleted = organizationEvents.some((item) =>
      item.ownerId === input.ownerId
      && (item.prospectId === prospect.id || item.leadId === lead.id)
    );
    fail(
      ownCompleted
        ? "PROSPECT_CUSTOMER_CONVERSION_ALREADY_COMPLETED"
        : "PROSPECT_CUSTOMER_CONVERSION_ORGANIZATION_OWNERSHIP_CONFLICT",
      ownCompleted
        ? "该候选客户已经完成客户转换"
        : "该企业已存在受保护的客户归属"
    );
  }
  if (lead.convertedCustomerId || prospect.customerId) {
    if (lead.convertedCustomerId
      && prospect.customerId
      && lead.convertedCustomerId !== prospect.customerId) {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_CUSTOMER_BINDING_CONFLICT",
        "线索与候选客户绑定状态冲突"
      );
    }
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_ALREADY_COMPLETED",
      "该线索或候选客户已经关联客户"
    );
  }
  if (prospect.status !== "converted"
    || prospect.queueState !== "converted"
    || prospect.exclusionMode !== "none") {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_NOT_ELIGIBLE",
      "候选客户当前不可转为客户"
    );
  }

  const created = input.mode === "create_new";
  let customer: Customer;
  if (created) {
    if (local.customers.some((item) => item.id === ids.customerId)) {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_DATA_INTEGRITY",
        "客户转换标识发生冲突",
        500
      );
    }
    customer = newCustomer(input, lead, ids.customerId);
    local.customers.unshift(customer);
  } else {
    customer = findExistingCustomer(local, input);
    const existingBinding = local.customerAcquisitionSourceEvents.find(
      (item) =>
        item.customerId === customer.id
        && item.organizationId !== prospect.organizationId
    );
    if (existingBinding) {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_CUSTOMER_BINDING_CONFLICT",
        "该客户已绑定其他企业身份"
      );
    }
  }

  const sourceEvent: CustomerAcquisitionSourceEvent = {
    id: ids.sourceEventId,
    teamId: input.teamId,
    ownerId: input.ownerId,
    customerId: customer.id,
    leadId: lead.id,
    leadSourceEventId: leadSource.id,
    prospectId: prospect.id,
    organizationId: prospect.organizationId,
    sourceChannel: leadSource.channel,
    sourceCampaign: leadSource.campaign,
    sourceUrl: leadSource.sourceUrl,
    mode: input.mode,
    processingKeyHash: ids.processingKeyHash,
    requestHash: conversionRequestHash,
    createdAt: input.convertedAt
  };
  const customerActivity: CustomerActivity = {
    id: ids.customerActivityId,
    customerId: customer.id,
    type: "note",
    content: leadSource.campaign
      ? `由智能获客线索确认入库，来源项目：${leadSource.campaign}`
      : "由智能获客线索确认入库",
    operatorId: input.ownerId,
    nextReminder: created ? customer.nextReminder : "",
    createdAt: input.convertedAt
  };
  const leadActivity: LeadActivity = {
    id: ids.leadActivityId,
    leadId: lead.id,
    type: "system",
    content: `确认并入库：关联客户 ${customer.company}`,
    operatorId: input.ownerId,
    nextFollowAt: "",
    createdAt: input.convertedAt
  };
  local.customerAcquisitionSourceEvents.unshift(sourceEvent);
  local.customerActivities.unshift(customerActivity);
  local.leadActivities.unshift(leadActivity);
  lead.status = "converted";
  lead.stage = "已转化";
  lead.convertedCustomerId = customer.id;
  lead.lastActivityAt = "刚刚";

  let disposition;
  try {
    disposition = setTenantProspectDisposition(local, {
      teamId: input.teamId,
      ownerId: input.ownerId,
      prospectId: input.prospectId,
      requestId: `customer-conversion:${input.idempotencyKey}`,
      operationCode: "set_tenant_prospect_disposition_v1",
      action: "link_crm",
      reasonCode: "HUMAN_CONFIRMED_CUSTOMER_CONVERSION",
      effectiveAt: input.convertedAt,
      leadId: lead.id,
      customerId: customer.id,
      coverageSecret: input.coverageSecret
    });
  } catch (error) {
    if (error instanceof ProspectCoverageMemoryError
      && error.code === "PROSPECT_COVERAGE_REPLAY_CONFLICT") {
      fail(
        "PROSPECT_CUSTOMER_CONVERSION_IDEMPOTENCY_CONFLICT",
        "该 Idempotency-Key 已用于不同的候选处置请求"
      );
    }
    throw error;
  }
  return {
    replayed: false,
    created,
    customer: structuredClone(customer),
    lead: structuredClone(lead),
    sourceEvent: structuredClone(sourceEvent),
    customerActivity: structuredClone(customerActivity),
    leadActivity: structuredClone(leadActivity),
    prospect: disposition.prospect,
    coverageEvent: disposition.event
  };
}

export function convertProspectToCustomer(
  store: CrmStore,
  raw: ConvertProspectToCustomerInput
): ConvertProspectToCustomerResult {
  if (store.mode === "mysql") {
    fail(
      "PROSPECT_CUSTOMER_CONVERSION_MYSQL_TRANSACTION_REQUIRED",
      "MySQL 客户转换必须通过专用事务提交",
      500
    );
  }
  const input = normalizeInput(raw);
  const local = {
    ...store,
    mode: "memory",
    customers: structuredClone(store.customers),
    customerActivities: structuredClone(store.customerActivities),
    customerAcquisitionSourceEvents:
      structuredClone(store.customerAcquisitionSourceEvents),
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
