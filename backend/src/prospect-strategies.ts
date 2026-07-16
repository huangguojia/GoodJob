import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { domainToASCII } from "node:url";
import { z } from "zod";
import { decryptProviderConfiguration } from "./credential-security.js";
import { getProvider } from "./lead-providers.js";
import { assertProviderOperationPolicy } from "./provider-runtime.js";
import { activeProspectRunsForStrategy } from "./prospect-run-guards.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectCampaign,
  ProspectCampaignEvent,
  ProspectCampaignVersion,
  ProspectStrategy,
  ProspectStrategyEvent,
  ProspectStrategyProviderPlanItem,
  ProspectStrategyQuery,
  SessionUser
} from "./types.js";

const uuidV4Pattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const strategyIdPattern = new RegExp(`^ps_${uuidV4Pattern}$`, "i");
const providerIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);
const stringListSchema = z.array(z.string().trim().min(1).max(200)).max(100);

export const prospectStrategyIdSchema = z.string()
  .trim()
  .regex(strategyIdPattern);

function normalizedText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalizedList(values: string[]) {
  return [...new Set(values.map(normalizedText).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeDomain(value: string) {
  const normalized = normalizedText(value)
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "");
  if (!normalized || normalized.includes("/") || normalized.includes(":")) return "";
  const ascii = domainToASCII(normalized).toLocaleLowerCase("en-US");
  if (!ascii
    || ascii.length > 253
    || !ascii.includes(".")
    || ascii.split(".").some((label) =>
      !label
      || label.length > 63
      || !/^[a-z0-9-]+$/.test(label)
      || label.startsWith("-")
      || label.endsWith("-")
    )) {
    return "";
  }
  return ascii;
}

const exclusionDomainSchema = z.string()
  .trim()
  .min(1)
  .max(253)
  .transform((value, context) => {
    const normalized = normalizeDomain(value);
    if (!normalized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "排除域名必须是有效域名，不要包含协议、路径或端口"
      });
      return z.NEVER;
    }
    return normalized;
  });

const timeWindowSchema = z.object({
  mode: z.enum(["all", "fixed"]).default("all"),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default("")
}).strict().superRefine((value, context) => {
  if (value.mode === "all") {
    if (value.from || value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "不限时间窗口不能同时填写起止日期"
      });
    }
    return;
  }
  if (!value.from || !value.to) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "固定时间窗口必须填写起止日期"
    });
  } else if (value.from > value.to) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "时间窗口开始日期不能晚于结束日期"
    });
  }
});

export const prospectStrategyQuerySchema = z.object({
  keywordMode: z.enum(["campaign_products", "specific"]).default("campaign_products"),
  positiveKeywords: stringListSchema.default([]),
  synonyms: stringListSchema.default([]),
  industryTerms: stringListSchema.default([]),
  purchaseScenarioTerms: stringListSchema.default([]),
  countryMode: z.enum(["campaign_markets", "global", "specific"]).default("campaign_markets"),
  countries: stringListSchema.default([]),
  languages: stringListSchema.default([]),
  customerTypeMode: z.enum(["campaign_customer_types", "all", "specific"])
    .default("campaign_customer_types"),
  customerTypes: stringListSchema.default([]),
  exclusionKeywords: stringListSchema.default([]),
  exclusionDomains: z.array(exclusionDomainSchema).max(100).default([]),
  timeWindow: timeWindowSchema.default({
    mode: "all",
    from: "",
    to: ""
  })
}).strict();

const prospectStrategyProviderPlanItemSchema = z.object({
  providerId: providerIdSchema,
  priority: z.number().int().min(1).max(100).default(50),
  pageLimit: z.number().int().min(1).max(100).default(1),
  resultLimit: z.number().int().min(1).max(1000).default(30),
  budgetLimit: z.number().finite().min(0).max(1_000_000).nullable().default(null),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).or(z.literal("")).default("")
}).strict().superRefine((value, context) => {
  if (value.budgetLimit === null && value.currency) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "未设置预算上限时不要填写币种"
    });
  }
  if (value.budgetLimit !== null && !value.currency) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "设置预算上限时必须填写三位币种代码"
    });
  }
});

export const prospectStrategyProviderPlanSchema = z.array(
  prospectStrategyProviderPlanItemSchema
).max(30).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const providerId = item.providerId.toLocaleLowerCase("en-US");
    if (seen.has(providerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "同一策略不能重复配置相同数据源",
        path: [index, "providerId"]
      });
    }
    seen.add(providerId);
  });
});

export const createProspectStrategySchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  query: prospectStrategyQuerySchema.partial().optional(),
  providerPlan: prospectStrategyProviderPlanSchema.optional(),
  copyFromStrategyId: prospectStrategyIdSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.copyFromStrategyId && (value.query || value.providerPlan)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "复制旧策略时不能同时提交 query 或 providerPlan"
    });
  }
});

export const updateProspectStrategySchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  query: prospectStrategyQuerySchema.partial().optional(),
  providerPlan: prospectStrategyProviderPlanSchema.optional(),
  reason: z.string().trim().max(500).optional()
}).strict();

export const previewProspectStrategySchema = z.object({
  query: prospectStrategyQuerySchema.partial().optional(),
  providerPlan: prospectStrategyProviderPlanSchema.optional()
}).strict();

export const prospectStrategyActionSchema = z.object({
  reason: z.string().trim().max(500).optional()
}).strict();

export class ProspectStrategyRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ProspectStrategyRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeProspectStrategyQuery(
  value: Partial<ProspectStrategyQuery> = {}
): ProspectStrategyQuery {
  const parsed = prospectStrategyQuerySchema.parse(value);
  return {
    keywordMode: parsed.keywordMode,
    positiveKeywords: normalizedList(parsed.positiveKeywords),
    synonyms: normalizedList(parsed.synonyms),
    industryTerms: normalizedList(parsed.industryTerms),
    purchaseScenarioTerms: normalizedList(parsed.purchaseScenarioTerms),
    countryMode: parsed.countryMode,
    countries: normalizedList(parsed.countries),
    languages: normalizedList(parsed.languages),
    customerTypeMode: parsed.customerTypeMode,
    customerTypes: normalizedList(parsed.customerTypes),
    exclusionKeywords: normalizedList(parsed.exclusionKeywords),
    exclusionDomains: [...new Set(parsed.exclusionDomains)].sort(),
    timeWindow: {
      mode: parsed.timeWindow.mode,
      from: parsed.timeWindow.mode === "fixed" ? parsed.timeWindow.from : "",
      to: parsed.timeWindow.mode === "fixed" ? parsed.timeWindow.to : ""
    }
  };
}

export function normalizeProspectStrategyProviderPlan(
  value: ProspectStrategyProviderPlanItem[] = []
) {
  return prospectStrategyProviderPlanSchema.parse(value)
    .map((item) => ({
      ...item,
      providerId: item.providerId.toLocaleLowerCase("en-US"),
      currency: item.currency.toUpperCase()
    }))
    .sort((left, right) =>
      left.priority - right.priority
      || left.providerId.localeCompare(right.providerId)
    );
}

function defaultStrategyQuery() {
  return normalizeProspectStrategyQuery();
}

export function resolveProspectStrategyQuery(
  query: ProspectStrategyQuery,
  version: ProspectCampaignVersion
) {
  return {
    positiveKeywords: query.keywordMode === "campaign_products"
      ? normalizedList(version.snapshot.products)
      : query.positiveKeywords,
    synonyms: query.synonyms,
    industryTerms: query.industryTerms,
    purchaseScenarioTerms: query.purchaseScenarioTerms,
    countries: query.countryMode === "campaign_markets"
      ? normalizedList(version.snapshot.markets)
      : query.countryMode === "global"
        ? ["*"]
        : query.countries,
    languages: query.languages,
    customerTypes: query.customerTypeMode === "campaign_customer_types"
      ? normalizedList(version.snapshot.customerTypes)
      : query.customerTypeMode === "all"
        ? ["*"]
        : query.customerTypes,
    exclusionKeywords: query.exclusionKeywords,
    exclusionDomains: query.exclusionDomains,
    timeWindow: query.timeWindow
  };
}

export function prospectStrategyFingerprint(input: {
  version: ProspectCampaignVersion;
  query: ProspectStrategyQuery;
  providerPlan: ProspectStrategyProviderPlanItem[];
}) {
  const resolvedQuery = resolveProspectStrategyQuery(input.query, input.version);
  const providerIds = [...new Set(input.providerPlan.map((item) => item.providerId))]
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({
      fingerprintVersion: "v1",
      campaignVersionContentHash: input.version.contentHash,
      query: resolvedQuery,
      providerIds
    }))
    .digest("hex");
}

export function prospectStrategyEtag(
  strategy: Pick<ProspectStrategy, "id" | "revision">
) {
  return `"${strategy.id}:${strategy.revision}"`;
}

function publicStrategy(strategy: ProspectStrategy) {
  const { teamId: _teamId, ...visible } = strategy;
  return visible;
}

function publicStrategyEvent(event: ProspectStrategyEvent) {
  const { teamId: _teamId, ...visible } = event;
  return visible;
}

function assertStrategyRole(user: SessionUser) {
  if (user.role === "super_admin") {
    throw new ProspectStrategyRequestError(
      403,
      "STRATEGY_CRUD_FORBIDDEN",
      "超级管理员默认不能访问团队获客策略"
    );
  }
}

function canReadCampaign(user: SessionUser, campaign: ProspectCampaign) {
  if (user.role === "super_admin") return false;
  if (user.role === "manager" || user.role === "admin") {
    return user.teamId === campaign.teamId;
  }
  return user.teamId === campaign.teamId && user.id === campaign.ownerId;
}

function findVisibleCampaign(
  store: CrmStore,
  user: SessionUser,
  campaignId: string
) {
  assertStrategyRole(user);
  const campaign = store.prospectCampaigns.find((item) => item.id === campaignId);
  if (!campaign || !canReadCampaign(user, campaign)) {
    throw new ProspectStrategyRequestError(
      404,
      "CAMPAIGN_NOT_FOUND",
      "获客项目不存在或无权访问"
    );
  }
  return campaign;
}

function findCampaignVersion(
  store: CrmStore,
  campaign: ProspectCampaign,
  versionNumber: number
) {
  const version = store.prospectCampaignVersions.find((item) =>
    item.teamId === campaign.teamId
    && item.campaignId === campaign.id
    && item.version === versionNumber
  );
  if (!version) throw new Error("获客项目策略引用的版本不存在");
  return version;
}

function findVisibleStrategy(
  store: CrmStore,
  user: SessionUser,
  strategyId: string
) {
  assertStrategyRole(user);
  const strategy = store.prospectStrategies.find((item) => item.id === strategyId);
  if (!strategy) {
    throw new ProspectStrategyRequestError(
      404,
      "STRATEGY_NOT_FOUND",
      "搜索策略不存在或无权访问"
    );
  }
  const campaign = store.prospectCampaigns.find((item) =>
    item.id === strategy.campaignId
    && item.teamId === strategy.teamId
  );
  if (!campaign || !canReadCampaign(user, campaign)) {
    throw new ProspectStrategyRequestError(
      404,
      "STRATEGY_NOT_FOUND",
      "搜索策略不存在或无权访问"
    );
  }
  return { strategy, campaign };
}

function assertCampaignIfMatch(campaign: ProspectCampaign, ifMatch?: string) {
  if (!ifMatch) {
    throw new ProspectStrategyRequestError(
      428,
      "PRECONDITION_REQUIRED",
      "创建搜索策略必须提供 Campaign If-Match"
    );
  }
  const expected = `"${campaign.id}:${campaign.revision}"`;
  if (ifMatch.trim() !== expected) {
    throw new ProspectStrategyRequestError(
      412,
      "CAMPAIGN_REVISION_CONFLICT",
      "获客项目已被其他操作更新，请刷新后重试",
      { revision: campaign.revision, etag: expected }
    );
  }
}

function assertStrategyIfMatch(strategy: ProspectStrategy, ifMatch?: string) {
  if (!ifMatch) {
    throw new ProspectStrategyRequestError(
      428,
      "PRECONDITION_REQUIRED",
      "修改搜索策略必须提供 If-Match"
    );
  }
  if (ifMatch.trim() !== prospectStrategyEtag(strategy)) {
    throw new ProspectStrategyRequestError(
      412,
      "STRATEGY_REVISION_CONFLICT",
      "搜索策略已被其他操作更新，请刷新后重试",
      { revision: strategy.revision, etag: prospectStrategyEtag(strategy) }
    );
  }
}

function assertCampaignAllowsStrategyContent(campaign: ProspectCampaign) {
  if (campaign.status !== "draft" && campaign.status !== "paused") {
    throw new ProspectStrategyRequestError(
      409,
      "STRATEGY_CAMPAIGN_STATE_INVALID",
      "只有草稿或已暂停项目可以新增、编辑或审批搜索策略"
    );
  }
}

function assertCurrentDraft(
  campaign: ProspectCampaign,
  strategy: ProspectStrategy
) {
  if (strategy.status !== "draft") {
    throw new ProspectStrategyRequestError(
      409,
      "STRATEGY_READ_ONLY",
      "已审批或已禁用策略不能修改业务内容"
    );
  }
  if (strategy.campaignVersion !== campaign.currentVersion) {
    throw new ProspectStrategyRequestError(
      409,
      "STRATEGY_VERSION_OUTDATED",
      "该策略属于旧项目版本，请复制为当前版本草稿后再操作"
    );
  }
}

function strategyDetail(store: CrmStore, strategy: ProspectStrategy) {
  return {
    strategy: publicStrategy(strategy),
    events: store.prospectStrategyEvents
      .filter((item) =>
        item.teamId === strategy.teamId && item.strategyId === strategy.id
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicStrategyEvent)
  };
}

function snapshotStrategyState(store: CrmStore) {
  return {
    campaigns: structuredClone(store.prospectCampaigns),
    campaignEvents: structuredClone(store.prospectCampaignEvents),
    strategies: structuredClone(store.prospectStrategies),
    strategyEvents: structuredClone(store.prospectStrategyEvents)
  };
}

function restoreStrategyState(
  store: CrmStore,
  snapshot: ReturnType<typeof snapshotStrategyState>
) {
  store.prospectCampaigns.splice(
    0,
    store.prospectCampaigns.length,
    ...snapshot.campaigns
  );
  store.prospectCampaignEvents.splice(
    0,
    store.prospectCampaignEvents.length,
    ...snapshot.campaignEvents
  );
  store.prospectStrategies.splice(
    0,
    store.prospectStrategies.length,
    ...snapshot.strategies
  );
  store.prospectStrategyEvents.splice(
    0,
    store.prospectStrategyEvents.length,
    ...snapshot.strategyEvents
  );
}

async function persistStrategyMutation<T>(
  store: CrmStore,
  mutation: () => PersistedStoreMutation<T>
) {
  if (store.persistMutation) return store.persistMutation(mutation);
  const applied = mutation();
  try {
    await store.persist();
    return applied.value;
  } catch (error) {
    applied.rollback();
    throw error;
  }
}

export function createProspectStrategyEvent(
  input: Omit<ProspectStrategyEvent, "id" | "createdAt">
) {
  return {
    id: `pse_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  } satisfies ProspectStrategyEvent;
}

export function createDefaultProspectStrategyRecords(input: {
  campaign: ProspectCampaign;
  version: ProspectCampaignVersion;
  actorId: string;
  requestId: string;
  createdAt?: string;
}) {
  const createdAt = input.createdAt || new Date().toISOString();
  const query = defaultStrategyQuery();
  const providerPlan: ProspectStrategyProviderPlanItem[] = [];
  const strategy: ProspectStrategy = {
    id: `ps_${randomUUID()}`,
    teamId: input.campaign.teamId,
    campaignId: input.campaign.id,
    campaignVersion: input.version.version,
    name: "默认搜索策略",
    status: "draft",
    revision: 1,
    query,
    providerPlan,
    queryFingerprint: prospectStrategyFingerprint({
      version: input.version,
      query,
      providerPlan
    }),
    fingerprintVersion: "v1",
    ownerId: input.campaign.ownerId,
    createdBy: input.actorId,
    approvedBy: "",
    approvedAt: "",
    disabledBy: "",
    disabledAt: "",
    disableReason: "",
    createdAt,
    updatedAt: createdAt
  };
  const strategyEvent = createProspectStrategyEvent({
    teamId: strategy.teamId,
    campaignId: strategy.campaignId,
    strategyId: strategy.id,
    eventType: "created",
    actorId: input.actorId,
    requestId: input.requestId,
    fromStatus: "",
    toStatus: "draft",
    fromRevision: 0,
    toRevision: 1,
    reason: "创建默认搜索策略"
  });
  return { strategy, strategyEvent };
}

function campaignStrategyCreatedEvent(input: {
  campaign: ProspectCampaign;
  actorId: string;
  requestId: string;
  reason: string;
}) {
  return {
    id: `pce_${randomUUID()}`,
    teamId: input.campaign.teamId,
    campaignId: input.campaign.id,
    eventType: "strategy_created",
    actorId: input.actorId,
    requestId: input.requestId,
    fromStatus: input.campaign.status,
    toStatus: input.campaign.status,
    fromOwnerId: input.campaign.ownerId,
    toOwnerId: input.campaign.ownerId,
    fromVersion: input.campaign.currentVersion,
    toVersion: input.campaign.currentVersion,
    revision: input.campaign.revision,
    reason: input.reason,
    createdAt: new Date().toISOString()
  } satisfies ProspectCampaignEvent;
}

export function listProspectStrategies(
  store: CrmStore,
  user: SessionUser,
  campaignId: string,
  includeDisabled = false
) {
  const campaign = findVisibleCampaign(store, user, campaignId);
  const strategies = store.prospectStrategies
    .filter((item) =>
      item.teamId === campaign.teamId
      && item.campaignId === campaign.id
      && (includeDisabled || item.status !== "disabled")
    )
    .sort((left, right) =>
      right.campaignVersion - left.campaignVersion
      || right.updatedAt.localeCompare(left.updatedAt)
    )
    .map(publicStrategy);
  return { strategies, total: strategies.length };
}

export function getProspectStrategy(
  store: CrmStore,
  user: SessionUser,
  strategyId: string
) {
  return strategyDetail(store, findVisibleStrategy(store, user, strategyId).strategy);
}

export async function createProspectStrategy(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  ifMatch?: string;
  body: z.infer<typeof createProspectStrategySchema>;
  requestId: string;
}) {
  return persistStrategyMutation(input.store, () => {
    const before = snapshotStrategyState(input.store);
    const campaign = findVisibleCampaign(input.store, input.user, input.campaignId);
    assertCampaignIfMatch(campaign, input.ifMatch);
    assertCampaignAllowsStrategyContent(campaign);
    const version = findCampaignVersion(input.store, campaign, campaign.currentVersion);
    const copySource = input.body.copyFromStrategyId
      ? findVisibleStrategy(
          input.store,
          input.user,
          input.body.copyFromStrategyId
        ).strategy
      : null;
    if (copySource && copySource.campaignId !== campaign.id) {
      throw new ProspectStrategyRequestError(
        404,
        "STRATEGY_NOT_FOUND",
        "复制来源策略不存在或无权访问"
      );
    }
    const query = copySource
      ? structuredClone(copySource.query)
      : normalizeProspectStrategyQuery(input.body.query);
    const providerPlan = copySource
      ? structuredClone(copySource.providerPlan)
      : normalizeProspectStrategyProviderPlan(input.body.providerPlan);
    const now = new Date().toISOString();
    const strategy: ProspectStrategy = {
      id: `ps_${randomUUID()}`,
      teamId: campaign.teamId,
      campaignId: campaign.id,
      campaignVersion: campaign.currentVersion,
      name: input.body.name?.trim()
        || (copySource ? `${copySource.name} 副本` : `搜索策略 ${input.store.prospectStrategies.filter(
          (item) => item.campaignId === campaign.id
        ).length + 1}`),
      status: "draft",
      revision: 1,
      query,
      providerPlan,
      queryFingerprint: prospectStrategyFingerprint({
        version,
        query,
        providerPlan
      }),
      fingerprintVersion: "v1",
      ownerId: campaign.ownerId,
      createdBy: input.user.id,
      approvedBy: "",
      approvedAt: "",
      disabledBy: "",
      disabledAt: "",
      disableReason: "",
      createdAt: now,
      updatedAt: now
    };
    input.store.prospectStrategies.push(strategy);
    input.store.prospectStrategyEvents.push(createProspectStrategyEvent({
      teamId: strategy.teamId,
      campaignId: strategy.campaignId,
      strategyId: strategy.id,
      eventType: "created",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: "",
      toStatus: "draft",
      fromRevision: 0,
      toRevision: 1,
      reason: copySource ? "复制旧策略为当前版本草稿" : "创建搜索策略草稿"
    }));
    campaign.revision += 1;
    campaign.updatedAt = now;
    input.store.prospectCampaignEvents.push(campaignStrategyCreatedEvent({
      campaign,
      actorId: input.user.id,
      requestId: input.requestId,
      reason: `创建搜索策略：${strategy.name}`
    }));
    return {
      value: {
        ...strategyDetail(input.store, strategy),
        campaign: {
          id: campaign.id,
          revision: campaign.revision
        }
      },
      rollback: () => restoreStrategyState(input.store, before)
    };
  });
}

export async function updateProspectStrategy(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  ifMatch?: string;
  body: z.infer<typeof updateProspectStrategySchema>;
  requestId: string;
}) {
  return persistStrategyMutation(input.store, () => {
    const before = snapshotStrategyState(input.store);
    const { strategy, campaign } = findVisibleStrategy(
      input.store,
      input.user,
      input.strategyId
    );
    assertStrategyIfMatch(strategy, input.ifMatch);
    assertCampaignAllowsStrategyContent(campaign);
    assertCurrentDraft(campaign, strategy);
    const version = findCampaignVersion(
      input.store,
      campaign,
      strategy.campaignVersion
    );
    const nextQuery = input.body.query
      ? normalizeProspectStrategyQuery({ ...strategy.query, ...input.body.query })
      : strategy.query;
    const nextProviderPlan = input.body.providerPlan
      ? normalizeProspectStrategyProviderPlan(input.body.providerPlan)
      : strategy.providerPlan;
    const nextName = input.body.name?.trim() || strategy.name;
    if (nextName === strategy.name
      && isDeepStrictEqual(nextQuery, strategy.query)
      && isDeepStrictEqual(nextProviderPlan, strategy.providerPlan)) {
      return {
        value: strategyDetail(input.store, strategy),
        rollback: () => restoreStrategyState(input.store, before)
      };
    }
    const previousRevision = strategy.revision;
    strategy.name = nextName;
    strategy.query = nextQuery;
    strategy.providerPlan = nextProviderPlan;
    strategy.queryFingerprint = prospectStrategyFingerprint({
      version,
      query: nextQuery,
      providerPlan: nextProviderPlan
    });
    strategy.revision += 1;
    strategy.updatedAt = new Date().toISOString();
    input.store.prospectStrategyEvents.push(createProspectStrategyEvent({
      teamId: strategy.teamId,
      campaignId: strategy.campaignId,
      strategyId: strategy.id,
      eventType: "updated",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: "draft",
      toStatus: "draft",
      fromRevision: previousRevision,
      toRevision: strategy.revision,
      reason: input.body.reason || "更新搜索策略草稿"
    }));
    return {
      value: strategyDetail(input.store, strategy),
      rollback: () => restoreStrategyState(input.store, before)
    };
  });
}

export interface ProspectStrategyValidationIssue {
  code: string;
  field: string;
  message: string;
  providerId?: string;
}

function catalogValidationIssues(
  store: CrmStore,
  version: ProspectCampaignVersion,
  providerPlan: ProspectStrategyProviderPlanItem[]
) {
  const issues: ProspectStrategyValidationIssue[] = [];
  const allowedProviders = new Set(
    version.snapshot.sourceProviderIds.map((item) =>
      item.toLocaleLowerCase("en-US")
    )
  );
  for (const plan of providerPlan) {
    const catalog = store.providerCatalog.find((item) =>
      item.code.toLocaleLowerCase("en-US") === plan.providerId
    );
    if (!catalog) {
      issues.push({
        code: "PROVIDER_CATALOG_MISSING",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${plan.providerId} 不在数据源目录中`
      });
      continue;
    }
    if (catalog.status !== "active" || catalog.accessMode === "disabled") {
      issues.push({
        code: "PROVIDER_DISABLED",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${catalog.name} 当前不可用`
      });
    }
    if (!catalog.capabilities.some(
      (item) => item === "company" || item === "ai" || item === "web"
    )) {
      issues.push({
        code: "PROVIDER_CAPABILITY_INVALID",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${catalog.name} 不支持企业获客搜索`
      });
    }
    if (plan.providerId === "ai_search") {
      if (catalog.accessMode !== "api") {
        issues.push({
          code: "PROVIDER_RUNTIME_POLICY_INVALID",
          field: "providerPlan",
          providerId: plan.providerId,
          message: `数据源 ${catalog.name} 的接入方式不能执行自动搜索`
        });
      }
    } else {
      const provider = getProvider(plan.providerId);
      if (!provider) {
        issues.push({
          code: "PROVIDER_ADAPTER_MISSING",
          field: "providerPlan",
          providerId: plan.providerId,
          message: `数据源 ${catalog.name} 尚未安装可执行适配器`
        });
      } else {
        try {
          assertProviderOperationPolicy(provider, catalog, "search");
        } catch {
          issues.push({
            code: "PROVIDER_RUNTIME_POLICY_INVALID",
            field: "providerPlan",
            providerId: plan.providerId,
            message: `数据源 ${catalog.name} 的目录策略与执行适配器不一致`
          });
        }
      }
    }
    if (!allowedProviders.has(plan.providerId)) {
      issues.push({
        code: "PROVIDER_NOT_IN_CAMPAIGN",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${catalog.name} 未列入当前项目版本`
      });
    }
  }
  return issues;
}

function strategyValidationIssues(
  store: CrmStore,
  version: ProspectCampaignVersion,
  query: ProspectStrategyQuery,
  providerPlan: ProspectStrategyProviderPlanItem[]
) {
  const resolved = resolveProspectStrategyQuery(query, version);
  const issues: ProspectStrategyValidationIssue[] = [];
  if (!resolved.positiveKeywords.length) {
    issues.push({
      code: "KEYWORDS_REQUIRED",
      field: "query.positiveKeywords",
      message: "请填写正向关键词，或先补全项目产品"
    });
  }
  if (!resolved.countries.length) {
    issues.push({
      code: "COUNTRIES_REQUIRED",
      field: "query.countries",
      message: "请指定国家、选择全球，或先补全项目市场"
    });
  }
  if (!resolved.customerTypes.length) {
    issues.push({
      code: "CUSTOMER_TYPES_REQUIRED",
      field: "query.customerTypes",
      message: "请指定客户类型、选择不限，或先补全项目客户类型"
    });
  }
  if (!providerPlan.length) {
    issues.push({
      code: "PROVIDERS_REQUIRED",
      field: "providerPlan",
      message: "请至少选择一个企业获客数据源"
    });
  }
  return [...issues, ...catalogValidationIssues(store, version, providerPlan)];
}

function providerReadinessIssues(
  store: CrmStore,
  strategy: Pick<ProspectStrategy, "ownerId" | "teamId" | "providerPlan">
) {
  const issues: ProspectStrategyValidationIssue[] = [];
  for (const plan of strategy.providerPlan) {
    const catalog = store.providerCatalog.find((item) =>
      item.code.toLocaleLowerCase("en-US") === plan.providerId
    );
    if (!catalog) continue;
    if (plan.providerId === "ai_search") {
      const ready = store.aiModelConfigs.some((item) =>
        item.ownerId === strategy.ownerId
        && item.teamId === strategy.teamId
        && item.enabled
        && item.useLeadFinder
        && Boolean(item.apiKey)
      );
      if (!ready) {
        issues.push({
          code: "AI_PROVIDER_NOT_READY",
          field: "providerPlan",
          providerId: plan.providerId,
          message: "AI 搜索尚未配置可用于自动获客的启用模型"
        });
      }
      continue;
    }
    const connection = store.providerConnections.find((item) =>
      item.providerId.toLocaleLowerCase("en-US") === plan.providerId
      && item.ownerId === strategy.ownerId
      && item.teamId === strategy.teamId
      && item.scope === "personal"
    );
    if (connection && connection.status !== "active") {
      issues.push({
        code: "PROVIDER_CONNECTION_DISABLED",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${catalog.name} 已被当前负责人停用`
      });
      continue;
    }
    const requiresKey = catalog.licensePolicy.requiresKey === true;
    if (!requiresKey) continue;
    if (!connection) {
      issues.push({
        code: "PROVIDER_CONNECTION_REQUIRED",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${catalog.name} 需要当前负责人配置 API Key`
      });
      continue;
    }
    try {
      const configuration = decryptProviderConfiguration(
        connection,
        connection.configurationEncrypted
      );
      if (!configuration.apiKey) {
        issues.push({
          code: "PROVIDER_CONNECTION_REQUIRED",
          field: "providerPlan",
          providerId: plan.providerId,
          message: `数据源 ${catalog.name} 尚未配置 API Key`
        });
      }
    } catch {
      issues.push({
        code: "PROVIDER_CONNECTION_INVALID",
        field: "providerPlan",
        providerId: plan.providerId,
        message: `数据源 ${catalog.name} 的连接凭据不可读取，请重新保存`
      });
    }
  }
  return issues;
}

export function approvedStrategiesForCurrentVersion(
  store: CrmStore,
  campaign: ProspectCampaign
) {
  return store.prospectStrategies
    .filter((item) =>
      item.teamId === campaign.teamId
      && item.campaignId === campaign.id
      && item.campaignVersion === campaign.currentVersion
      && item.status === "approved"
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function prospectStrategyActivationIssues(
  store: CrmStore,
  campaign: ProspectCampaign,
  strategies: ProspectStrategy[]
) {
  const version = findCampaignVersion(store, campaign, campaign.currentVersion);
  return strategies.flatMap((strategy) => [
    ...strategyValidationIssues(store, version, strategy.query, strategy.providerPlan),
    ...providerReadinessIssues(store, strategy)
  ].map((issue) => ({ ...issue, strategyId: strategy.id })));
}

export function prospectStrategyRunReadinessIssues(
  store: CrmStore,
  campaign: ProspectCampaign,
  strategy: ProspectStrategy
) {
  const issues: ProspectStrategyValidationIssue[] = [];
  if (strategy.teamId !== campaign.teamId
    || strategy.campaignId !== campaign.id) {
    issues.push({
      code: "STRATEGY_CAMPAIGN_MISMATCH",
      field: "strategyId",
      message: "搜索策略不属于当前获客项目"
    });
    return issues;
  }
  if (strategy.status !== "approved") {
    issues.push({
      code: "STRATEGY_NOT_APPROVED",
      field: "strategy.status",
      message: "搜索策略必须审批通过后才能创建搜索运行"
    });
  }
  if (strategy.campaignVersion !== campaign.currentVersion) {
    issues.push({
      code: "STRATEGY_VERSION_OUTDATED",
      field: "strategy.campaignVersion",
      message: "搜索策略不属于当前项目版本"
    });
  }
  if (strategy.ownerId !== campaign.ownerId) {
    issues.push({
      code: "STRATEGY_OWNER_MISMATCH",
      field: "strategy.ownerId",
      message: "搜索策略负责人和当前项目负责人不一致"
    });
  }
  const version = findCampaignVersion(store, campaign, strategy.campaignVersion);
  const expectedFingerprint = prospectStrategyFingerprint({
    version,
    query: strategy.query,
    providerPlan: strategy.providerPlan
  });
  if (strategy.fingerprintVersion !== "v1"
    || strategy.queryFingerprint !== expectedFingerprint) {
    issues.push({
      code: "STRATEGY_FINGERPRINT_INVALID",
      field: "strategy.queryFingerprint",
      message: "搜索策略指纹与当前策略内容不一致"
    });
  }
  return [
    ...issues,
    ...strategyValidationIssues(
      store,
      version,
      strategy.query,
      strategy.providerPlan
    ),
    ...providerReadinessIssues(store, strategy)
  ];
}

export async function approveProspectStrategy(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  ifMatch?: string;
  reason?: string;
  requestId: string;
}) {
  return persistStrategyMutation(input.store, () => {
    const before = snapshotStrategyState(input.store);
    const { strategy, campaign } = findVisibleStrategy(
      input.store,
      input.user,
      input.strategyId
    );
    assertStrategyIfMatch(strategy, input.ifMatch);
    assertCampaignAllowsStrategyContent(campaign);
    assertCurrentDraft(campaign, strategy);
    const version = findCampaignVersion(
      input.store,
      campaign,
      strategy.campaignVersion
    );
    const issues = strategyValidationIssues(
      input.store,
      version,
      strategy.query,
      strategy.providerPlan
    );
    if (issues.length) {
      throw new ProspectStrategyRequestError(
        422,
        "STRATEGY_VALIDATION_FAILED",
        "搜索策略尚未通过审批校验",
        { issues }
      );
    }
    const duplicate = input.store.prospectStrategies.find((item) =>
      item.id !== strategy.id
      && item.teamId === strategy.teamId
      && item.campaignId === strategy.campaignId
      && item.campaignVersion === strategy.campaignVersion
      && item.status === "approved"
      && item.queryFingerprint === strategy.queryFingerprint
    );
    if (duplicate) {
      throw new ProspectStrategyRequestError(
        409,
        "STRATEGY_DUPLICATE_APPROVED",
        "当前项目版本已存在相同搜索范围的已审批策略",
        { duplicateStrategyId: duplicate.id }
      );
    }
    const previousRevision = strategy.revision;
    const now = new Date().toISOString();
    strategy.status = "approved";
    strategy.revision += 1;
    strategy.approvedBy = input.user.id;
    strategy.approvedAt = now;
    strategy.updatedAt = now;
    input.store.prospectStrategyEvents.push(createProspectStrategyEvent({
      teamId: strategy.teamId,
      campaignId: strategy.campaignId,
      strategyId: strategy.id,
      eventType: "approved",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: "draft",
      toStatus: "approved",
      fromRevision: previousRevision,
      toRevision: strategy.revision,
      reason: input.reason || "搜索策略审批通过"
    }));
    return {
      value: strategyDetail(input.store, strategy),
      rollback: () => restoreStrategyState(input.store, before)
    };
  });
}

export async function disableProspectStrategy(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  ifMatch?: string;
  reason?: string;
  requestId: string;
}) {
  return persistStrategyMutation(input.store, () => {
    const before = snapshotStrategyState(input.store);
    const { strategy, campaign } = findVisibleStrategy(
      input.store,
      input.user,
      input.strategyId
    );
    assertStrategyIfMatch(strategy, input.ifMatch);
    if (campaign.status === "completed" || campaign.status === "archived") {
      throw new ProspectStrategyRequestError(
        409,
        "STRATEGY_CAMPAIGN_READ_ONLY",
        "已完成或已归档项目的策略只能随项目转交负责人"
      );
    }
    if (strategy.status === "disabled") {
      throw new ProspectStrategyRequestError(
        409,
        "STRATEGY_STATE_INVALID",
        "搜索策略已经禁用"
      );
    }
    if (activeProspectRunsForStrategy(
      input.store,
      strategy.teamId,
      strategy.id
    ).length) {
      throw new ProspectStrategyRequestError(
        409,
        "STRATEGY_ACTIVE_RUNS",
        "搜索策略存在活动运行，请先取消后再禁用"
      );
    }
    if (campaign.status === "active"
      && strategy.status === "approved"
      && strategy.campaignVersion === campaign.currentVersion
      && approvedStrategiesForCurrentVersion(input.store, campaign).length <= 1) {
      throw new ProspectStrategyRequestError(
        409,
        "STRATEGY_LAST_APPROVED",
        "活动项目必须保留至少一条已审批策略，请先暂停项目"
      );
    }
    const previousStatus = strategy.status;
    const previousRevision = strategy.revision;
    const now = new Date().toISOString();
    strategy.status = "disabled";
    strategy.revision += 1;
    strategy.disabledBy = input.user.id;
    strategy.disabledAt = now;
    strategy.disableReason = input.reason || "禁用搜索策略";
    strategy.updatedAt = now;
    input.store.prospectStrategyEvents.push(createProspectStrategyEvent({
      teamId: strategy.teamId,
      campaignId: strategy.campaignId,
      strategyId: strategy.id,
      eventType: "disabled",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: previousStatus,
      toStatus: "disabled",
      fromRevision: previousRevision,
      toRevision: strategy.revision,
      reason: strategy.disableReason
    }));
    return {
      value: strategyDetail(input.store, strategy),
      rollback: () => restoreStrategyState(input.store, before)
    };
  });
}

export function previewProspectStrategy(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  body: z.infer<typeof previewProspectStrategySchema>;
}) {
  const { strategy, campaign } = findVisibleStrategy(
    input.store,
    input.user,
    input.strategyId
  );
  const version = findCampaignVersion(
    input.store,
    campaign,
    strategy.campaignVersion
  );
  const query = input.body.query
    ? normalizeProspectStrategyQuery({ ...strategy.query, ...input.body.query })
    : strategy.query;
  const providerPlan = input.body.providerPlan
    ? normalizeProspectStrategyProviderPlan(input.body.providerPlan)
    : strategy.providerPlan;
  const queryFingerprint = prospectStrategyFingerprint({
    version,
    query,
    providerPlan
  });
  const duplicate = input.store.prospectStrategies.find((item) =>
    item.id !== strategy.id
    && item.teamId === strategy.teamId
    && item.queryFingerprint === queryFingerprint
    && item.status !== "disabled"
    && input.store.prospectCampaigns.some((candidateCampaign) =>
      candidateCampaign.id === item.campaignId
      && candidateCampaign.teamId === item.teamId
      && canReadCampaign(input.user, candidateCampaign)
    )
  );
  const validationIssues = strategyValidationIssues(
    input.store,
    version,
    query,
    providerPlan
  );
  const providerWarnings = providerReadinessIssues(input.store, {
    ownerId: strategy.ownerId,
    teamId: strategy.teamId,
    providerPlan
  });
  return {
    fingerprintVersion: "v1",
    queryFingerprint,
    resolvedQuery: resolveProspectStrategyQuery(query, version),
    duplicate: duplicate
      ? { exists: true, strategyId: duplicate.id, status: duplicate.status }
      : { exists: false },
    readyForApproval: validationIssues.length === 0,
    validationIssues,
    providerWarnings,
    executionOrder: providerPlan.map((item) => item.providerId),
    history: {
      available: false,
      executionCount: null,
      lastRunAt: null,
      historicalCoverage: null,
      lastCursor: null
    },
    estimate: {
      available: false,
      netNewRange: null,
      cost: null
    }
  };
}

export function transferProspectStrategyOwners(input: {
  store: CrmStore;
  campaign: ProspectCampaign;
  fromOwnerId: string;
  toOwnerId: string;
  actorId: string;
  requestId: string;
  reason: string;
}) {
  const strategies = input.store.prospectStrategies.filter((item) =>
    item.teamId === input.campaign.teamId
    && item.campaignId === input.campaign.id
  );
  assertProspectStrategyOwnerConsistency(strategies, input.fromOwnerId);
  const now = new Date().toISOString();
  for (const strategy of strategies) {
    const previousRevision = strategy.revision;
    strategy.ownerId = input.toOwnerId;
    strategy.revision += 1;
    strategy.updatedAt = now;
    input.store.prospectStrategyEvents.push(createProspectStrategyEvent({
      teamId: strategy.teamId,
      campaignId: strategy.campaignId,
      strategyId: strategy.id,
      eventType: "owner_transferred",
      actorId: input.actorId,
      requestId: input.requestId,
      fromStatus: strategy.status,
      toStatus: strategy.status,
      fromRevision: previousRevision,
      toRevision: strategy.revision,
      reason: input.reason
    }));
  }
}

export function assertProspectStrategyOwnerConsistency(
  strategies: ProspectStrategy[],
  expectedOwnerId: string
) {
  if (strategies.some((strategy) => strategy.ownerId !== expectedOwnerId)) {
    throw new Error("搜索策略负责人和项目负责人不一致");
  }
}
