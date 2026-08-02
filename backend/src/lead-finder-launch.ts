import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  activateProspectCampaign,
  createProspectCampaign,
  createProspectCampaignSchema,
  getProspectCampaign,
  normalizeProspectCampaignSnapshot,
  prospectCampaignEtag
} from "./prospect-campaigns.js";
import {
  createProspectRun,
  getProspectRun,
  prospectRunIdempotencyKeySchema,
  ProspectRunRequestError
} from "./prospect-runs.js";
import {
  createProspectSchedule,
  createProspectScheduleSchema
} from "./prospect-schedules.js";
import {
  approveProspectStrategy,
  listProspectStrategies,
  prospectStrategyEtag,
  updateProspectStrategy,
  updateProspectStrategySchema
} from "./prospect-strategies.js";
import {
  createProspectSuperSearch,
  superSearchDetail
} from "./prospect-super-search.js";
import type { CrmStore } from "./store.js";
import type { SessionUser } from "./types.js";

const superSearchLaunchOptionsSchema = z.object({
  targetCandidateCount: z.number().int().min(20).max(10_000).default(300),
  maxDurationMinutes: z.number().int().min(30).max(4_320).default(480),
  depth: z.enum(["balanced", "deep", "extreme"]).default("deep"),
  costLimit: z.number().finite().min(0).max(1_000_000).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).or(z.literal("")).default(""),
  aiMode: z.enum(["auto", "off"]).default("auto"),
  webSearchMode: z.enum(["off", "api"]).default("off"),
  mapSearchMode: z.enum(["off", "google_places"]).default("off"),
  aiDiscoveryMode: z.enum(["off", "model"]).default("off")
}).strict().superRefine((value, context) => {
  if (value.costLimit > 0 && !value.currency) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currency"],
      message: "设置费用上限时必须填写币种"
    });
  }
  if (value.costLimit === 0 && value.currency) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currency"],
      message: "免费搜索不要填写币种"
    });
  }
});

export const launchLeadFinderSchema = z.object({
  mode: z.enum(["standard", "super"]).default("standard"),
  campaign: createProspectCampaignSchema,
  strategy: updateProspectStrategySchema,
  schedule: createProspectScheduleSchema.optional(),
  superSearch: superSearchLaunchOptionsSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "super" && !value.superSearch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["superSearch"],
      message: "超级搜索缺少任务参数"
    });
  }
  if (value.mode === "standard" && value.superSearch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["superSearch"],
      message: "普通搜客不能提交超级搜索参数"
    });
  }
  if (value.mode === "super" && value.schedule) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule"],
      message: "超级搜索不支持同时创建定期计划"
    });
  }
});

export type LaunchLeadFinderBody = z.infer<typeof launchLeadFinderSchema>;

export interface LeadFinderLaunchTimings {
  campaignMs: number;
  strategyMs: number;
  approvalMs: number;
  activationMs: number;
  runMs: number;
  scheduleMs: number;
  queueMs: number;
  totalMs: number;
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

function launchRequestPrefix(idempotencyKey: string) {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `lead-finder-launch:${digest.slice(0, 32)}`;
}

function assertCampaignReplayMatches(
  store: CrmStore,
  campaignId: string,
  body: LaunchLeadFinderBody["campaign"]
) {
  const campaign = store.prospectCampaigns.find((item) => item.id === campaignId);
  const version = campaign && store.prospectCampaignVersions.find((item) =>
    item.campaignId === campaign.id && item.version === campaign.currentVersion
  );
  const expectedSnapshot = normalizeProspectCampaignSnapshot(body.snapshot);
  if (!campaign
    || !version
    || campaign.name !== body.name.trim()
    || !isDeepStrictEqual(version.snapshot, expectedSnapshot)) {
    throw new ProspectRunRequestError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该启动请求标识已用于不同的搜客条件，请重新创建任务"
    );
  }
}

export async function launchLeadFinder(input: {
  store: CrmStore;
  user: SessionUser;
  body: LaunchLeadFinderBody;
  idempotencyKey: string;
  onRunCreated?: () => void | Promise<void>;
}) {
  const body = launchLeadFinderSchema.parse(input.body);
  // The aggregate launch endpoint must always carry an executable source
  // plan. Reject before creating the campaign so an empty plan cannot leave a
  // draft project behind and fail later with the generic approval message.
  if (!body.strategy.providerPlan?.length) {
    throw new ProspectRunRequestError(
      422,
      "LEAD_FINDER_SOURCES_REQUIRED",
      "当前没有可执行的数据源，请至少选择一个已启用的数据源后重试",
      { field: "strategy.providerPlan" }
    );
  }
  const idempotencyKey = prospectRunIdempotencyKeySchema.parse(
    input.idempotencyKey
  );
  const startedAt = performance.now();
  const timings: LeadFinderLaunchTimings = {
    campaignMs: 0,
    strategyMs: 0,
    approvalMs: 0,
    activationMs: 0,
    runMs: 0,
    scheduleMs: 0,
    queueMs: 0,
    totalMs: 0
  };
  const requestPrefix = launchRequestPrefix(idempotencyKey);
  const existingCampaignEvent = input.store.prospectCampaignEvents.find((item) =>
    item.eventType === "created"
    && item.actorId === input.user.id
    && item.teamId === input.user.teamId
    && item.requestId === `${requestPrefix}:campaign`
  );
  let replayed = Boolean(existingCampaignEvent);

  let stepStartedAt = performance.now();
  let campaignDetail: ReturnType<typeof getProspectCampaign>;
  if (existingCampaignEvent) {
    assertCampaignReplayMatches(
      input.store,
      existingCampaignEvent.campaignId,
      body.campaign
    );
    campaignDetail = getProspectCampaign(
      input.store,
      input.user,
      existingCampaignEvent.campaignId
    );
  } else {
    campaignDetail = await createProspectCampaign({
      store: input.store,
      user: input.user,
      body: body.campaign,
      requestId: `${requestPrefix}:campaign`
    });
  }
  timings.campaignMs = elapsedMs(stepStartedAt);

  let strategy = listProspectStrategies(
    input.store,
    input.user,
    campaignDetail.campaign.id,
    false
  ).strategies.find((item) =>
    item.campaignVersion === campaignDetail.campaign.currentVersion
    && item.status === "approved"
  ) || listProspectStrategies(
    input.store,
    input.user,
    campaignDetail.campaign.id,
    false
  ).strategies.find((item) =>
    item.campaignVersion === campaignDetail.campaign.currentVersion
    && item.status === "draft"
  );
  if (!strategy) {
    throw new ProspectRunRequestError(
      500,
      "LEAD_FINDER_STRATEGY_MISSING",
      "系统未能生成可用的搜索策略"
    );
  }

  if (strategy.status === "draft") {
    stepStartedAt = performance.now();
    const updated = await updateProspectStrategy({
      store: input.store,
      user: input.user,
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(strategy),
      body: body.strategy,
      requestId: `${requestPrefix}:strategy`
    });
    strategy = updated.strategy;
    timings.strategyMs = elapsedMs(stepStartedAt);

    stepStartedAt = performance.now();
    const approved = await approveProspectStrategy({
      store: input.store,
      user: input.user,
      strategyId: strategy.id,
      ifMatch: prospectStrategyEtag(strategy),
      reason: "业务员确认搜客条件并启动",
      requestId: `${requestPrefix}:approve`
    });
    strategy = approved.strategy;
    timings.approvalMs = elapsedMs(stepStartedAt);
  }

  campaignDetail = getProspectCampaign(
    input.store,
    input.user,
    campaignDetail.campaign.id
  );
  if (campaignDetail.campaign.status === "draft"
    || campaignDetail.campaign.status === "paused") {
    stepStartedAt = performance.now();
    campaignDetail = await activateProspectCampaign({
      store: input.store,
      user: input.user,
      campaignId: campaignDetail.campaign.id,
      ifMatch: prospectCampaignEtag(campaignDetail.campaign),
      requestId: `${requestPrefix}:activate`
    });
    timings.activationMs = elapsedMs(stepStartedAt);
  }

  let runDetail;
  let superSearch;
  if (body.mode === "super") {
    const existingMission = input.store.prospectSuperSearchMissions
      .filter((item) => item.strategyId === strategy.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    stepStartedAt = performance.now();
    if (existingMission?.currentRunId) {
      replayed = true;
      const detail = superSearchDetail(input.store, input.user, existingMission);
      superSearch = {
        ...detail.mission,
        rounds: detail.rounds,
        acceptance: detail.acceptance
      };
      runDetail = getProspectRun(
        input.store,
        input.user,
        existingMission.currentRunId
      );
    } else {
      const created = await createProspectSuperSearch({
        store: input.store,
        user: input.user,
        body: {
          ...body.superSearch!,
          strategyId: strategy.id
        },
        onRunCreated: input.onRunCreated
      });
      const detail = superSearchDetail(input.store, input.user, created.mission);
      // The launch response is consumed by the live frontend immediately. Keep
      // the mission snapshot self-contained instead of requiring a second fetch
      // before the first round can be rendered.
      superSearch = {
        ...detail.mission,
        rounds: detail.rounds,
        acceptance: detail.acceptance
      };
      runDetail = created.run;
    }
    timings.runMs = elapsedMs(stepStartedAt);
  } else {
    const existingRunEvent = input.store.prospectRunEvents.find((item) =>
      item.eventType === "created"
      && item.actorId === input.user.id
      && item.teamId === input.user.teamId
      && item.requestId === `${requestPrefix}:run`
    );
    stepStartedAt = performance.now();
    if (existingRunEvent) {
      replayed = true;
      runDetail = getProspectRun(
        input.store,
        input.user,
        existingRunEvent.runId
      );
    } else {
      runDetail = await createProspectRun({
        store: input.store,
        user: input.user,
        strategyId: strategy.id,
        ifMatch: prospectStrategyEtag(strategy),
        idempotencyKey,
        body: { reason: "自动搜客页面立即运行" },
        requestId: `${requestPrefix}:run`
      });
      const queueStartedAt = performance.now();
      await input.onRunCreated?.();
      timings.queueMs = elapsedMs(queueStartedAt);
    }
    timings.runMs = Math.max(
      0,
      elapsedMs(stepStartedAt) - timings.queueMs
    );
  }

  let schedule;
  let scheduleError = "";
  if (body.mode === "standard" && body.schedule) {
    const existingSchedule = input.store.prospectSchedules.find((item) =>
      item.strategyId === strategy.id && item.status === "active"
    );
    if (existingSchedule) {
      schedule = existingSchedule;
    } else {
      stepStartedAt = performance.now();
      try {
        schedule = (await createProspectSchedule({
          store: input.store,
          user: input.user,
          strategyId: strategy.id,
          ifMatch: prospectStrategyEtag(strategy),
          body: body.schedule
        })).schedule;
      } catch (error) {
        scheduleError = error instanceof Error
          ? error.message
          : "定期计划创建失败";
      }
      timings.scheduleMs = elapsedMs(stepStartedAt);
    }
  }

  timings.totalMs = elapsedMs(startedAt);
  return {
    ...runDetail,
    campaign: campaignDetail.campaign,
    strategy,
    ...(superSearch ? { superSearch } : {}),
    ...(schedule ? { schedule } : {}),
    ...(scheduleError ? { scheduleError } : {}),
    launchReplayed: replayed,
    launchTimings: timings
  };
}
