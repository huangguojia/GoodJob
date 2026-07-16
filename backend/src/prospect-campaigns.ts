import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  approvedStrategiesForCurrentVersion,
  assertProspectStrategyOwnerConsistency,
  createDefaultProspectStrategyRecords,
  prospectStrategyActivationIssues,
  transferProspectStrategyOwners
} from "./prospect-strategies.js";
import {
  activeProspectRunsForCampaign,
  pauseQueuedProspectRunsForCampaign
} from "./prospect-run-guards.js";
import { ProspectRunQueueBridgeIntegrityError } from "./prospect-run-queue-bridge.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectCampaign,
  ProspectCampaignEvent,
  ProspectCampaignStatus,
  ProspectCampaignVersion,
  ProspectCampaignVersionSnapshot,
  SessionUser,
  User
} from "./types.js";

const formalCampaignIdPattern = /^pc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const prospectCampaignIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const stringListSchema = z.array(z.string().trim().min(1).max(200)).max(100);

export const prospectCampaignSnapshotSchema = z.object({
  goal: z.string().trim().max(1000).default(""),
  products: stringListSchema.default([]),
  markets: stringListSchema.default([]),
  customerTypes: stringListSchema.default([]),
  applicationScenarios: stringListSchema.default([]),
  icpRules: stringListSchema.default([]),
  exclusionRules: stringListSchema.default([]),
  sourceProviderIds: z.array(
    z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/)
  ).max(100).default([])
}).strict();

export const createProspectCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  ownerId: z.string().trim().min(1).max(64).optional(),
  snapshot: prospectCampaignSnapshotSchema.partial().optional()
}).strict();

export const updateProspectCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  ownerId: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().max(500).optional()
}).strict();

export const createProspectCampaignVersionSchema = z.object({
  snapshot: prospectCampaignSnapshotSchema.partial(),
  changeSummary: z.string().trim().max(500).optional()
}).strict();

export const prospectCampaignActionSchema = z.object({
  reason: z.string().trim().max(500).optional()
}).strict();

export class ProspectCampaignRequestError extends Error {
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
    this.name = "ProspectCampaignRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeProspectCampaignSnapshot(
  value: Partial<ProspectCampaignVersionSnapshot> = {}
): ProspectCampaignVersionSnapshot {
  const parsed = prospectCampaignSnapshotSchema.parse(value);
  return {
    goal: parsed.goal.trim(),
    products: normalizeList(parsed.products),
    markets: normalizeList(parsed.markets),
    customerTypes: normalizeList(parsed.customerTypes),
    applicationScenarios: normalizeList(parsed.applicationScenarios),
    icpRules: normalizeList(parsed.icpRules),
    exclusionRules: normalizeList(parsed.exclusionRules),
    sourceProviderIds: normalizeList(parsed.sourceProviderIds)
  };
}

export function prospectCampaignSnapshotHash(
  snapshot: ProspectCampaignVersionSnapshot
) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeProspectCampaignSnapshot(snapshot)))
    .digest("hex");
}

export function prospectCampaignEtag(
  campaign: Pick<ProspectCampaign, "id" | "revision">
) {
  return `"${campaign.id}:${campaign.revision}"`;
}

function publicCampaign(campaign: ProspectCampaign) {
  const { teamId: _teamId, ...visible } = campaign;
  return visible;
}

function publicVersion(version: ProspectCampaignVersion) {
  const { teamId: _teamId, ...visible } = version;
  return visible;
}

function publicEvent(event: ProspectCampaignEvent) {
  const { teamId: _teamId, ...visible } = event;
  return visible;
}

function assertCampaignCrudRole(user: SessionUser) {
  if (user.role === "super_admin") {
    throw new ProspectCampaignRequestError(
      403,
      "CAMPAIGN_CRUD_FORBIDDEN",
      "超级管理员默认不能访问团队业务项目"
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
  assertCampaignCrudRole(user);
  const campaign = store.prospectCampaigns.find((item) => item.id === campaignId);
  if (!campaign || !canReadCampaign(user, campaign)) {
    throw new ProspectCampaignRequestError(
      404,
      "CAMPAIGN_NOT_FOUND",
      "获客项目不存在或无权访问"
    );
  }
  return campaign;
}

function assertIfMatch(campaign: ProspectCampaign, ifMatch?: string) {
  if (!ifMatch) {
    throw new ProspectCampaignRequestError(
      428,
      "PRECONDITION_REQUIRED",
      "修改获客项目必须提供 If-Match"
    );
  }
  if (ifMatch.trim() !== prospectCampaignEtag(campaign)) {
    throw new ProspectCampaignRequestError(
      412,
      "CAMPAIGN_REVISION_CONFLICT",
      "获客项目已被其他操作更新，请刷新后重试",
      { revision: campaign.revision, etag: prospectCampaignEtag(campaign) }
    );
  }
}

function resolveOwner(
  store: CrmStore,
  user: SessionUser,
  requestedOwnerId?: string
): User {
  const ownerId = requestedOwnerId || user.id;
  if (ownerId !== user.id && user.role !== "manager" && user.role !== "admin") {
    throw new ProspectCampaignRequestError(
      403,
      "CAMPAIGN_OWNER_FORBIDDEN",
      "业务员不能把项目分配给其他账号"
    );
  }
  const owner = store.users.find((item) =>
    item.id === ownerId
    && item.teamId === user.teamId
    && item.status === "active"
    && item.role !== "super_admin"
  );
  if (!owner) {
    throw new ProspectCampaignRequestError(
      404,
      "CAMPAIGN_OWNER_NOT_FOUND",
      "负责人不存在、已停用或不属于当前团队"
    );
  }
  return owner;
}

function campaignVersions(store: CrmStore, campaign: ProspectCampaign) {
  return store.prospectCampaignVersions
    .filter((item) =>
      item.teamId === campaign.teamId && item.campaignId === campaign.id
    )
    .sort((left, right) => right.version - left.version);
}

function currentVersion(store: CrmStore, campaign: ProspectCampaign) {
  const version = store.prospectCampaignVersions.find((item) =>
    item.teamId === campaign.teamId
    && item.campaignId === campaign.id
    && item.version === campaign.currentVersion
  );
  if (!version) {
    throw new Error("获客项目当前版本不存在");
  }
  return version;
}

function campaignDetail(store: CrmStore, campaign: ProspectCampaign) {
  const versions = campaignVersions(store, campaign);
  return {
    campaign: publicCampaign(campaign),
    currentVersion: publicVersion(currentVersion(store, campaign)),
    versions: versions.map(publicVersion),
    events: store.prospectCampaignEvents
      .filter((item) =>
        item.teamId === campaign.teamId && item.campaignId === campaign.id
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicEvent)
  };
}

function snapshotCampaignState(store: CrmStore) {
  return {
    campaigns: structuredClone(store.prospectCampaigns),
    versions: structuredClone(store.prospectCampaignVersions),
    events: structuredClone(store.prospectCampaignEvents),
    strategies: structuredClone(store.prospectStrategies),
    strategyEvents: structuredClone(store.prospectStrategyEvents),
    runs: structuredClone(store.prospectSearchRuns),
    runShards: structuredClone(store.prospectRunShards),
    runEvents: structuredClone(store.prospectRunEvents),
    jobs: structuredClone(store.agentJobs),
    jobAliases: structuredClone(store.agentJobIdempotencyAliases),
    runQueueParentBindings: structuredClone(
      store.prospectRunQueueParentBindings
    ),
    runQueueChildBindings: structuredClone(
      store.prospectRunQueueChildBindings
    )
  };
}

function restoreCampaignState(
  store: CrmStore,
  snapshot: ReturnType<typeof snapshotCampaignState>
) {
  store.prospectCampaigns.splice(
    0,
    store.prospectCampaigns.length,
    ...snapshot.campaigns
  );
  store.prospectCampaignVersions.splice(
    0,
    store.prospectCampaignVersions.length,
    ...snapshot.versions
  );
  store.prospectCampaignEvents.splice(
    0,
    store.prospectCampaignEvents.length,
    ...snapshot.events
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
  store.prospectSearchRuns.splice(
    0,
    store.prospectSearchRuns.length,
    ...snapshot.runs
  );
  store.prospectRunShards.splice(
    0,
    store.prospectRunShards.length,
    ...snapshot.runShards
  );
  store.prospectRunEvents.splice(
    0,
    store.prospectRunEvents.length,
    ...snapshot.runEvents
  );
  store.agentJobs.splice(0, store.agentJobs.length, ...snapshot.jobs);
  store.agentJobIdempotencyAliases.splice(
    0,
    store.agentJobIdempotencyAliases.length,
    ...snapshot.jobAliases
  );
  store.prospectRunQueueParentBindings.splice(
    0,
    store.prospectRunQueueParentBindings.length,
    ...snapshot.runQueueParentBindings
  );
  store.prospectRunQueueChildBindings.splice(
    0,
    store.prospectRunQueueChildBindings.length,
    ...snapshot.runQueueChildBindings
  );
}

async function persistCampaignMutation<T>(
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

function event(input: Omit<ProspectCampaignEvent, "id" | "createdAt">) {
  return {
    id: `pce_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  } satisfies ProspectCampaignEvent;
}

export function listProspectCampaigns(
  store: CrmStore,
  user: SessionUser,
  includeArchived = false
) {
  assertCampaignCrudRole(user);
  const campaigns = store.prospectCampaigns
    .filter((item) => canReadCampaign(user, item))
    .filter((item) => includeArchived || item.status !== "archived")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(publicCampaign);
  return { campaigns, total: campaigns.length };
}

export function getProspectCampaign(
  store: CrmStore,
  user: SessionUser,
  campaignId: string
) {
  return campaignDetail(
    store,
    findVisibleCampaign(store, user, campaignId)
  );
}

export async function createProspectCampaign(input: {
  store: CrmStore;
  user: SessionUser;
  body: z.infer<typeof createProspectCampaignSchema>;
  requestId: string;
}) {
  assertCampaignCrudRole(input.user);
  return persistCampaignMutation(input.store, () => {
    const before = snapshotCampaignState(input.store);
    const owner = resolveOwner(input.store, input.user, input.body.ownerId);
    const now = new Date().toISOString();
    const campaignId = `pc_${randomUUID()}`;
    const normalizedSnapshot = normalizeProspectCampaignSnapshot(
      input.body.snapshot
    );
    const campaign: ProspectCampaign = {
      id: campaignId,
      teamId: input.user.teamId,
      ownerId: owner.id,
      name: input.body.name.trim(),
      status: "draft",
      currentVersion: 1,
      revision: 1,
      createdBy: input.user.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: ""
    };
    const version: ProspectCampaignVersion = {
      id: `pcv_${randomUUID()}`,
      teamId: campaign.teamId,
      campaignId,
      version: 1,
      snapshot: normalizedSnapshot,
      contentHash: prospectCampaignSnapshotHash(normalizedSnapshot),
      changeSummary: "创建项目草稿",
      createdBy: input.user.id,
      createdAt: now
    };
    input.store.prospectCampaigns.push(campaign);
    input.store.prospectCampaignVersions.push(version);
    const defaultStrategy = createDefaultProspectStrategyRecords({
      campaign,
      version,
      actorId: input.user.id,
      requestId: input.requestId,
      createdAt: now
    });
    input.store.prospectStrategies.push(defaultStrategy.strategy);
    input.store.prospectStrategyEvents.push(defaultStrategy.strategyEvent);
    input.store.prospectCampaignEvents.push(event({
      teamId: campaign.teamId,
      campaignId,
      eventType: "created",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: "",
      toStatus: "draft",
      fromOwnerId: "",
      toOwnerId: owner.id,
      fromVersion: 0,
      toVersion: 1,
      revision: 1,
      reason: "创建项目草稿"
    }));
    return {
      value: campaignDetail(input.store, campaign),
      rollback: () => restoreCampaignState(input.store, before)
    };
  });
}

export async function updateProspectCampaign(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  ifMatch?: string;
  body: z.infer<typeof updateProspectCampaignSchema>;
  requestId: string;
}) {
  return persistCampaignMutation(input.store, () => {
    const before = snapshotCampaignState(input.store);
    const campaign = findVisibleCampaign(
      input.store,
      input.user,
      input.campaignId
    );
    assertIfMatch(campaign, input.ifMatch);

    const nextName = input.body.name?.trim() || campaign.name;
    const nextOwner = input.body.ownerId
      ? resolveOwner(input.store, input.user, input.body.ownerId)
      : input.store.users.find((item) => item.id === campaign.ownerId);
    if (!nextOwner) {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_OWNER_INVALID",
        "当前负责人已不存在，请由团队管理员重新分配"
      );
    }
    if (nextOwner.id !== campaign.ownerId
      && input.user.role !== "manager"
      && input.user.role !== "admin") {
      throw new ProspectCampaignRequestError(
        403,
        "CAMPAIGN_OWNER_FORBIDDEN",
        "只有团队经理或管理员可以转交负责人"
      );
    }
    const nameChanged = nextName !== campaign.name;
    const ownerChanged = nextOwner.id !== campaign.ownerId;
    const terminal = campaign.status === "archived"
      || campaign.status === "completed";
    if (terminal && nameChanged) {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_READ_ONLY",
        "已完成或已归档项目只能转交负责人，不能修改业务内容"
      );
    }
    if (!nameChanged && !ownerChanged) {
      return {
        value: campaignDetail(input.store, campaign),
        rollback: () => restoreCampaignState(input.store, before)
      };
    }

    const previousOwnerId = campaign.ownerId;
    if (ownerChanged) {
      if (activeProspectRunsForCampaign(
        input.store,
        campaign.teamId,
        campaign.id
      ).length) {
        throw new ProspectCampaignRequestError(
          409,
          "CAMPAIGN_ACTIVE_RUNS",
          "项目存在活动搜索运行，请先取消后再转交负责人"
        );
      }
      assertProspectStrategyOwnerConsistency(
        input.store.prospectStrategies.filter((item) =>
          item.teamId === campaign.teamId
          && item.campaignId === campaign.id
        ),
        previousOwnerId
      );
    }
    campaign.name = nextName;
    campaign.ownerId = nextOwner.id;
    campaign.revision += 1;
    campaign.updatedAt = new Date().toISOString();
    if (nameChanged) {
      input.store.prospectCampaignEvents.push(event({
        teamId: campaign.teamId,
        campaignId: campaign.id,
        eventType: "updated",
        actorId: input.user.id,
        requestId: input.requestId,
        fromStatus: campaign.status,
        toStatus: campaign.status,
        fromOwnerId: previousOwnerId,
        toOwnerId: campaign.ownerId,
        fromVersion: campaign.currentVersion,
        toVersion: campaign.currentVersion,
        revision: campaign.revision,
        reason: input.body.reason || "更新项目名称"
      }));
    }
    if (ownerChanged) {
      transferProspectStrategyOwners({
        store: input.store,
        campaign,
        fromOwnerId: previousOwnerId,
        toOwnerId: campaign.ownerId,
        actorId: input.user.id,
        requestId: input.requestId,
        reason: input.body.reason || "随项目转交搜索策略负责人"
      });
      input.store.prospectCampaignEvents.push(event({
        teamId: campaign.teamId,
        campaignId: campaign.id,
        eventType: "owner_transferred",
        actorId: input.user.id,
        requestId: input.requestId,
        fromStatus: campaign.status,
        toStatus: campaign.status,
        fromOwnerId: previousOwnerId,
        toOwnerId: campaign.ownerId,
        fromVersion: campaign.currentVersion,
        toVersion: campaign.currentVersion,
        revision: campaign.revision,
        reason: input.body.reason || "转交项目负责人"
      }));
    }
    return {
      value: campaignDetail(input.store, campaign),
      rollback: () => restoreCampaignState(input.store, before)
    };
  });
}

export async function createProspectCampaignVersion(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  ifMatch?: string;
  body: z.infer<typeof createProspectCampaignVersionSchema>;
  requestId: string;
}) {
  return persistCampaignMutation(input.store, () => {
    const before = snapshotCampaignState(input.store);
    const campaign = findVisibleCampaign(
      input.store,
      input.user,
      input.campaignId
    );
    assertIfMatch(campaign, input.ifMatch);
    if (activeProspectRunsForCampaign(
      input.store,
      campaign.teamId,
      campaign.id
    ).length) {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_ACTIVE_RUNS",
        "项目存在活动搜索运行，请先取消后再发布新规则版本"
      );
    }
    if (campaign.status !== "draft" && campaign.status !== "paused") {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_VERSION_LOCKED",
        "只有草稿或已暂停项目可以发布新规则版本"
      );
    }
    const previousVersion = currentVersion(input.store, campaign);
    const snapshot = normalizeProspectCampaignSnapshot({
      ...previousVersion.snapshot,
      ...input.body.snapshot
    });
    const contentHash = prospectCampaignSnapshotHash(snapshot);
    if (contentHash === previousVersion.contentHash) {
      return {
        value: {
          created: false,
          ...campaignDetail(input.store, campaign)
        },
        rollback: () => restoreCampaignState(input.store, before)
      };
    }
    const nextVersionNumber = campaign.currentVersion + 1;
    const now = new Date().toISOString();
    const version: ProspectCampaignVersion = {
      id: `pcv_${randomUUID()}`,
      teamId: campaign.teamId,
      campaignId: campaign.id,
      version: nextVersionNumber,
      snapshot,
      contentHash,
      changeSummary: input.body.changeSummary || "更新获客规则",
      createdBy: input.user.id,
      createdAt: now
    };
    input.store.prospectCampaignVersions.push(version);
    const previousRevision = campaign.revision;
    campaign.currentVersion = nextVersionNumber;
    campaign.revision = previousRevision + 1;
    campaign.updatedAt = now;
    input.store.prospectCampaignEvents.push(event({
      teamId: campaign.teamId,
      campaignId: campaign.id,
      eventType: "version_created",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: campaign.status,
      toStatus: campaign.status,
      fromOwnerId: campaign.ownerId,
      toOwnerId: campaign.ownerId,
      fromVersion: previousVersion.version,
      toVersion: nextVersionNumber,
      revision: campaign.revision,
      reason: version.changeSummary
    }));
    return {
      value: {
        created: true,
        ...campaignDetail(input.store, campaign)
      },
      rollback: () => restoreCampaignState(input.store, before)
    };
  });
}

export function prospectCampaignMissingFields(
  snapshot: ProspectCampaignVersionSnapshot
) {
  const missing: string[] = [];
  if (!snapshot.goal) missing.push("goal");
  if (!snapshot.products.length) missing.push("products");
  if (!snapshot.markets.length) missing.push("markets");
  if (!snapshot.customerTypes.length) missing.push("customerTypes");
  if (!snapshot.applicationScenarios.length) missing.push("applicationScenarios");
  if (!snapshot.sourceProviderIds.length) missing.push("sourceProviderIds");
  return missing;
}

export async function activateProspectCampaign(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  ifMatch?: string;
  requestId: string;
}) {
  return persistCampaignMutation(input.store, () => {
    const before = snapshotCampaignState(input.store);
    const campaign = findVisibleCampaign(
      input.store,
      input.user,
      input.campaignId
    );
    assertIfMatch(campaign, input.ifMatch);
    if (campaign.status !== "draft" && campaign.status !== "paused") {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_STATE_INVALID",
        "当前状态不能启动项目"
      );
    }
    const missingFields = prospectCampaignMissingFields(
      currentVersion(input.store, campaign).snapshot
    );
    if (missingFields.length) {
      throw new ProspectCampaignRequestError(
        422,
        "CAMPAIGN_FIELDS_REQUIRED",
        "获客项目资料尚未完整",
        { missingFields }
      );
    }
    const approvedStrategies = approvedStrategiesForCurrentVersion(
      input.store,
      campaign
    );
    if (!approvedStrategies.length) {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_STRATEGY_REQUIRED",
        "需先配置并校验至少一条搜索策略"
      );
    }
    const providerIssues = prospectStrategyActivationIssues(
      input.store,
      campaign,
      approvedStrategies
    );
    if (providerIssues.length) {
      throw new ProspectCampaignRequestError(
        422,
        "CAMPAIGN_PROVIDER_NOT_READY",
        "当前搜索策略的数据源尚未全部就绪",
        { issues: providerIssues }
      );
    }
    const previousStatus = campaign.status;
    campaign.status = "active";
    campaign.revision += 1;
    campaign.updatedAt = new Date().toISOString();
    input.store.prospectCampaignEvents.push(event({
      teamId: campaign.teamId,
      campaignId: campaign.id,
      eventType: "status_changed",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: previousStatus,
      toStatus: "active",
      fromOwnerId: campaign.ownerId,
      toOwnerId: campaign.ownerId,
      fromVersion: campaign.currentVersion,
      toVersion: campaign.currentVersion,
      revision: campaign.revision,
      reason: "启动获客项目"
    }));
    return {
      value: campaignDetail(input.store, campaign),
      rollback: () => restoreCampaignState(input.store, before)
    };
  });
}

const allowedTransitions: Record<
  Exclude<ProspectCampaignStatus, "active">,
  ProspectCampaignStatus[]
> = {
  draft: ["archived"],
  paused: ["completed", "archived"],
  completed: ["archived"],
  archived: []
};

export async function transitionProspectCampaign(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  ifMatch?: string;
  targetStatus: "paused" | "completed" | "archived";
  reason?: string;
  requestId: string;
}) {
  return persistCampaignMutation(input.store, () => {
    const before = snapshotCampaignState(input.store);
    const campaign = findVisibleCampaign(
      input.store,
      input.user,
      input.campaignId
    );
    assertIfMatch(campaign, input.ifMatch);
    const allowed = campaign.status === "active"
      ? ["paused", "completed"]
      : allowedTransitions[campaign.status];
    if (!allowed.includes(input.targetStatus)) {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_STATE_INVALID",
        `项目不能从 ${campaign.status} 转为 ${input.targetStatus}`
      );
    }
    if ((input.targetStatus === "completed"
      || input.targetStatus === "archived")
      && activeProspectRunsForCampaign(
        input.store,
        campaign.teamId,
        campaign.id
      ).length) {
      throw new ProspectCampaignRequestError(
        409,
        "CAMPAIGN_ACTIVE_RUNS",
        "项目存在活动搜索运行，请先取消后再完成或归档项目"
      );
    }

    const previousStatus = campaign.status;
    const now = new Date().toISOString();
    if (input.targetStatus === "paused") {
      try {
        pauseQueuedProspectRunsForCampaign({
          store: input.store,
          teamId: campaign.teamId,
          campaignId: campaign.id,
          actorId: input.user.id,
          requestId: input.requestId,
          reason: input.reason || "随获客项目暂停搜索运行",
          now
        });
      } catch (error) {
        if (error instanceof ProspectRunQueueBridgeIntegrityError) {
          throw new ProspectCampaignRequestError(
            409,
            error.code,
            "搜索运行队列桥接完整性校验失败，项目不能暂停"
          );
        }
        throw error;
      }
    }
    campaign.status = input.targetStatus;
    campaign.revision += 1;
    campaign.updatedAt = now;
    campaign.archivedAt = input.targetStatus === "archived"
      ? campaign.updatedAt
      : "";
    input.store.prospectCampaignEvents.push(event({
      teamId: campaign.teamId,
      campaignId: campaign.id,
      eventType: "status_changed",
      actorId: input.user.id,
      requestId: input.requestId,
      fromStatus: previousStatus,
      toStatus: campaign.status,
      fromOwnerId: campaign.ownerId,
      toOwnerId: campaign.ownerId,
      fromVersion: campaign.currentVersion,
      toVersion: campaign.currentVersion,
      revision: campaign.revision,
      reason: input.reason || `项目状态更新为 ${campaign.status}`
    }));
    return {
      value: campaignDetail(input.store, campaign),
      rollback: () => restoreCampaignState(input.store, before)
    };
  });
}

export function resolveMarketCampaignReference(input: {
  store: CrmStore;
  user: SessionUser;
  campaignId: string;
  requireActive?: boolean;
}) {
  if (!input.campaignId.startsWith("pc_")) {
    return {
      campaignContractMode: "compat_v1" as const,
      campaignScope: "owner" as const,
      campaign: null
    };
  }
  if (!formalCampaignIdPattern.test(input.campaignId)) {
    throw new ProspectCampaignRequestError(
      404,
      "CAMPAIGN_NOT_FOUND",
      "获客项目不存在或无权访问"
    );
  }
  const campaign = input.store.prospectCampaigns.find(
    (item) => item.id === input.campaignId
  );
  if (!campaign
    || campaign.teamId !== input.user.teamId
    || campaign.ownerId !== input.user.id
    || input.user.role === "super_admin") {
    throw new ProspectCampaignRequestError(
      404,
      "CAMPAIGN_NOT_FOUND",
      "获客项目不存在或无权访问"
    );
  }
  if (input.requireActive && campaign.status !== "active") {
    throw new ProspectCampaignRequestError(
      409,
      "CAMPAIGN_NOT_ACTIVE",
      "获客项目尚未启动"
    );
  }
  return {
    campaignContractMode: "formal_v1" as const,
    campaignScope: "owner" as const,
    campaign
  };
}
