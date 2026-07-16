import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publicUser } from "./auth.js";
import {
  activateProspectCampaign,
  createProspectCampaign,
  prospectCampaignEtag
} from "./prospect-campaigns.js";
import { ProspectScheduler } from "./prospect-scheduler.js";
import {
  createProspectSchedule,
  deleteProspectSchedule,
  listProspectSchedules,
  nextProspectScheduleOccurrence,
  ProspectScheduleRequestError,
  prospectScheduleEtag,
  transitionProspectSchedule
} from "./prospect-schedules.js";
import {
  approveProspectStrategy,
  createProspectStrategy,
  prospectStrategyEtag,
  updateProspectStrategy
} from "./prospect-strategies.js";
import { app } from "./server.js";
import {
  getStore,
  type PersistedStoreMutation
} from "./store.js";
import { createOpenApiDocument } from "./swagger.js";
import type {
  ProspectCoverageEvent,
  ProspectSearchRun,
  ProspectStrategy,
  Role,
  TenantProspect,
  User
} from "./types.js";

function testUser(id: string, teamId: string, role: Role): User {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    password: "test-only",
    role,
    teamId,
    avatar: id.slice(0, 2).toUpperCase(),
    status: "active",
    authVersion: 1
  };
}

async function expectScheduleError(
  action: Promise<unknown>,
  status: number,
  code: string
) {
  try {
    await action;
    assert.fail(`Expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof ProspectScheduleRequestError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
  }
}

const store = getStore();
const original = {
  users: [...store.users],
  campaigns: [...store.prospectCampaigns],
  versions: [...store.prospectCampaignVersions],
  campaignEvents: [...store.prospectCampaignEvents],
  strategies: [...store.prospectStrategies],
  strategyEvents: [...store.prospectStrategyEvents],
  schedules: [...store.prospectSchedules],
  runs: [...store.prospectSearchRuns],
  shards: [...store.prospectRunShards],
  runEvents: [...store.prospectRunEvents],
  jobs: [...store.agentJobs],
  jobAliases: [...store.agentJobIdempotencyAliases],
  parentBindings: [...store.prospectRunQueueParentBindings],
  childBindings: [...store.prospectRunQueueChildBindings],
  sourcePositions: [...store.prospectStrategySourcePositions],
  tenantProspects: [...store.tenantProspects],
  coverageEvents: [...store.prospectCoverageEvents],
  persist: store.persist,
  persistMutation: store.persistMutation,
  persistProspectExecutionMutation: store.persistProspectExecutionMutation
};

const businessSnapshot = structuredClone({
  leads: store.leads,
  customers: store.customers,
  deals: store.deals,
  todos: store.todos,
  websiteOpportunities: store.websiteOpportunities
});

const owner = testUser("scheduler_owner", "scheduler_team_a", "sales");
const peer = testUser("scheduler_peer", "scheduler_team_a", "sales");
const manager = testUser("scheduler_manager", "scheduler_team_a", "manager");
const otherManager = testUser(
  "scheduler_other_manager",
  "scheduler_team_b",
  "manager"
);
const superAdmin = testUser("scheduler_super", "all", "super_admin");

store.users.push(owner, peer, manager, otherManager, superAdmin);
store.prospectCampaigns.splice(0);
store.prospectCampaignVersions.splice(0);
store.prospectCampaignEvents.splice(0);
store.prospectStrategies.splice(0);
store.prospectStrategyEvents.splice(0);
store.prospectSchedules.splice(0);
store.prospectSearchRuns.splice(0);
store.prospectRunShards.splice(0);
store.prospectRunEvents.splice(0);
store.agentJobs.splice(0);
store.agentJobIdempotencyAliases.splice(0);
store.prospectRunQueueParentBindings.splice(0);
store.prospectRunQueueChildBindings.splice(0);
store.prospectStrategySourcePositions.splice(0);
store.tenantProspects.splice(0);
store.prospectCoverageEvents.splice(0);
store.persist = async () => undefined;
store.persistMutation = undefined;
store.persistProspectExecutionMutation = undefined;

async function createReadyCampaign(input: {
  name: string;
  budgetLimit?: number | null;
  strategyCount?: number;
}) {
  const created = await createProspectCampaign({
    store,
    user: publicUser(owner),
    body: {
      name: input.name,
      snapshot: {
        goal: `Develop ${input.name}`,
        products: [`${input.name} product`],
        markets: ["Germany"],
        customerTypes: ["Importer"],
        applicationScenarios: ["Industrial project"],
        icpRules: ["Has an official company profile"],
        exclusionRules: ["Consumer only"],
        sourceProviderIds: ["gleif"]
      }
    },
    requestId: `${input.name}-create`
  });
  const strategy = store.prospectStrategies.find(
    (item) => item.campaignId === created.campaign.id
  )!;
  const budgetLimit = input.budgetLimit ?? null;
  await updateProspectStrategy({
    store,
    user: publicUser(owner),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    body: {
      providerPlan: [{
        providerId: "gleif",
        priority: 10,
        pageLimit: 2,
        resultLimit: 50,
        budgetLimit,
        currency: budgetLimit ? "USD" : ""
      }]
    },
    requestId: `${input.name}-strategy-update`
  });
  await approveProspectStrategy({
    store,
    user: publicUser(owner),
    strategyId: strategy.id,
    ifMatch: prospectStrategyEtag(strategy),
    requestId: `${input.name}-strategy-approve`
  });
  const strategies = [strategy];
  for (let index = 2; index <= (input.strategyCount || 1); index += 1) {
    const currentCampaign = store.prospectCampaigns.find((item) =>
      item.id === created.campaign.id
    )!;
    const createdStrategy = await createProspectStrategy({
      store,
      user: publicUser(owner),
      campaignId: created.campaign.id,
      ifMatch: prospectCampaignEtag(currentCampaign),
      body: {
        name: `${input.name} strategy ${index}`,
        query: {
          keywordMode: "specific",
          positiveKeywords: [`${input.name} segment ${index}`]
        },
        providerPlan: [{
          providerId: "gleif",
          priority: 10,
          pageLimit: 2,
          resultLimit: 50,
          budgetLimit,
          currency: budgetLimit ? "USD" : ""
        }]
      },
      requestId: `${input.name}-strategy-${index}-create`
    });
    const strategyItem = store.prospectStrategies.find((item) =>
      item.id === createdStrategy.strategy.id
    )!;
    await approveProspectStrategy({
      store,
      user: publicUser(owner),
      strategyId: strategyItem.id,
      ifMatch: prospectStrategyEtag(strategyItem),
      requestId: `${input.name}-strategy-${index}-approve`
    });
    strategies.push(strategyItem);
  }
  const currentCampaign = store.prospectCampaigns.find((item) =>
    item.id === created.campaign.id
  )!;
  await activateProspectCampaign({
    store,
    user: publicUser(owner),
    campaignId: created.campaign.id,
    ifMatch: prospectCampaignEtag(currentCampaign),
    requestId: `${input.name}-activate`
  });
  return { campaign: currentCampaign, strategy, strategies };
}

async function createSchedule(input: {
  strategyId: string;
  frequency: "daily" | "weekly" | "monthly";
  now: Date;
  recurringCostApproved?: boolean;
}) {
  const strategy = store.prospectStrategies.find(
    (item) => item.id === input.strategyId
  )!;
  const result = await createProspectSchedule({
    store,
    user: publicUser(owner),
    strategyId: input.strategyId,
    ifMatch: prospectStrategyEtag(strategy),
    body: {
      frequency: input.frequency,
      timezone: "UTC",
      recurringCostApproved: input.recurringCostApproved || false
    },
    now: input.now
  });
  return store.prospectSchedules.find(
    (item) => item.id === result.schedule.id
  )!;
}

function exhaustRunStrategy(
  run: ProspectSearchRun,
  strategy: ProspectStrategy
) {
  for (const provider of run.executionSnapshot.providerPlan) {
    const timeWindow = run.executionSnapshot.resolvedQuery.timeWindow;
    store.prospectStrategySourcePositions.push({
      id: `pssp_${randomUUID()}`,
      identityHash: "a".repeat(64),
      teamId: run.teamId,
      ownerId: run.ownerId,
      campaignId: run.campaignId,
      campaignVersion: run.campaignVersion,
      strategyId: strategy.id,
      providerCode: provider.providerCode,
      queryFingerprint: strategy.queryFingerprint,
      connectionId: `builtin:${provider.providerCode}`,
      endpointCode: "company-search",
      adapterVersion: provider.adapterVersion,
      contractVersion: provider.contractVersion,
      catalogVersion: provider.catalogVersion,
      timeWindowMode: timeWindow.mode,
      timeWindowFrom: timeWindow.from,
      timeWindowTo: timeWindow.to,
      status: "exhausted",
      encryptedCursor: "",
      cursorHash: "",
      sourceRunId: run.id,
      sourceShardId: "",
      sourcePageId: "",
      sourceCheckpointNo: 1,
      sourcePageSequence: 1,
      version: 1,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    });
  }
}

try {
  assert.equal(
    nextProspectScheduleOccurrence(
      "2026-01-01T10:15:00.000Z",
      "daily",
      "UTC"
    ),
    "2026-01-02T10:15:00.000Z"
  );
  assert.equal(
    nextProspectScheduleOccurrence(
      "2026-01-01T10:15:00.000Z",
      "weekly",
      "UTC"
    ),
    "2026-01-08T10:15:00.000Z"
  );
  assert.equal(
    nextProspectScheduleOccurrence(
      "2026-01-31T10:15:00.000Z",
      "monthly",
      "UTC"
    ),
    "2026-02-28T10:15:00.000Z"
  );

  const main = await createReadyCampaign({ name: "scheduler-main" });
  const mainSchedule = await createSchedule({
    strategyId: main.strategy.id,
    frequency: "daily",
    now: new Date("2026-01-01T09:00:00.000Z")
  });

  assert.equal(listProspectSchedules(store, publicUser(owner)).total, 1);
  assert.equal(listProspectSchedules(store, publicUser(peer)).total, 0);
  assert.equal(listProspectSchedules(store, publicUser(manager)).total, 1);
  assert.equal(
    listProspectSchedules(store, publicUser(otherManager)).total,
    0
  );
  assert.throws(
    () => listProspectSchedules(store, publicUser(superAdmin)),
    (error) =>
      error instanceof ProspectScheduleRequestError
      && error.status === 403
      && error.code === "SCHEDULE_ACCESS_FORBIDDEN"
  );
  await expectScheduleError(
    createProspectSchedule({
      store,
      user: publicUser(peer),
      strategyId: main.strategy.id,
      ifMatch: prospectStrategyEtag(main.strategy),
      body: {
        frequency: "daily",
        timezone: "UTC",
        recurringCostApproved: false
      }
    }),
    404,
    "STRATEGY_NOT_FOUND"
  );

  const lifecycle = await createReadyCampaign({
    name: "scheduler-lifecycle"
  });
  const lifecycleSchedule = await createSchedule({
    strategyId: lifecycle.strategy.id,
    frequency: "weekly",
    now: new Date("2026-01-01T09:00:00.000Z")
  });
  await expectScheduleError(
    transitionProspectSchedule({
      store,
      user: publicUser(manager),
      scheduleId: lifecycleSchedule.id,
      ifMatch: prospectScheduleEtag(lifecycleSchedule),
      action: "pause"
    }),
    403,
    "SCHEDULE_MUTATION_FORBIDDEN"
  );
  await expectScheduleError(
    transitionProspectSchedule({
      store,
      user: publicUser(owner),
      scheduleId: lifecycleSchedule.id,
      action: "pause"
    }),
    428,
    "IF_MATCH_REQUIRED"
  );
  const lifecycleEtag1 = prospectScheduleEtag(lifecycleSchedule);
  await transitionProspectSchedule({
    store,
    user: publicUser(owner),
    scheduleId: lifecycleSchedule.id,
    ifMatch: lifecycleEtag1,
    action: "pause",
    now: new Date("2026-01-02T09:00:00.000Z")
  });
  assert.equal(lifecycleSchedule.status, "paused");
  await expectScheduleError(
    transitionProspectSchedule({
      store,
      user: publicUser(owner),
      scheduleId: lifecycleSchedule.id,
      ifMatch: lifecycleEtag1,
      action: "resume"
    }),
    412,
    "SCHEDULE_REVISION_CONFLICT"
  );
  await transitionProspectSchedule({
    store,
    user: publicUser(owner),
    scheduleId: lifecycleSchedule.id,
    ifMatch: prospectScheduleEtag(lifecycleSchedule),
    action: "resume",
    now: new Date("2026-01-02T09:00:00.000Z")
  });
  assert.equal(lifecycleSchedule.status, "active");
  await deleteProspectSchedule({
    store,
    user: publicUser(owner),
    scheduleId: lifecycleSchedule.id,
    ifMatch: prospectScheduleEtag(lifecycleSchedule)
  });
  assert.equal(
    store.prospectSchedules.some((item) => item.id === lifecycleSchedule.id),
    false
  );

  let schedulerNow = new Date("2026-01-02T09:00:01.000Z");
  let genericMutationCalls = 0;
  let executionMutationCalls = 0;
  const applyMutation = async <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => mutation().value;
  store.persistMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => {
    genericMutationCalls += 1;
    return applyMutation(mutation);
  };
  store.persistProspectExecutionMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => {
    executionMutationCalls += 1;
    return applyMutation(mutation);
  };
  const scheduler = new ProspectScheduler({
    store,
    now: () => schedulerNow,
    pollMs: 500
  });
  const runCountBeforeMain = store.prospectSearchRuns.length;
  await scheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, runCountBeforeMain + 1);
  assert.equal(executionMutationCalls, 1);
  assert.equal(genericMutationCalls, 1);
  assert.ok(mainSchedule.lastRunId);
  assert.equal(mainSchedule.lastFailureCode, "");
  assert.ok(new Date(mainSchedule.nextRunAt).getTime() > schedulerNow.getTime());
  await scheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, runCountBeforeMain + 1);
  mainSchedule.status = "paused";

  const overdue = await createReadyCampaign({ name: "scheduler-overdue" });
  const overdueSchedule = await createSchedule({
    strategyId: overdue.strategy.id,
    frequency: "weekly",
    now: new Date("2026-01-01T09:00:00.000Z")
  });
  const overduePlannedAt = overdueSchedule.nextRunAt;
  schedulerNow = new Date("2026-02-10T09:00:00.000Z");
  const runCountBeforeOverdue = store.prospectSearchRuns.length;
  const restartedScheduler = new ProspectScheduler({
    store,
    now: () => schedulerNow,
    pollMs: 500
  });
  await restartedScheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, runCountBeforeOverdue + 1);
  assert.equal(overdueSchedule.lastPlannedAt, overduePlannedAt);
  assert.ok(
    new Date(overdueSchedule.nextRunAt).getTime() > schedulerNow.getTime()
  );
  overdueSchedule.status = "paused";

  const invalid = await createReadyCampaign({ name: "scheduler-invalid" });
  const invalidSchedule = await createSchedule({
    strategyId: invalid.strategy.id,
    frequency: "daily",
    now: new Date("2026-03-01T09:00:00.000Z")
  });
  store.prospectCampaigns.find(
    (item) => item.id === invalid.campaign.id
  )!.status = "paused";
  schedulerNow = new Date("2026-03-02T09:00:01.000Z");
  const runCountBeforeInvalid = store.prospectSearchRuns.length;
  await restartedScheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, runCountBeforeInvalid);
  assert.equal(invalidSchedule.status, "paused");
  assert.equal(
    invalidSchedule.lastFailureCode,
    "SCHEDULE_REFERENCE_CHANGED"
  );

  const paid = await createReadyCampaign({
    name: "scheduler-paid",
    budgetLimit: 10
  });
  await expectScheduleError(
    createProspectSchedule({
      store,
      user: publicUser(owner),
      strategyId: paid.strategy.id,
      ifMatch: prospectStrategyEtag(paid.strategy),
      body: {
        frequency: "monthly",
        timezone: "UTC",
        recurringCostApproved: false
      },
      now: new Date("2026-04-01T09:00:00.000Z")
    }),
    422,
    "RECURRING_COST_APPROVAL_REQUIRED"
  );
  const paidSchedule = await createSchedule({
    strategyId: paid.strategy.id,
    frequency: "monthly",
    now: new Date("2026-04-01T09:00:00.000Z"),
    recurringCostApproved: true
  });
  assert.equal(paidSchedule.recurringCostApproved, true);
  paidSchedule.status = "paused";

  const rotating = await createReadyCampaign({
    name: "scheduler-rotation",
    strategyCount: 2
  });
  const rotatingSchedule = await createSchedule({
    strategyId: rotating.strategies[0]!.id,
    frequency: "daily",
    now: new Date("2026-05-01T09:00:00.000Z")
  });
  await expectScheduleError(
    createProspectSchedule({
      store,
      user: publicUser(owner),
      strategyId: rotating.strategies[1]!.id,
      ifMatch: prospectStrategyEtag(rotating.strategies[1]!),
      body: {
        frequency: "weekly",
        timezone: "UTC",
        recurringCostApproved: false
      }
    }),
    409,
    "ACTIVE_SCHEDULE_EXISTS"
  );
  schedulerNow = new Date("2026-05-02T09:00:01.000Z");
  const rotatingScheduler = new ProspectScheduler({
    store,
    now: () => schedulerNow,
    pollMs: 500
  });
  await rotatingScheduler.runOnce();
  const firstRotatingRun = store.prospectSearchRuns.find((item) =>
    item.id === rotatingSchedule.lastRunId
  )!;
  assert.equal(firstRotatingRun.strategyId, rotating.strategies[0]!.id);
  firstRotatingRun.status = "succeeded";

  schedulerNow = new Date(
    new Date(rotatingSchedule.nextRunAt).getTime() + 1_000
  );
  await rotatingScheduler.runOnce();
  const secondRotatingRun = store.prospectSearchRuns.find((item) =>
    item.id === rotatingSchedule.lastRunId
  )!;
  assert.equal(secondRotatingRun.strategyId, rotating.strategies[1]!.id);
  secondRotatingRun.status = "succeeded";
  exhaustRunStrategy(firstRotatingRun, rotating.strategies[0]!);
  exhaustRunStrategy(secondRotatingRun, rotating.strategies[1]!);

  const beforeExhaustedRunCount = store.prospectSearchRuns.length;
  schedulerNow = new Date(
    new Date(rotatingSchedule.nextRunAt).getTime() + 1_000
  );
  await rotatingScheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, beforeExhaustedRunCount);
  assert.equal(
    rotatingSchedule.lastFailureCode,
    "SCHEDULE_ALL_STRATEGIES_EXHAUSTED"
  );
  assert.equal(rotatingSchedule.status, "active");
  rotatingSchedule.status = "paused";

  const review = await createReadyCampaign({
    name: "scheduler-review"
  });
  const reviewSchedule = await createSchedule({
    strategyId: review.strategy.id,
    frequency: "weekly",
    now: new Date("2026-06-01T09:00:00.000Z")
  });
  const reviewProspect: TenantProspect = {
    id: "tp_scheduler_review",
    teamId: owner.teamId,
    organizationId: "org_scheduler_review",
    status: "active",
    latestClassification: "duplicate",
    queueState: "none",
    queueReasonCode: "",
    firstSeenAt: "2026-05-01T08:00:00.000Z",
    lastSeenAt: "2026-05-01T08:00:00.000Z",
    lastMaterialChangeAt: "2026-05-01T08:00:00.000Z",
    lastQueuedAt: "",
    lastReviewedAt: "",
    nextReviewAt: "2026-06-01T08:00:00.000Z",
    hitCount: 1,
    sourceCount: 1,
    evidenceCount: 1,
    sourceKeyHashes: [],
    materialEvidenceKeyHashes: [],
    exclusionScope: "none",
    exclusionMode: "none",
    exclusionReasonCode: "",
    excludedUntil: "",
    leadId: "",
    customerId: "",
    dealId: "",
    version: 1,
    eventCount: 1,
    eventTailHash: "b".repeat(64),
    prospectHash: "c".repeat(64),
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-01T08:00:00.000Z"
  };
  const reviewCoverageEvent = {
    id: "pce_scheduler_review",
    prospectId: reviewProspect.id,
    teamId: owner.teamId,
    ownerId: owner.id,
    organizationId: reviewProspect.organizationId,
    resolutionId: "or_scheduler_review",
    rawRecordId: "psrr_scheduler_review",
    sourceHitId: "psrh_scheduler_review",
    campaignId: review.campaign.id,
    strategyId: review.strategy.id,
    runId: "pr_scheduler_review_origin",
    shardId: "prsh_scheduler_review_origin",
    sequence: 1,
    eventType: "coverage_classified",
    dispositionAction: "",
    classification: "duplicate",
    queueAction: "none",
    reasonCode: "NO_MATERIAL_CHANGE",
    processingKeyHash: "d".repeat(64),
    requestHash: "e".repeat(64),
    newEvidenceKeyHashes: [],
    newSourceKeyHashes: [],
    evidenceSnapshotHash: "f".repeat(64),
    sourceSnapshotHash: "1".repeat(64),
    previousEventHash: "",
    eventHash: "2".repeat(64),
    createdAt: "2026-05-01T08:00:00.000Z"
  } satisfies ProspectCoverageEvent;
  store.tenantProspects.push(reviewProspect);
  store.prospectCoverageEvents.push(reviewCoverageEvent);
  schedulerNow = new Date("2026-06-01T09:30:00.000Z");
  const reviewScheduler = new ProspectScheduler({
    store,
    now: () => schedulerNow,
    pollMs: 500
  });
  const reviewNextRunAt = reviewSchedule.nextRunAt;
  const beforeReviewRunCount = store.prospectSearchRuns.length;
  await reviewScheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, beforeReviewRunCount + 1);
  assert.equal(reviewSchedule.nextRunAt, reviewNextRunAt);
  const reviewRunId = reviewSchedule.lastRunId;
  assert.ok(store.prospectRunEvents.some((item) =>
    item.runId === reviewRunId && item.reason.includes("review:")
  ));
  await reviewScheduler.runOnce();
  assert.equal(store.prospectSearchRuns.length, beforeReviewRunCount + 1);

  const listedReviewSchedule = listProspectSchedules(
    store,
    publicUser(owner)
  ).schedules.find((item) => item.id === reviewSchedule.id);
  assert.equal(listedReviewSchedule?.orchestrationMode, "campaign_rotation_v1");
  assert.equal(listedReviewSchedule?.approvedStrategyCount, 1);
  assert.equal(listedReviewSchedule?.rotatableStrategyCount, 1);
  assert.equal(listedReviewSchedule?.dueReviewCount, 1);

  assert.deepEqual({
    leads: store.leads,
    customers: store.customers,
    deals: store.deals,
    todos: store.todos,
    websiteOpportunities: store.websiteOpportunities
  }, businessSnapshot);

  const document = createOpenApiDocument(app) as {
    paths: Record<string, Record<string, {
      parameters?: Array<{ name: string; required?: boolean }>;
    }>>;
  };
  const createScheduleDoc =
    document.paths["/api/prospect-strategies/{id}/schedules"]?.post;
  assert.ok(createScheduleDoc?.parameters?.some(
    (item) => item.name === "If-Match" && item.required
  ));

  console.log("Prospect scheduler tests passed");
} finally {
  store.users.splice(0, store.users.length, ...original.users);
  store.prospectCampaigns.splice(
    0,
    store.prospectCampaigns.length,
    ...original.campaigns
  );
  store.prospectCampaignVersions.splice(
    0,
    store.prospectCampaignVersions.length,
    ...original.versions
  );
  store.prospectCampaignEvents.splice(
    0,
    store.prospectCampaignEvents.length,
    ...original.campaignEvents
  );
  store.prospectStrategies.splice(
    0,
    store.prospectStrategies.length,
    ...original.strategies
  );
  store.prospectStrategyEvents.splice(
    0,
    store.prospectStrategyEvents.length,
    ...original.strategyEvents
  );
  store.prospectSchedules.splice(
    0,
    store.prospectSchedules.length,
    ...original.schedules
  );
  store.prospectSearchRuns.splice(
    0,
    store.prospectSearchRuns.length,
    ...original.runs
  );
  store.prospectRunShards.splice(
    0,
    store.prospectRunShards.length,
    ...original.shards
  );
  store.prospectRunEvents.splice(
    0,
    store.prospectRunEvents.length,
    ...original.runEvents
  );
  store.agentJobs.splice(0, store.agentJobs.length, ...original.jobs);
  store.agentJobIdempotencyAliases.splice(
    0,
    store.agentJobIdempotencyAliases.length,
    ...original.jobAliases
  );
  store.prospectRunQueueParentBindings.splice(
    0,
    store.prospectRunQueueParentBindings.length,
    ...original.parentBindings
  );
  store.prospectRunQueueChildBindings.splice(
    0,
    store.prospectRunQueueChildBindings.length,
    ...original.childBindings
  );
  store.prospectStrategySourcePositions.splice(
    0,
    store.prospectStrategySourcePositions.length,
    ...original.sourcePositions
  );
  store.tenantProspects.splice(
    0,
    store.tenantProspects.length,
    ...original.tenantProspects
  );
  store.prospectCoverageEvents.splice(
    0,
    store.prospectCoverageEvents.length,
    ...original.coverageEvents
  );
  store.persist = original.persist;
  store.persistMutation = original.persistMutation;
  store.persistProspectExecutionMutation =
    original.persistProspectExecutionMutation;
}
