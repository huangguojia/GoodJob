import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicUser } from "./auth.js";
import { prospectStrategyEtag } from "./prospect-strategies.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectSchedule,
  ProspectScheduleFrequency,
  ProspectStrategy,
  SessionUser
} from "./types.js";

const uuidV4Pattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const prospectScheduleIdSchema = z.string()
  .trim()
  .regex(new RegExp(`^psc_${uuidV4Pattern}$`, "i"));

export const createProspectScheduleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  timezone: z.string().trim().min(1).max(100).default("Asia/Shanghai"),
  recurringCostApproved: z.boolean().default(false)
}).strict();

export const prospectScheduleActionSchema = z.object({}).strict();

type CreateScheduleBody = z.infer<typeof createProspectScheduleSchema>;

export class ProspectScheduleRequestError extends Error {
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
    this.name = "ProspectScheduleRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function prospectScheduleEtag(
  schedule: Pick<ProspectSchedule, "id" | "revision">
) {
  return `"${schedule.id}:${schedule.revision}"`;
}

function assertScheduleRole(user: SessionUser) {
  if (user.role === "super_admin") {
    throw new ProspectScheduleRequestError(
      403,
      "SCHEDULE_ACCESS_FORBIDDEN",
      "超级管理员默认不能访问团队定时获客计划"
    );
  }
}

function scheduleApprovedStrategies(
  store: CrmStore,
  schedule: ProspectSchedule
) {
  return store.prospectStrategies.filter((item) =>
    item.teamId === schedule.teamId
    && item.ownerId === schedule.ownerId
    && item.campaignId === schedule.campaignId
    && item.campaignVersion === schedule.campaignVersion
    && item.status === "approved"
  );
}

function scheduleDueReviewCount(
  store: CrmStore,
  schedule: ProspectSchedule,
  now = new Date()
) {
  const dueAt = now.toISOString();
  const ownedProspectIds = new Set(store.prospectCoverageEvents
    .filter((item) =>
      item.teamId === schedule.teamId
      && item.ownerId === schedule.ownerId
      && item.campaignId === schedule.campaignId
      && item.eventType === "coverage_classified"
    )
    .map((item) => item.prospectId));
  return store.tenantProspects.filter((item) =>
    item.teamId === schedule.teamId
    && item.status === "active"
    && Boolean(item.nextReviewAt)
    && item.nextReviewAt <= dueAt
    && ownedProspectIds.has(item.id)
  ).length;
}

function publicSchedule(store: CrmStore, schedule: ProspectSchedule) {
  const { teamId: _teamId, ...visible } = schedule;
  const approvedStrategies = scheduleApprovedStrategies(store, schedule);
  const rotatableStrategyCount = approvedStrategies.filter((item) =>
    schedule.recurringCostApproved
    || !strategyNeedsRecurringCostApproval(store, item)
  ).length;
  const lastStrategyId = store.prospectSearchRuns.find((item) =>
    item.id === schedule.lastRunId
    && item.teamId === schedule.teamId
    && item.ownerId === schedule.ownerId
  )?.strategyId || "";
  return {
    ...visible,
    orchestrationMode: "campaign_rotation_v1" as const,
    approvedStrategyCount: approvedStrategies.length,
    rotatableStrategyCount,
    lastStrategyId,
    dueReviewCount: scheduleDueReviewCount(store, schedule)
  };
}

function canRead(user: SessionUser, schedule: ProspectSchedule) {
  if (user.role === "manager" || user.role === "admin") {
    return user.teamId === schedule.teamId;
  }
  return user.teamId === schedule.teamId && user.id === schedule.ownerId;
}

function findVisibleSchedule(
  store: CrmStore,
  user: SessionUser,
  scheduleId: string
) {
  assertScheduleRole(user);
  const schedule = store.prospectSchedules.find((item) =>
    item.id === scheduleId && canRead(user, item)
  );
  if (!schedule) {
    throw new ProspectScheduleRequestError(
      404,
      "SCHEDULE_NOT_FOUND",
      "定时获客计划不存在或无权访问"
    );
  }
  return schedule;
}

function assertOwnerMutation(user: SessionUser, schedule: ProspectSchedule) {
  if (schedule.ownerId !== user.id || schedule.teamId !== user.teamId) {
    throw new ProspectScheduleRequestError(
      403,
      "SCHEDULE_MUTATION_FORBIDDEN",
      "只能修改本人创建的定时获客计划"
    );
  }
}

function assertIfMatch(schedule: ProspectSchedule, ifMatch?: string) {
  if (!ifMatch) {
    throw new ProspectScheduleRequestError(
      428,
      "IF_MATCH_REQUIRED",
      "必须提供 If-Match 请求头"
    );
  }
  if (ifMatch.trim() !== prospectScheduleEtag(schedule)) {
    throw new ProspectScheduleRequestError(
      412,
      "SCHEDULE_REVISION_CONFLICT",
      "定时获客计划已更新，请刷新后重试"
    );
  }
}

function assertTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ProspectScheduleRequestError(
      400,
      "INVALID_TIMEZONE",
      "时区无效"
    );
  }
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second)
  };
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ) - date.getTime();
}

function zonedDateToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}, timezone: string) {
  const wallClock = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second
  );
  let candidate = new Date(wallClock);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    candidate = new Date(wallClock - timezoneOffsetMs(candidate, timezone));
  }
  return candidate;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextProspectScheduleOccurrence(
  from: string | Date,
  frequency: ProspectScheduleFrequency,
  timezone: string
) {
  assertTimezone(timezone);
  const source = typeof from === "string" ? new Date(from) : from;
  if (Number.isNaN(source.getTime())) {
    throw new ProspectScheduleRequestError(
      400,
      "INVALID_SCHEDULE_TIME",
      "定时计划时间无效"
    );
  }
  const parts = zonedParts(source, timezone);
  const local = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ));
  if (frequency === "daily") local.setUTCDate(local.getUTCDate() + 1);
  if (frequency === "weekly") local.setUTCDate(local.getUTCDate() + 7);
  if (frequency === "monthly") {
    const targetMonth = parts.month === 12 ? 1 : parts.month + 1;
    const targetYear = parts.month === 12 ? parts.year + 1 : parts.year;
    local.setUTCFullYear(
      targetYear,
      targetMonth - 1,
      Math.min(parts.day, daysInMonth(targetYear, targetMonth))
    );
  }
  return zonedDateToUtc({
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  }, timezone).toISOString();
}

export function advanceProspectScheduleBeyond(
  plannedAt: string,
  frequency: ProspectScheduleFrequency,
  timezone: string,
  now: Date
) {
  let next = nextProspectScheduleOccurrence(plannedAt, frequency, timezone);
  while (new Date(next).getTime() <= now.getTime()) {
    next = nextProspectScheduleOccurrence(next, frequency, timezone);
  }
  return next;
}

export function strategyNeedsRecurringCostApproval(
  store: CrmStore,
  strategy: ProspectStrategy
) {
  return strategy.providerPlan.some((plan) => {
    if (plan.providerId === "ai_search" || (plan.budgetLimit || 0) > 0) {
      return true;
    }
    const catalog = store.providerCatalog.find((item) =>
      item.code === plan.providerId
    );
    return catalog?.licensePolicy.tier === "ai"
      || catalog?.licensePolicy.tier === "paid";
  });
}

function scheduleReferences(store: CrmStore, strategyId: string) {
  const strategy = store.prospectStrategies.find((item) => item.id === strategyId);
  const campaign = strategy
    ? store.prospectCampaigns.find((item) =>
        item.id === strategy.campaignId && item.teamId === strategy.teamId
      )
    : undefined;
  return { strategy, campaign };
}

function persistMutation<T>(
  store: CrmStore,
  mutation: () => PersistedStoreMutation<T>
) {
  if (store.persistMutation) return store.persistMutation(mutation);
  const applied = mutation();
  return store.persist()
    .then(() => applied.value)
    .catch((error) => {
      applied.rollback();
      throw error;
    });
}

export function listProspectSchedules(store: CrmStore, user: SessionUser) {
  assertScheduleRole(user);
  const schedules = store.prospectSchedules
    .filter((item) => canRead(user, item))
    .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))
    .map((item) => publicSchedule(store, item));
  return { schedules, total: schedules.length };
}

export async function createProspectSchedule(input: {
  store: CrmStore;
  user: SessionUser;
  strategyId: string;
  ifMatch?: string;
  body: CreateScheduleBody;
  now?: Date;
}) {
  assertScheduleRole(input.user);
  assertTimezone(input.body.timezone);
  return persistMutation(input.store, () => {
    const { strategy, campaign } = scheduleReferences(
      input.store,
      input.strategyId
    );
    if (!strategy || !campaign
      || strategy.teamId !== input.user.teamId
      || strategy.ownerId !== input.user.id
      || campaign.ownerId !== input.user.id) {
      throw new ProspectScheduleRequestError(
        404,
        "STRATEGY_NOT_FOUND",
        "搜索策略不存在或无权创建定时计划"
      );
    }
    if (strategy.status !== "approved"
      || campaign.status !== "active"
      || strategy.campaignVersion !== campaign.currentVersion) {
      throw new ProspectScheduleRequestError(
        422,
        "SCHEDULE_NOT_READY",
        "只能为当前版本已批准策略创建定时计划"
      );
    }
    if (input.ifMatch !== prospectStrategyEtag(strategy)) {
      throw new ProspectScheduleRequestError(
        input.ifMatch ? 412 : 428,
        input.ifMatch ? "STRATEGY_REVISION_CONFLICT" : "IF_MATCH_REQUIRED",
        input.ifMatch ? "搜索策略已更新，请刷新后重试" : "必须提供 If-Match 请求头"
      );
    }
    if (strategyNeedsRecurringCostApproval(input.store, strategy)
      && !input.body.recurringCostApproved) {
      throw new ProspectScheduleRequestError(
        422,
        "RECURRING_COST_APPROVAL_REQUIRED",
        "定期运行包含计费或 AI 数据源，需要单独确认持续费用"
      );
    }
    const existing = input.store.prospectSchedules.find((item) =>
      item.campaignId === campaign.id
      && item.campaignVersion === campaign.currentVersion
      && item.ownerId === input.user.id
      && item.status === "active"
    );
    if (existing) {
      throw new ProspectScheduleRequestError(
        409,
        "ACTIVE_SCHEDULE_EXISTS",
        "当前获客项目版本已有启用中的定时计划",
        { scheduleId: existing.id }
      );
    }
    const before = [...input.store.prospectSchedules];
    const now = input.now || new Date();
    const createdAt = now.toISOString();
    const schedule: ProspectSchedule = {
      id: `psc_${randomUUID()}`,
      teamId: strategy.teamId,
      ownerId: input.user.id,
      campaignId: campaign.id,
      campaignVersion: campaign.currentVersion,
      strategyId: strategy.id,
      frequency: input.body.frequency,
      status: "active",
      timezone: input.body.timezone,
      nextRunAt: nextProspectScheduleOccurrence(
        now,
        input.body.frequency,
        input.body.timezone
      ),
      lastRunAt: "",
      lastRunId: "",
      lastPlannedAt: "",
      lastFailureCode: "",
      lastFailureReason: "",
      recurringCostApproved: input.body.recurringCostApproved,
      revision: 1,
      createdBy: input.user.id,
      createdAt,
      updatedAt: createdAt
    };
    input.store.prospectSchedules.push(schedule);
    return {
      value: { schedule: publicSchedule(input.store, schedule) },
      rollback: () => {
        input.store.prospectSchedules.splice(
          0,
          input.store.prospectSchedules.length,
          ...before
        );
      }
    };
  });
}

export async function transitionProspectSchedule(input: {
  store: CrmStore;
  user: SessionUser;
  scheduleId: string;
  ifMatch?: string;
  action: "pause" | "resume";
  now?: Date;
}) {
  return persistMutation(input.store, () => {
    const schedule = findVisibleSchedule(
      input.store,
      input.user,
      input.scheduleId
    );
    assertOwnerMutation(input.user, schedule);
    assertIfMatch(schedule, input.ifMatch);
    const target = input.action === "pause" ? "paused" : "active";
    if (schedule.status === target) {
      return {
        value: { schedule: publicSchedule(input.store, schedule) },
        rollback: () => undefined
      };
    }
    const before = structuredClone(schedule);
    const now = input.now || new Date();
    schedule.status = target;
    if (target === "active") {
      const activeSchedule = input.store.prospectSchedules.find((item) =>
        item.id !== schedule.id
        && item.teamId === schedule.teamId
        && item.ownerId === schedule.ownerId
        && item.campaignId === schedule.campaignId
        && item.campaignVersion === schedule.campaignVersion
        && item.status === "active"
      );
      if (activeSchedule) {
        throw new ProspectScheduleRequestError(
          409,
          "ACTIVE_SCHEDULE_EXISTS",
          "当前获客项目版本已有启用中的定时计划",
          { scheduleId: activeSchedule.id }
        );
      }
      const { strategy, campaign } = scheduleReferences(
        input.store,
        schedule.strategyId
      );
      if (!strategy || !campaign
        || strategy.status !== "approved"
        || campaign.status !== "active"
        || campaign.currentVersion !== schedule.campaignVersion
        || strategy.campaignVersion !== schedule.campaignVersion
        || strategy.ownerId !== schedule.ownerId
        || campaign.ownerId !== schedule.ownerId) {
        throw new ProspectScheduleRequestError(
          422,
          "SCHEDULE_NOT_READY",
          "项目或策略已变化，当前计划不能恢复"
        );
      }
      schedule.nextRunAt = nextProspectScheduleOccurrence(
        now,
        schedule.frequency,
        schedule.timezone
      );
      schedule.lastFailureCode = "";
      schedule.lastFailureReason = "";
    }
    schedule.revision += 1;
    schedule.updatedAt = now.toISOString();
    return {
      value: { schedule: publicSchedule(input.store, schedule) },
      rollback: () => Object.assign(schedule, before)
    };
  });
}

export async function deleteProspectSchedule(input: {
  store: CrmStore;
  user: SessionUser;
  scheduleId: string;
  ifMatch?: string;
}) {
  return persistMutation(input.store, () => {
    const schedule = findVisibleSchedule(
      input.store,
      input.user,
      input.scheduleId
    );
    assertOwnerMutation(input.user, schedule);
    assertIfMatch(schedule, input.ifMatch);
    const index = input.store.prospectSchedules.indexOf(schedule);
    input.store.prospectSchedules.splice(index, 1);
    return {
      value: { deleted: true, id: schedule.id },
      rollback: () => input.store.prospectSchedules.splice(index, 0, schedule)
    };
  });
}

export function scheduleOwnerSession(
  store: CrmStore,
  schedule: ProspectSchedule
) {
  const owner = store.users.find((item) =>
    item.id === schedule.ownerId
    && item.teamId === schedule.teamId
    && item.status === "active"
  );
  return owner ? publicUser(owner) : null;
}
