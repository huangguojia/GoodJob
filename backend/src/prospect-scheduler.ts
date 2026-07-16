import { createHash, randomUUID } from "node:crypto";
import { getProvider } from "./lead-providers.js";
import { createProspectRun, ProspectRunRequestError } from "./prospect-runs.js";
import {
  advanceProspectScheduleBeyond,
  scheduleOwnerSession,
  strategyNeedsRecurringCostApproval
} from "./prospect-schedules.js";
import { prospectStrategyEtag } from "./prospect-strategies.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type {
  ProspectSchedule,
  ProspectStrategy,
  TenantProspect
} from "./types.js";

export interface ProspectSchedulerOptions {
  store: CrmStore;
  pollMs?: number;
  now?: () => Date;
  onRunCreated?: (runId: string) => Promise<void> | void;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
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

export class ProspectScheduler {
  private readonly store: CrmStore;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly onRunCreated?: (runId: string) => Promise<void> | void;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: ProspectSchedulerOptions) {
    this.store = options.store;
    this.pollMs = Math.max(500, positiveInteger(options.pollMs, 15_000));
    this.now = options.now || (() => new Date());
    this.onRunCreated = options.onRunCreated;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.pollMs);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async runOnce() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.store.readBarrier();
      const now = this.now();
      const activeIds = this.store.prospectSchedules
        .filter((item) => item.status === "active")
        .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))
        .map((item) => item.id);
      for (const id of activeIds) {
        const schedule = this.store.prospectSchedules.find((item) =>
          item.id === id && item.status === "active"
        );
        if (!schedule) continue;
        const reviewBatch = this.dueReviewBatch(schedule, now);
        if (new Date(schedule.nextRunAt).getTime() <= now.getTime()) {
          await this.executeDue(id, now, reviewBatch);
        } else if (reviewBatch
          && !this.reviewBatchAlreadyStarted(schedule, reviewBatch.fingerprint)
          && !this.reviewRetryDeferred(schedule, now)) {
          await this.executeReviewDue(id, now, reviewBatch);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private invalidReason(schedule: ProspectSchedule) {
    const owner = scheduleOwnerSession(this.store, schedule);
    const campaign = this.store.prospectCampaigns.find((item) =>
      item.id === schedule.campaignId && item.teamId === schedule.teamId
    );
    const anchorStrategy = this.store.prospectStrategies.find((item) =>
      item.id === schedule.strategyId && item.teamId === schedule.teamId
    );
    if (!owner) return { code: "SCHEDULE_OWNER_INVALID", reason: "负责人账号不存在或已停用" };
    if (!campaign || !anchorStrategy) {
      return { code: "SCHEDULE_REFERENCE_INVALID", reason: "项目或计划锚点策略不存在" };
    }
    if (campaign.ownerId !== schedule.ownerId
      || campaign.status !== "active"
      || campaign.currentVersion !== schedule.campaignVersion
      || anchorStrategy.ownerId !== schedule.ownerId
      || anchorStrategy.campaignVersion !== schedule.campaignVersion
      || anchorStrategy.campaignId !== campaign.id) {
      return { code: "SCHEDULE_REFERENCE_CHANGED", reason: "项目、负责人或项目版本已经变化" };
    }
    return null;
  }

  private activeConnectionId(schedule: ProspectSchedule, providerCode: string) {
    return this.store.providerConnections.find((item) =>
      item.providerId === providerCode
      && item.teamId === schedule.teamId
      && item.ownerId === schedule.ownerId
      && item.scope === "personal"
      && item.status === "active"
    )?.id || `builtin:${providerCode}`;
  }

  private strategySourceExhausted(
    schedule: ProspectSchedule,
    strategy: ProspectStrategy
  ) {
    if (!strategy.providerPlan.length) return true;
    return strategy.providerPlan.every((plan) => {
      const provider = plan.providerId === "ai_search"
        ? null
        : getProvider(plan.providerId);
      const catalog = this.store.providerCatalog.find((item) =>
        item.code.toLocaleLowerCase("en-US") === plan.providerId
      );
      if (!catalog || (plan.providerId !== "ai_search" && !provider)) {
        return false;
      }
      const position = this.store.prospectStrategySourcePositions.find((item) =>
        item.teamId === schedule.teamId
        && item.ownerId === schedule.ownerId
        && item.campaignId === schedule.campaignId
        && item.campaignVersion === schedule.campaignVersion
        && item.strategyId === strategy.id
        && item.providerCode === plan.providerId
        && item.queryFingerprint === strategy.queryFingerprint
        && item.connectionId === this.activeConnectionId(
          schedule,
          plan.providerId
        )
        && item.endpointCode === "company-search"
        && item.adapterVersion === (
          provider?.adapterVersion || "ai-search-control-v1"
        )
        && item.contractVersion === (
          provider?.contractVersion || "search_run_control_plane_v1"
        )
        && item.catalogVersion === catalog.version
      );
      return position?.status === "exhausted";
    });
  }

  private eligibleStrategies(schedule: ProspectSchedule) {
    return this.store.prospectStrategies
      .filter((item) =>
        item.teamId === schedule.teamId
        && item.ownerId === schedule.ownerId
        && item.campaignId === schedule.campaignId
        && item.campaignVersion === schedule.campaignVersion
        && item.status === "approved"
        && (
          schedule.recurringCostApproved
          || !strategyNeedsRecurringCostApproval(this.store, item)
        )
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      );
  }

  private selectNextStrategy(schedule: ProspectSchedule) {
    const eligible = this.eligibleStrategies(schedule);
    if (!eligible.length) {
      return {
        strategy: null,
        failureCode: "SCHEDULE_NO_ELIGIBLE_STRATEGY",
        failureReason: "没有满足当前费用确认条件的已批准策略"
      };
    }
    const lastStrategyId = this.store.prospectSearchRuns.find((item) =>
      item.id === schedule.lastRunId
      && item.teamId === schedule.teamId
      && item.ownerId === schedule.ownerId
    )?.strategyId || "";
    const anchor = eligible.find((item) => item.id === schedule.strategyId);
    const ordered = !lastStrategyId && anchor
      ? [anchor, ...eligible.filter((item) => item.id !== anchor.id)]
      : eligible;
    const lastIndex = ordered.findIndex((item) => item.id === lastStrategyId);
    for (let offset = 1; offset <= ordered.length; offset += 1) {
      const index = (Math.max(lastIndex, -1) + offset) % ordered.length;
      const strategy = ordered[index]!;
      if (!this.strategySourceExhausted(schedule, strategy)) {
        return { strategy, failureCode: "", failureReason: "" };
      }
    }
    return {
      strategy: null,
      failureCode: "SCHEDULE_ALL_STRATEGIES_EXHAUSTED",
      failureReason: "满足当前费用确认条件的策略来源均已搜索完毕"
    };
  }

  private dueReviewBatch(schedule: ProspectSchedule, now: Date) {
    const ownerProspectIds = new Set(this.store.prospectCoverageEvents
      .filter((item) =>
        item.teamId === schedule.teamId
        && item.ownerId === schedule.ownerId
        && item.campaignId === schedule.campaignId
        && item.eventType === "coverage_classified"
      )
      .map((item) => item.prospectId));
    const prospects = this.store.tenantProspects
      .filter((item) =>
        item.teamId === schedule.teamId
        && item.status === "active"
        && Boolean(item.nextReviewAt)
        && new Date(item.nextReviewAt).getTime() <= now.getTime()
        && ownerProspectIds.has(item.id)
      )
      .sort((left, right) =>
        left.nextReviewAt.localeCompare(right.nextReviewAt)
        || left.id.localeCompare(right.id)
      )
      .slice(0, 100);
    if (!prospects.length) return null;
    const fingerprint = createHash("sha256")
      .update(prospects.map((item) =>
        `${item.id}:${item.nextReviewAt}`
      ).join("|"))
      .digest("hex")
      .slice(0, 24);
    return { prospects, fingerprint };
  }

  private reviewBatchAlreadyStarted(
    schedule: ProspectSchedule,
    fingerprint: string
  ) {
    const marker = `review:${fingerprint}`;
    const runIds = new Set(this.store.prospectSearchRuns
      .filter((item) =>
        item.teamId === schedule.teamId
        && item.ownerId === schedule.ownerId
        && item.campaignId === schedule.campaignId
      )
      .map((item) => item.id));
    return this.store.prospectRunEvents.some((item) =>
      item.teamId === schedule.teamId
      && runIds.has(item.runId)
      && item.eventType === "created"
      && item.reason.includes(marker)
    );
  }

  private reviewRetryDeferred(schedule: ProspectSchedule, now: Date) {
    if (!schedule.lastFailureCode.startsWith("SCHEDULE_REVIEW_")
      || !schedule.lastRunAt) {
      return false;
    }
    return now.getTime() - new Date(schedule.lastRunAt).getTime()
      < 15 * 60 * 1_000;
  }

  private reviewReason(input: {
    schedule: ProspectSchedule;
    prospects: TenantProspect[];
    fingerprint: string;
    regular: boolean;
  }) {
    const organizationIds = input.prospects
      .map((item) => item.organizationId)
      .slice(0, 5)
      .join(",");
    return [
      input.regular ? `定时获客计划 ${input.schedule.id}` : `候选到期复查 ${input.schedule.id}`,
      `review:${input.fingerprint}`,
      `复查候选 ${input.prospects.length} 个`,
      organizationIds ? `企业 ${organizationIds}` : ""
    ].filter(Boolean).join("；").slice(0, 500);
  }

  private async updateSchedule(
    scheduleId: string,
    update: (schedule: ProspectSchedule) => void
  ) {
    return persistMutation(this.store, () => {
      const schedule = this.store.prospectSchedules.find((item) =>
        item.id === scheduleId
      );
      if (!schedule) {
        return { value: undefined, rollback: () => undefined };
      }
      const before = structuredClone(schedule);
      update(schedule);
      schedule.revision += 1;
      schedule.updatedAt = this.now().toISOString();
      return {
        value: undefined,
        rollback: () => Object.assign(schedule, before)
      };
    });
  }

  private async executeDue(
    scheduleId: string,
    now: Date,
    reviewBatch: ReturnType<ProspectScheduler["dueReviewBatch"]>
  ) {
    const schedule = this.store.prospectSchedules.find((item) =>
      item.id === scheduleId && item.status === "active"
    );
    if (!schedule) return;
    const plannedAt = schedule.nextRunAt;
    const invalid = this.invalidReason(schedule);
    if (invalid) {
      await this.updateSchedule(schedule.id, (current) => {
        current.status = "paused";
        current.lastFailureCode = invalid.code;
        current.lastFailureReason = invalid.reason;
      });
      return;
    }
    const owner = scheduleOwnerSession(this.store, schedule)!;
    const selected = this.selectNextStrategy(schedule);
    if (!selected.strategy) {
      await this.updateSchedule(schedule.id, (current) => {
        current.lastPlannedAt = plannedAt;
        current.lastRunAt = now.toISOString();
        current.lastRunId = "";
        current.lastFailureCode = selected.failureCode;
        current.lastFailureReason = selected.failureReason;
        current.nextRunAt = advanceProspectScheduleBeyond(
          plannedAt,
          current.frequency,
          current.timezone,
          now
        );
      });
      return;
    }
    const strategy = selected.strategy;
    let runId = "";
    let failureCode = "";
    let failureReason = "";
    try {
      const result = await createProspectRun({
        store: this.store,
        user: owner,
        strategyId: strategy.id,
        ifMatch: prospectStrategyEtag(strategy),
        idempotencyKey: `prospect-schedule:${schedule.id}:${plannedAt}`,
        body: {
          reason: reviewBatch
            ? this.reviewReason({
                schedule,
                prospects: reviewBatch.prospects,
                fingerprint: reviewBatch.fingerprint,
                regular: true
              })
            : `定时获客计划 ${schedule.id}；策略轮换 ${strategy.id}`
        },
        requestId: `prospect-scheduler-${randomUUID()}`
      });
      runId = result.run.id;
      await this.notifyRunCreated(runId);
    } catch (error) {
      if (error instanceof ProspectRunRequestError) {
        failureCode = `SCHEDULE_REVIEW_${error.code}`.slice(0, 100);
        failureReason = error.message;
      } else {
        failureCode = "SCHEDULE_RUN_FAILED";
        failureReason = error instanceof Error ? error.message : String(error);
      }
    }
    await this.updateSchedule(schedule.id, (current) => {
      current.lastPlannedAt = plannedAt;
      current.lastRunAt = now.toISOString();
      current.lastRunId = runId;
      current.lastFailureCode = failureCode;
      current.lastFailureReason = failureReason.slice(0, 500);
      current.nextRunAt = advanceProspectScheduleBeyond(
        plannedAt,
        current.frequency,
        current.timezone,
        now
      );
    });
  }

  private async executeReviewDue(
    scheduleId: string,
    now: Date,
    reviewBatch: NonNullable<ReturnType<ProspectScheduler["dueReviewBatch"]>>
  ) {
    const schedule = this.store.prospectSchedules.find((item) =>
      item.id === scheduleId && item.status === "active"
    );
    if (!schedule) return;
    const invalid = this.invalidReason(schedule);
    if (invalid) {
      await this.updateSchedule(schedule.id, (current) => {
        current.status = "paused";
        current.lastFailureCode = invalid.code;
        current.lastFailureReason = invalid.reason;
      });
      return;
    }
    const selected = this.selectNextStrategy(schedule);
    if (!selected.strategy) return;
    const owner = scheduleOwnerSession(this.store, schedule)!;
    const strategy = selected.strategy;
    let runId = "";
    let failureCode = "";
    let failureReason = "";
    try {
      const result = await createProspectRun({
        store: this.store,
        user: owner,
        strategyId: strategy.id,
        ifMatch: prospectStrategyEtag(strategy),
        idempotencyKey:
          `prospect-review:${schedule.id}:${reviewBatch.fingerprint}`,
        body: {
          reason: this.reviewReason({
            schedule,
            prospects: reviewBatch.prospects,
            fingerprint: reviewBatch.fingerprint,
            regular: false
          })
        },
        requestId: `prospect-review-scheduler-${randomUUID()}`
      });
      runId = result.run.id;
      await this.notifyRunCreated(runId);
    } catch (error) {
      if (error instanceof ProspectRunRequestError) {
        failureCode = error.code;
        failureReason = error.message;
      } else {
        failureCode = "SCHEDULE_REVIEW_RUN_FAILED";
        failureReason = error instanceof Error ? error.message : String(error);
      }
    }
    await this.updateSchedule(schedule.id, (current) => {
      current.lastPlannedAt = now.toISOString();
      current.lastRunAt = now.toISOString();
      current.lastRunId = runId;
      current.lastFailureCode = failureCode;
      current.lastFailureReason = failureReason.slice(0, 500);
    });
  }

  private async notifyRunCreated(runId: string) {
    try {
      await this.onRunCreated?.(runId);
    } catch (error) {
      console.error("[prospect-scheduler]", {
        event: "queue_coordination_sync_failed",
        runId,
        code: typeof error === "object"
          && error !== null
          && "code" in error
          ? String(error.code || "UNCLASSIFIED")
          : "UNCLASSIFIED"
      });
    }
  }
}
