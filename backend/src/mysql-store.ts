import mysql from "mysql2/promise";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  isProspectRunBridgeJob,
  recoverInterruptedAgentJobs
} from "./agent-jobs.js";
import { validateAgentJobSecurity } from "./agent-job-security.js";
import { hashPassword } from "./auth.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  normalizeProspectCampaignSnapshot,
  prospectCampaignSnapshotHash
} from "./prospect-campaigns.js";
import {
  ensureOrganizationIdentityTeamCache,
  ensureOrganizationIdentitySchema,
  loadOrganizationIdentityState,
  resolveOrganizationStrongIdentityMysql
} from "./organization-strong-identity-mysql.js";
import {
  ensureOrganizationIdentityConflictReviewSchema,
  ensureOrganizationIdentityConflictReviewTeamCache,
  loadOrganizationIdentityConflictReviewState,
  reviewOrganizationIdentityConflictMysql
} from "./organization-identity-conflict-review-mysql.js";
import {
  ensureOrganizationRelationSchema,
  ensureOrganizationRelationTeamCache,
  loadOrganizationRelationState,
  recordOrganizationAliasMysql,
  recordOrganizationRelationMysql
} from "./organization-relations-mysql.js";
import {
  ensureProspectCoverageSchema,
  ensureProspectCoverageTeamCache,
  convertProspectToCustomerMysql,
  convertProspectToLeadMysql,
  loadProspectCoverageState,
  recordProspectCoverageMysql,
  setTenantProspectDispositionMysql
} from "./prospect-coverage-memory-mysql.js";
import {
  applyProspectQualificationCommandMysql,
  ensureProspectQualificationSchema,
  ensureProspectQualificationTeamCache,
  loadProspectQualificationState
} from "./prospect-qualification-mysql.js";
import {
  normalizeProspectStrategyProviderPlan,
  normalizeProspectStrategyQuery,
  prospectStrategyFingerprint,
  resolveProspectStrategyQuery
} from "./prospect-strategies.js";
import {
  prospectRunExecutionSnapshotHash
} from "./prospect-runs.js";
import {
  prospectStrategySourcePositionIdentityHash
} from "./prospect-strategy-source-position.js";
import {
  ensureProspectVerificationReport
} from "./prospect-verification.js";
import {
  PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
  hasValidProspectProviderDispatchStatusFacts,
  isProspectProviderDispatchTransitionAllowed,
  isProspectProviderRequestTransitionAllowed,
  prospectProviderAccountingEvidenceHash,
  prospectProviderAccountingEvidenceRef,
  prospectProviderDispatchConfirmationRef,
  prospectProviderResponseEvidenceRef,
  prospectProviderResponseHash,
  prospectProviderSettlementHash,
  sha256CanonicalJson
} from "./prospect-provider-request-ledger.js";
import { ProspectSourceRawError } from "./prospect-source-raw.js";
import { validateAllProspectRunQueueBridges } from "./prospect-run-queue-bridge.js";
import { CustomerOwnershipError } from "./customer-public-pool.js";
import {
  createCredentialRef,
  decryptAiModelApiKey,
  encryptAiModelApiKey,
  encryptProviderConfiguration,
  isEncryptedAiModelApiKey,
  validateProviderCredentialSecurity
} from "./credential-security.js";
import { agentJobIdempotencyAliases, agentJobs, aiModelConfigs, caseStudies, commissionCalculations, commissionExports, commissionItems, commissionProducts, commissionRules, competitors, customerActivities, customerIntelligenceSuggestions, customers, dailyReportComments, dailyReports, dealEvents, deals, examAttempts, examQuestionLinks, examQuestions, exams, importExportJobs, internalMessages, knowledgeAssets, leadActivities, leadSourceConfigs, leadSourceEvents, leads, marketOpportunityBatches, marketOpportunityCalculationEvents, marketOpportunitySnapshots, marketTradeObservations, memos, monthlySalesRecords, ocrJobs, planTasks, planTemplates, problems, prospectCampaignEvents, prospectCampaigns, prospectCampaignVersions, prospectRunQueueChildBindings, prospectRunQueueParentBindings, prospectTouchpoints, providerCatalog as defaultProviderCatalog, providerConnections, providerRequestLogs, providerResponseCache, reminders, salesRecordAudits, todos, tradeDocuments, users, wecomMessages, websiteOpportunities, whatsappBindings, whatsappMessages } from "./data.js";
import type { CrmStore, PersistedStoreMutation } from "./store.js";
import type { WhatsAppBinding, WhatsAppMessage } from "./types.js";
import type { DailyReport, DailyReportComment, InternalMessage } from "./types.js";
import type { AcquisitionOutcomeFeedback, AgentJob, AgentJobIdempotencyAlias, AiModelConfig, CaseStudy, CommissionCalculation, CommissionExport, CommissionItem, CommissionProduct, CommissionRule, Competitor, Customer, CustomerAcquisitionSourceEvent, CustomerActivity, CustomerIntelligenceSuggestion, CustomerOwnershipEvent, CustomerOwnershipMutationInput, CustomerOwnershipMutationResult, Deal, DealEvent, DealRecommendation, Exam, ExamAttempt, ExamQuestion, ExamQuestionLink, ImportExportJob, KnowledgeAsset, Lead, LeadActivity, LeadSourceConfig, LeadSourceEvent, MarketOpportunityBatch, MarketOpportunityCalculationEvent, MarketOpportunitySnapshot, MarketTradeObservation, Memo, MonthlySalesRecord, OcrJob, PlanTask, PlanTemplate, ProblemItem, ProcurementSignal, ProspectCampaign, ProspectCampaignEvent, ProspectCampaignVersion, ProspectCandidateProcessingState, ProspectExecutionAttempt, ProspectExecutionCheckpoint, ProspectExecutionEvent, ProspectExecutionKernelState, ProspectExecutionLease, ProspectExecutionPage, ProspectExecutionThrottleBucket, ProspectProviderRequestAccountingEvidence, ProspectProviderRequestAttemptBinding, ProspectProviderRequestDispatch, ProspectProviderRequestEvent, ProspectProviderRequestLedger, ProspectRunEvent, ProspectRunQueueChildBinding, ProspectRunQueueParentBinding, ProspectRunShard, ProspectSchedule, ProspectSearchRun, ProspectSourceRawBatch, ProspectSourceRawHit, ProspectSourceRawRecord, ProspectStrategy, ProspectStrategyEvent, ProspectStrategySourcePosition, ProspectStrategySuggestion, ProspectTouchpoint, ProviderCatalogItem, ProviderConnection, ProviderRequestLog, ProviderResponseCache, Reminder, SalesRecordAudit, Todo, TradeDocument, User, WecomMessage, WebsiteOpportunity } from "./types.js";

const defaultUrl = "mysql://goodjob:change_me@127.0.0.1:3306/goodjob_crm";

export type MysqlStoreProcessRole = "api" | "worker";

async function acquireProductionInstanceLock(
  pool: mysql.Pool,
  processRole: MysqlStoreProcessRole
) {
  const connection = await pool.getConnection();
  const lockName = `goodjob_crm_backend_${processRole}_single_instance`;
  const [rows] = await connection.query(
    "SELECT GET_LOCK(?, 0) AS acquired, CONNECTION_ID() AS connection_id",
    [lockName]
  );
  const result = (rows as Array<{ acquired: number; connection_id: number }>)[0];
  if (Number(result?.acquired || 0) !== 1) {
    connection.release();
    throw new Error(
      `同一数据库已有 GoodJob CRM ${processRole} 实例运行，拒绝重复启动`
    );
  }
  const ownerConnectionId = Number(result.connection_id);
  const timer = setInterval(async () => {
    try {
      const [checkRows] = await connection.query(
        "SELECT IS_USED_LOCK(?) AS owner_id, CONNECTION_ID() AS connection_id",
        [lockName]
      );
      const check = (checkRows as Array<{
        owner_id: number | null;
        connection_id: number;
      }>)[0];
      if (Number(check?.owner_id) !== ownerConnectionId
        || Number(check?.connection_id) !== ownerConnectionId) {
        console.error("GoodJob CRM 单实例数据库锁已丢失，进程即将退出");
        process.exit(1);
      }
    } catch {
      console.error("GoodJob CRM 无法验证单实例数据库锁，进程即将退出");
      process.exit(1);
    }
  }, 15000);
  timer.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      await connection.query(
        "SELECT RELEASE_LOCK(?) AS released",
        [lockName]
      );
    } finally {
      connection.release();
    }
  };
}

export function createSerializedPersistence<T>(
  snapshot: () => T,
  operation: (value: T) => Promise<void>
) {
  const enqueue = createSerializedTaskQueue();
  return () => enqueue(() => operation(snapshot()));
}

export function createSerializedTaskQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>) => {
    const current = tail.then(operation);
    tail = current.catch(() => undefined);
    return current;
  };
}

function persistenceSnapshot(store: CrmStore): CrmStore {
  const snapshot = Object.fromEntries(
    Object.entries(store).map(([key, value]) => [
      key,
      Array.isArray(value) ? structuredClone(value) : value
    ])
  ) as unknown as CrmStore;
  snapshot.persist = async () => undefined;
  return snapshot;
}

type LoadedProspectRunState =
  Awaited<ReturnType<typeof loadProspectRunState>>;
type LoadedProspectExecutionState =
  Awaited<ReturnType<typeof loadProspectExecutionState>>;

function replaceProspectExecutionCache(
  store: CrmStore,
  loaded: {
    runState: LoadedProspectRunState;
    jobs: AgentJob[];
    jobAliases: AgentJobIdempotencyAlias[];
    executionState: LoadedProspectExecutionState;
  }
) {
  const candidate = persistenceSnapshot(store);
  candidate.prospectSearchRuns = loaded.runState.runs;
  candidate.prospectRunShards = loaded.runState.shards;
  candidate.prospectRunEvents = loaded.runState.events;
  candidate.agentJobs = loaded.jobs;
  candidate.agentJobIdempotencyAliases = loaded.jobAliases;
  candidate.prospectRunQueueParentBindings =
    loaded.runState.parentBindings;
  candidate.prospectRunQueueChildBindings =
    loaded.runState.childBindings;
  candidate.prospectExecutionKernelStates =
    loaded.executionState.kernelStates;
  candidate.prospectExecutionCheckpoints =
    loaded.executionState.checkpoints;
  candidate.prospectStrategySourcePositions =
    loaded.executionState.sourcePositions;
  candidate.prospectExecutionLeases =
    loaded.executionState.leases;
  candidate.prospectExecutionAttempts =
    loaded.executionState.attempts;
  candidate.prospectProviderRequestLedgers =
    loaded.executionState.providerRequestLedgers;
  candidate.prospectProviderRequestDispatches =
    loaded.executionState.providerRequestDispatches;
  candidate.prospectProviderRequestAttemptBindings =
    loaded.executionState.providerRequestAttemptBindings;
  candidate.prospectProviderRequestEvents =
    loaded.executionState.providerRequestEvents;
  candidate.prospectProviderRequestAccountingEvidence =
    loaded.executionState.providerRequestAccountingEvidence;
  candidate.prospectSourceRawBatches =
    loaded.executionState.sourceRawBatches;
  candidate.prospectSourceRawRecords =
    loaded.executionState.sourceRawRecords;
  candidate.prospectSourceRawHits =
    loaded.executionState.sourceRawHits;
  candidate.prospectExecutionPages =
    loaded.executionState.pages;
  candidate.prospectExecutionEvents =
    loaded.executionState.events;
  candidate.prospectExecutionThrottleBuckets =
    loaded.executionState.throttleBuckets;
  validateProspectRunPersistence(candidate);

  store.prospectSearchRuns.splice(
    0,
    store.prospectSearchRuns.length,
    ...loaded.runState.runs
  );
  store.prospectRunShards.splice(
    0,
    store.prospectRunShards.length,
    ...loaded.runState.shards
  );
  store.prospectRunEvents.splice(
    0,
    store.prospectRunEvents.length,
    ...loaded.runState.events
  );
  store.agentJobs.splice(0, store.agentJobs.length, ...loaded.jobs);
  store.agentJobIdempotencyAliases.splice(
    0,
    store.agentJobIdempotencyAliases.length,
    ...loaded.jobAliases
  );
  store.prospectRunQueueParentBindings.splice(
    0,
    store.prospectRunQueueParentBindings.length,
    ...loaded.runState.parentBindings
  );
  store.prospectRunQueueChildBindings.splice(
    0,
    store.prospectRunQueueChildBindings.length,
    ...loaded.runState.childBindings
  );
  store.prospectExecutionKernelStates.splice(
    0,
    store.prospectExecutionKernelStates.length,
    ...loaded.executionState.kernelStates
  );
  store.prospectExecutionCheckpoints.splice(
    0,
    store.prospectExecutionCheckpoints.length,
    ...loaded.executionState.checkpoints
  );
  store.prospectStrategySourcePositions.splice(
    0,
    store.prospectStrategySourcePositions.length,
    ...loaded.executionState.sourcePositions
  );
  store.prospectExecutionLeases.splice(
    0,
    store.prospectExecutionLeases.length,
    ...loaded.executionState.leases
  );
  store.prospectExecutionAttempts.splice(
    0,
    store.prospectExecutionAttempts.length,
    ...loaded.executionState.attempts
  );
  store.prospectProviderRequestLedgers.splice(
    0,
    store.prospectProviderRequestLedgers.length,
    ...loaded.executionState.providerRequestLedgers
  );
  store.prospectProviderRequestDispatches.splice(
    0,
    store.prospectProviderRequestDispatches.length,
    ...loaded.executionState.providerRequestDispatches
  );
  store.prospectProviderRequestAttemptBindings.splice(
    0,
    store.prospectProviderRequestAttemptBindings.length,
    ...loaded.executionState.providerRequestAttemptBindings
  );
  store.prospectProviderRequestEvents.splice(
    0,
    store.prospectProviderRequestEvents.length,
    ...loaded.executionState.providerRequestEvents
  );
  store.prospectProviderRequestAccountingEvidence.splice(
    0,
    store.prospectProviderRequestAccountingEvidence.length,
    ...loaded.executionState.providerRequestAccountingEvidence
  );
  store.prospectSourceRawBatches.splice(
    0,
    store.prospectSourceRawBatches.length,
    ...loaded.executionState.sourceRawBatches
  );
  store.prospectSourceRawRecords.splice(
    0,
    store.prospectSourceRawRecords.length,
    ...loaded.executionState.sourceRawRecords
  );
  store.prospectSourceRawHits.splice(
    0,
    store.prospectSourceRawHits.length,
    ...loaded.executionState.sourceRawHits
  );
  store.prospectExecutionPages.splice(
    0,
    store.prospectExecutionPages.length,
    ...loaded.executionState.pages
  );
  store.prospectExecutionEvents.splice(
    0,
    store.prospectExecutionEvents.length,
    ...loaded.executionState.events
  );
  store.prospectExecutionThrottleBuckets.splice(
    0,
    store.prospectExecutionThrottleBuckets.length,
    ...loaded.executionState.throttleBuckets
  );
}

async function persistProspectExecutionState(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  validateProspectRunPersistence(store);
  await syncProspectSearchRunRows(
    connection,
    store.prospectSearchRuns
  );
  await syncProspectRunShardRows(connection, store.prospectRunShards);
  await appendProspectRunEventRows(connection, store.prospectRunEvents);
  await syncAgentJobRows(
    connection,
    store.agentJobs,
    isProspectRunBridgeJob
  );
  await syncAgentJobIdempotencyAliasRows(
    connection,
    store.agentJobIdempotencyAliases,
    isProspectRunBridgeJob
  );
  await appendProspectRunQueueBindingRows(connection, store);
  await syncProspectExecutionKernelState(
    connection,
    store.prospectExecutionKernelStates
  );
  await syncProspectExecutionCheckpoints(
    connection,
    store.prospectExecutionCheckpoints
  );
  await syncProspectExecutionLeases(
    connection,
    store.prospectExecutionLeases
  );
  await syncProspectExecutionAttempts(
    connection,
    store.prospectExecutionAttempts
  );
  await syncProspectProviderRequestLedgers(
    connection,
    store.prospectProviderRequestLedgers
  );
  await syncProspectProviderRequestDispatches(
    connection,
    store.prospectProviderRequestDispatches
  );
  await appendProspectProviderRequestFacts(connection, store);
  await appendProspectExecutionPagesAndEvents(connection, store);
  await appendProspectSourceRawRows(connection, store);
  await syncProspectStrategySourcePositions(
    connection,
    store.prospectStrategySourcePositions
  );
  await syncProspectExecutionThrottles(
    connection,
    store.prospectExecutionThrottleBuckets
  );
  await appendProviderRequestLogRows(
    connection,
    store.providerRequestLogs
  );
}

export async function createMysqlStore(
  options: { processRole?: MysqlStoreProcessRole } = {}
): Promise<CrmStore> {
  validateAgentJobSecurity();
  validateProviderCredentialSecurity();
  const configuredUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (process.env.NODE_ENV === "production" && !configuredUrl) {
    throw new Error("生产环境必须配置 DATABASE_URL 或 MYSQL_URL");
  }
  const databaseUrl = configuredUrl || defaultUrl;
  const processRole = options.processRole || "api";
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4, namedPlaceholders: true });
  const prospectExecutionLockName = `goodjob_prospect_exec_${createHash(
    "sha256"
  ).update(databaseUrl).digest("hex").slice(0, 24)}`;
  const prospectCandidateLockName = `goodjob_prospect_candidate_${createHash(
    "sha256"
  ).update(databaseUrl).digest("hex").slice(0, 24)}`;
  const configuredProspectExecutionLockTimeoutMs = Number(
    process.env.PROSPECT_EXECUTION_DB_LOCK_TIMEOUT_MS || 5_000
  );
  const prospectExecutionLockTimeoutSeconds = Math.max(
    1,
    Math.ceil((
      Number.isFinite(configuredProspectExecutionLockTimeoutMs)
      && configuredProspectExecutionLockTimeoutMs > 0
        ? configuredProspectExecutionLockTimeoutMs
        : 5_000
    ) / 1_000)
  );
  const configuredProspectCandidateLockTimeoutMs = Number(
    process.env.PROSPECT_CANDIDATE_DB_LOCK_TIMEOUT_MS || 5_000
  );
  const prospectCandidateLockTimeoutSeconds = Math.max(
    1,
    Math.ceil((
      Number.isFinite(configuredProspectCandidateLockTimeoutMs)
      && configuredProspectCandidateLockTimeoutMs > 0
        ? configuredProspectCandidateLockTimeoutMs
        : 5_000
    ) / 1_000)
  );
  const releaseProductionInstanceLock =
    process.env.NODE_ENV === "production"
      ? await acquireProductionInstanceLock(pool, processRole)
      : null;
  await ensureSchema(pool);
  await ensureOrganizationIdentitySchema(pool);
  await ensureOrganizationIdentityConflictReviewSchema(pool);
  await ensureOrganizationRelationSchema(pool);
  await ensureProspectCoverageSchema(pool);
  await ensureProspectQualificationSchema(pool);

  let store!: CrmStore;
  const enqueuePersistence = createSerializedTaskQueue();
  const persist = () => enqueuePersistence(
    () => persistAll(pool, persistenceSnapshot(store))
  );
  const persistMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => enqueuePersistence(async () => {
    const applied = mutation();
    try {
      await persistAll(pool, persistenceSnapshot(store));
      return applied.value;
    } catch (error) {
      applied.rollback();
      throw error;
    }
  });
  const mutateCustomerOwnership = (
    input: CustomerOwnershipMutationInput
  ): Promise<CustomerOwnershipMutationResult> => enqueuePersistence(async () => {
    const connection = await pool.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      const [customerRows] = await connection.query(
        "SELECT * FROM customers WHERE id = ? FOR UPDATE",
        [input.customerId]
      );
      const customerRow = (customerRows as Array<Record<string, any>>)[0];
      if (!customerRow) {
        throw new CustomerOwnershipError(
          "CUSTOMER_NOT_FOUND",
          "客户不存在",
          404
        );
      }
      const customer = customerFromRow(customerRow);
      const currentVersion = customer.ownershipVersion || 0;
      if (typeof input.expectedVersion === "number"
        && input.expectedVersion !== currentVersion) {
        throw new CustomerOwnershipError(
          "CUSTOMER_POOL_VERSION_CONFLICT",
          "客户归属状态已变化，请刷新后重试",
          409
        );
      }

      const occurredAt = new Date(input.occurredAt).toISOString();
      const reason = input.action === "release"
        ? String(input.reason || "").trim()
        : "从团队公池领取";
      const formerOwnerId = input.action === "release"
        ? customer.ownerId
        : customer.previousOwnerId || "";
      const event: CustomerOwnershipEvent = {
        id: `coe_${randomUUID()}`,
        customerId: customer.id,
        teamId: customer.teamId,
        fromOwnerId: formerOwnerId,
        toOwnerId: input.action === "claim" ? input.actorId : "",
        action: input.action === "release" ? "released" : "claimed",
        reason,
        operatorId: input.actorId,
        createdAt: occurredAt
      };
      let cancelledTodoIds: string[] = [];

      if (input.action === "release") {
        if (customer.poolStatus === "public") {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_ALREADY_PUBLIC",
            "该客户已在团队公池中",
            409
          );
        }
        const canRelease = input.actorRole === "sales"
          ? customer.ownerId === input.actorId
            && customer.teamId === input.actorTeamId
          : (input.actorRole === "manager" || input.actorRole === "admin")
            && customer.teamId === input.actorTeamId;
        if (!canRelease) {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_FORBIDDEN",
            "只能释放本人或本团队负责的客户",
            403
          );
        }
        if (!reason) {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_FORBIDDEN",
            "请填写释放原因",
            400
          );
        }
        const [activeDealRows] = await connection.query(
          `SELECT COUNT(*) AS count
           FROM deals
           WHERE customer_id = ?
             AND archived_at IS NULL
             AND stage NOT IN ('成交', '丢单')`,
          [customer.id]
        );
        if (Number(
          (activeDealRows as Array<{ count: number }>)[0]?.count || 0
        ) > 0) {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_ACTIVE_DEAL",
            "该客户仍有活跃商机，请先完成、关闭或移交商机后再释放",
            409
          );
        }
        const [todoRows] = await connection.query(
          `SELECT id
           FROM todos
           WHERE customer_id = ?
             AND done = FALSE
             AND cancelled_at IS NULL
           FOR UPDATE`,
          [customer.id]
        );
        cancelledTodoIds = (todoRows as Array<{ id: string }>)
          .map((row) => row.id);
        const [updateResult] = await connection.query(
          `UPDATE customers
           SET owner_id = '',
               pool_status = 'public',
               previous_owner_id = ?,
               released_by = ?,
               released_at = ?,
               release_reason = ?,
               claimed_at = NULL,
               ownership_version = ownership_version + 1
           WHERE id = ?
             AND pool_status <> 'public'
             AND ownership_version = ?`,
          [
            formerOwnerId,
            input.actorId,
            mysqlDate(occurredAt),
            reason,
            customer.id,
            currentVersion
          ]
        );
        if (Number((updateResult as mysql.ResultSetHeader).affectedRows) !== 1) {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_VERSION_CONFLICT",
            "客户归属状态已变化，请刷新后重试",
            409
          );
        }
        if (cancelledTodoIds.length) {
          await connection.query(
            `UPDATE todos
             SET done = TRUE,
                 status = 'pending',
                 history_at = ?,
                 cancelled_at = ?,
                 cancellation_reason = ?
             WHERE customer_id = ?
               AND done = FALSE
               AND cancelled_at IS NULL`,
            [
              mysqlDate(occurredAt),
              mysqlDate(occurredAt),
              `客户已释放到团队公池：${reason}`,
              customer.id
            ]
          );
        }
      } else {
        if (customer.teamId !== input.actorTeamId
          || !["sales", "manager", "admin"].includes(input.actorRole)) {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_FORBIDDEN",
            "不能领取其他团队的公池客户",
            403
          );
        }
        if (customer.poolStatus !== "public") {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_ALREADY_CLAIMED",
            "该客户已被其他同事领取",
            409
          );
        }
        const [updateResult] = await connection.query(
          `UPDATE customers
           SET owner_id = ?,
               pool_status = 'owned',
               claimed_at = ?,
               ownership_version = ownership_version + 1
           WHERE id = ?
             AND team_id = ?
             AND pool_status = 'public'
             AND ownership_version = ?`,
          [
            input.actorId,
            mysqlDate(occurredAt),
            customer.id,
            input.actorTeamId,
            currentVersion
          ]
        );
        if (Number((updateResult as mysql.ResultSetHeader).affectedRows) !== 1) {
          throw new CustomerOwnershipError(
            "CUSTOMER_POOL_ALREADY_CLAIMED",
            "该客户已被其他同事领取",
            409
          );
        }
      }

      await connection.query(
        `INSERT INTO customer_ownership_events
          (id, customer_id, team_id, from_owner_id, to_owner_id,
           event_type, reason, operator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          event.customerId,
          event.teamId,
          event.fromOwnerId,
          event.toOwnerId,
          event.action,
          event.reason,
          event.operatorId,
          mysqlDate(event.createdAt)
        ]
      );
      const [updatedRows] = await connection.query(
        "SELECT * FROM customers WHERE id = ?",
        [customer.id]
      );
      const updatedCustomer = customerFromRow(
        (updatedRows as Array<Record<string, any>>)[0]
      );
      await connection.commit();
      committed = true;

      const customerIndex = store.customers.findIndex(
        (item) => item.id === updatedCustomer.id
      );
      if (customerIndex >= 0) store.customers[customerIndex] = updatedCustomer;
      else store.customers.unshift(updatedCustomer);
      store.customerOwnershipEvents.unshift(event);
      if (cancelledTodoIds.length) {
        const cancelledTodoIdSet = new Set(cancelledTodoIds);
        for (const todo of store.todos) {
          if (!cancelledTodoIdSet.has(todo.id)) continue;
          todo.done = true;
          todo.status = "pending";
          todo.historyAt = occurredAt;
          todo.cancelledAt = occurredAt;
          todo.cancellationReason = `客户已释放到团队公池：${reason}`;
        }
      }
      return {
        customer: structuredClone(updatedCustomer),
        event: structuredClone(event),
        cancelledTodoIds
      };
    } catch (error) {
      if (!committed) await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
  const persistProspectExecutionMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => enqueuePersistence(async () => {
    const connection = await pool.getConnection();
    let lockAcquired = false;
    let transactionStarted = false;
    let applied: PersistedStoreMutation<T> | undefined;
    try {
      const [lockRows] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [
          prospectExecutionLockName,
          prospectExecutionLockTimeoutSeconds
        ]
      );
      lockAcquired = Number(
        (lockRows as Array<{ acquired: number | null }>)[0]?.acquired
        || 0
      ) === 1;
      if (!lockAcquired) {
        throw new Error("搜索执行数据库事务锁获取超时");
      }
      await connection.beginTransaction();
      transactionStarted = true;
      replaceProspectExecutionCache(store, {
        runState: await loadProspectRunState(connection),
        jobs: await loadAgentJobs(connection),
        jobAliases: await loadAgentJobIdempotencyAliases(connection),
        executionState: await loadProspectExecutionState(connection)
      });
      applied = mutation();
      await persistProspectExecutionState(connection, store);
      await connection.commit();
      transactionStarted = false;
      return applied.value;
    } catch (error) {
      if (transactionStarted) await connection.rollback();
      applied?.rollback();
      throw error;
    } finally {
      if (lockAcquired) {
        try {
          await connection.query(
            "SELECT RELEASE_LOCK(?) AS released",
            [prospectExecutionLockName]
          );
        } catch {
          // Releasing the connection also releases its advisory lock.
        }
      }
      connection.release();
    }
  });
  const persistProspectCandidateMutation = <T>(
    mutation: () => PersistedStoreMutation<T>
  ) => enqueuePersistence(async () => {
    const connection = await pool.getConnection();
    let lockAcquired = false;
    let transactionStarted = false;
    let applied: PersistedStoreMutation<T> | undefined;
    try {
      const [lockRows] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [
          prospectCandidateLockName,
          prospectCandidateLockTimeoutSeconds
        ]
      );
      lockAcquired = Number(
        (lockRows as Array<{ acquired: number | null }>)[0]?.acquired
        || 0
      ) === 1;
      if (!lockAcquired) {
        throw new Error("候选客户数据库事务锁获取超时");
      }
      await connection.beginTransaction();
      transactionStarted = true;
      const authoritative = await loadWebsiteOpportunities(connection);
      const authoritativeProcessing =
        await loadProspectCandidateProcessingStates(connection);
      store.websiteOpportunities.splice(
        0,
        store.websiteOpportunities.length,
        ...authoritative
      );
      const processingStates =
        store.prospectCandidateProcessingStates ||= [];
      processingStates.splice(
        0,
        processingStates.length,
        ...authoritativeProcessing
      );
      applied = mutation();
      await persistWebsiteOpportunityRows(
        connection,
        store.websiteOpportunities
      );
      await persistProspectCandidateProcessingStates(
        connection,
        processingStates
      );
      await connection.commit();
      transactionStarted = false;
      return applied.value;
    } catch (error) {
      if (transactionStarted) await connection.rollback();
      applied?.rollback();
      throw error;
    } finally {
      if (lockAcquired) {
        try {
          await connection.query(
            "SELECT RELEASE_LOCK(?) AS released",
            [prospectCandidateLockName]
          );
        } catch {
          // Releasing the connection also releases its advisory lock.
        }
      }
      connection.release();
    }
  });
  const persistProspectCandidates = (
    candidateIds: string[]
  ) => {
    const ids = new Set(candidateIds);
    const desired = structuredClone(
      store.websiteOpportunities.filter((item) => ids.has(item.id))
    );
    return enqueuePersistence(async () => {
      const connection = await pool.getConnection();
      let lockAcquired = false;
      let transactionStarted = false;
      try {
        const [lockRows] = await connection.query(
          "SELECT GET_LOCK(?, ?) AS acquired",
          [
            prospectCandidateLockName,
            prospectCandidateLockTimeoutSeconds
          ]
        );
        lockAcquired = Number(
          (lockRows as Array<{ acquired: number | null }>)[0]?.acquired
          || 0
        ) === 1;
        if (!lockAcquired) {
          throw new Error("候选客户数据库事务锁获取超时");
        }
        await connection.beginTransaction();
        transactionStarted = true;
        const authoritative = await loadWebsiteOpportunities(connection);
        for (const candidate of desired) {
          const index = authoritative.findIndex(
            (item) => item.id === candidate.id
          );
          if (index >= 0) authoritative[index] = candidate;
          else authoritative.unshift(candidate);
        }
        await persistWebsiteOpportunityRows(connection, authoritative);
        await connection.commit();
        transactionStarted = false;
        store.websiteOpportunities.splice(
          0,
          store.websiteOpportunities.length,
          ...authoritative
        );
      } catch (error) {
        if (transactionStarted) await connection.rollback();
        const authoritative = await loadWebsiteOpportunities(connection);
        store.websiteOpportunities.splice(
          0,
          store.websiteOpportunities.length,
          ...authoritative
        );
        throw error;
      } finally {
        if (lockAcquired) {
          try {
            await connection.query(
              "SELECT RELEASE_LOCK(?) AS released",
              [prospectCandidateLockName]
            );
          } catch {
            // Releasing the connection also releases its advisory lock.
          }
        }
        connection.release();
      }
    });
  };
  const reloadProspectCandidates = () => enqueuePersistence(async () => {
    const [candidates, processingStates] = await Promise.all([
      loadWebsiteOpportunities(pool),
      loadProspectCandidateProcessingStates(pool)
    ]);
    store.websiteOpportunities.splice(
      0,
      store.websiteOpportunities.length,
      ...candidates
    );
    const currentProcessingStates =
      store.prospectCandidateProcessingStates ||= [];
    currentProcessingStates.splice(
      0,
      currentProcessingStates.length,
      ...processingStates
    );
  });
  let reloadProspectRuns!: () => Promise<void>;
  const readBarrier = () => reloadProspectRuns();
  let closed = false;
  const close = () => enqueuePersistence(async () => {
    if (closed) return;
    closed = true;
    await releaseProductionInstanceLock?.();
    await pool.end();
  });
  const loadedProspectRunState = await loadProspectRunState(pool);
  const loadedProspectExecutionState = await loadProspectExecutionState(pool);
  const loadedOrganizationIdentityState =
    await loadOrganizationIdentityState(
      pool,
      loadedProspectExecutionState.sourceRawRecords
    );
  const loadedOrganizationIdentityConflictReviewState =
    await loadOrganizationIdentityConflictReviewState(pool);
  const loadedOrganizationRelationState =
    await loadOrganizationRelationState(pool);
  const loadedProspectCoverageState =
    await loadProspectCoverageState(pool);
  const loadedProspectQualificationState =
    await loadProspectQualificationState(pool);
  const resolveOrganizationStrongIdentity = (input: Parameters<
    typeof resolveOrganizationStrongIdentityMysql
  >[2]) => resolveOrganizationStrongIdentityMysql(pool, store, input);
  const reloadOrganizationIdentityTeam = (teamId: string) =>
    enqueuePersistence(async () => {
      await ensureOrganizationIdentityTeamCache(pool, store, teamId);
    });
  const reviewOrganizationIdentityConflict = (input: Parameters<
    typeof reviewOrganizationIdentityConflictMysql
  >[2]) => enqueuePersistence(async () => {
    await ensureOrganizationIdentityTeamCache(
      pool,
      store,
      input.user.teamId
    );
    await ensureOrganizationIdentityConflictReviewTeamCache(
      pool,
      store,
      input.user.teamId
    );
    return reviewOrganizationIdentityConflictMysql(pool, store, input);
  });
  const reloadOrganizationIdentityConflictReviewTeam = (teamId: string) =>
    enqueuePersistence(async () => {
      await ensureOrganizationIdentityConflictReviewTeamCache(
        pool,
        store,
        teamId
      );
    });
  const recordOrganizationAlias = (input: Parameters<
    typeof recordOrganizationAliasMysql
  >[2]) => enqueuePersistence(async () => {
    await ensureOrganizationIdentityTeamCache(pool, store, input.user.teamId);
    await ensureOrganizationIdentityConflictReviewTeamCache(
      pool,
      store,
      input.user.teamId
    );
    await ensureOrganizationRelationTeamCache(
      pool,
      store,
      input.user.teamId
    );
    return recordOrganizationAliasMysql(pool, store, input);
  });
  const recordOrganizationRelation = (input: Parameters<
    typeof recordOrganizationRelationMysql
  >[2]) => enqueuePersistence(async () => {
    await ensureOrganizationIdentityTeamCache(pool, store, input.user.teamId);
    await ensureOrganizationIdentityConflictReviewTeamCache(
      pool,
      store,
      input.user.teamId
    );
    await ensureOrganizationRelationTeamCache(
      pool,
      store,
      input.user.teamId
    );
    return recordOrganizationRelationMysql(pool, store, input);
  });
  const reloadOrganizationRelationsTeam = (teamId: string) =>
    enqueuePersistence(async () => {
      await ensureOrganizationRelationTeamCache(pool, store, teamId);
    });
  const recordProspectCoverage = (input: Parameters<
    typeof recordProspectCoverageMysql
  >[2]) => recordProspectCoverageMysql(pool, store, input);
  const setTenantProspectDisposition = (input: Parameters<
    typeof setTenantProspectDispositionMysql
  >[2]) => setTenantProspectDispositionMysql(pool, store, input);
  const convertProspectToLead = (input: Parameters<
    typeof convertProspectToLeadMysql
  >[2]) => enqueuePersistence(
    () => convertProspectToLeadMysql(pool, store, input)
  );
  const convertProspectToCustomer = (input: Parameters<
    typeof convertProspectToCustomerMysql
  >[2]) => enqueuePersistence(
    () => convertProspectToCustomerMysql(pool, store, input)
  );
  const reloadProspectCoverageTeam = (teamId: string) =>
    enqueuePersistence(async () => {
      await ensureProspectCoverageTeamCache(pool, store, teamId);
    });
  const applyProspectQualification = (input: Parameters<
    typeof applyProspectQualificationCommandMysql
  >[2]) => applyProspectQualificationCommandMysql(pool, store, input);
  const reloadProspectQualificationTeam = (teamId: string) =>
    enqueuePersistence(async () => {
      await ensureProspectQualificationTeamCache(pool, store, teamId);
    });
  reloadProspectRuns = () => enqueuePersistence(async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const loaded = await loadProspectRunState(connection);
      const loadedJobs = await loadAgentJobs(connection);
      const loadedJobAliases = await loadAgentJobIdempotencyAliases(connection);
      const loadedExecution = await loadProspectExecutionState(connection);
      const loadedAiModelConfigs = await loadAiModelConfigs(connection);
      const loadedProviderCatalog = await loadProviderCatalog(connection);
      const loadedProviderConnections =
        await loadProviderConnections(connection);
      const candidate = persistenceSnapshot(store);
      candidate.prospectSearchRuns = loaded.runs;
      candidate.prospectRunShards = loaded.shards;
      candidate.prospectRunEvents = loaded.events;
      candidate.agentJobs = loadedJobs;
      candidate.agentJobIdempotencyAliases = loadedJobAliases;
      candidate.prospectRunQueueParentBindings = loaded.parentBindings;
      candidate.prospectRunQueueChildBindings = loaded.childBindings;
      candidate.prospectExecutionKernelStates =
        loadedExecution.kernelStates;
      candidate.prospectExecutionCheckpoints =
        loadedExecution.checkpoints;
      candidate.prospectStrategySourcePositions =
        loadedExecution.sourcePositions;
      candidate.prospectExecutionLeases = loadedExecution.leases;
      candidate.prospectExecutionAttempts = loadedExecution.attempts;
      candidate.prospectProviderRequestLedgers =
        loadedExecution.providerRequestLedgers;
      candidate.prospectProviderRequestDispatches =
        loadedExecution.providerRequestDispatches;
      candidate.prospectProviderRequestAttemptBindings =
        loadedExecution.providerRequestAttemptBindings;
      candidate.prospectProviderRequestEvents =
        loadedExecution.providerRequestEvents;
      candidate.prospectProviderRequestAccountingEvidence =
        loadedExecution.providerRequestAccountingEvidence;
      candidate.prospectSourceRawBatches =
        loadedExecution.sourceRawBatches;
      candidate.prospectSourceRawRecords =
        loadedExecution.sourceRawRecords;
      candidate.prospectSourceRawHits = loadedExecution.sourceRawHits;
      candidate.prospectExecutionPages = loadedExecution.pages;
      candidate.prospectExecutionEvents = loadedExecution.events;
      candidate.prospectExecutionThrottleBuckets =
        loadedExecution.throttleBuckets;
      validateProspectRunPersistence(candidate);
      await connection.commit();
      store.prospectSearchRuns.splice(
        0,
        store.prospectSearchRuns.length,
        ...loaded.runs
      );
      store.prospectRunShards.splice(
        0,
        store.prospectRunShards.length,
        ...loaded.shards
      );
      store.prospectRunEvents.splice(
        0,
        store.prospectRunEvents.length,
        ...loaded.events
      );
      store.agentJobs.splice(0, store.agentJobs.length, ...loadedJobs);
      store.agentJobIdempotencyAliases.splice(
        0,
        store.agentJobIdempotencyAliases.length,
        ...loadedJobAliases
      );
      store.prospectRunQueueParentBindings.splice(
        0,
        store.prospectRunQueueParentBindings.length,
        ...loaded.parentBindings
      );
      store.prospectRunQueueChildBindings.splice(
        0,
        store.prospectRunQueueChildBindings.length,
        ...loaded.childBindings
      );
      store.prospectExecutionKernelStates.splice(
        0,
        store.prospectExecutionKernelStates.length,
        ...loadedExecution.kernelStates
      );
      store.prospectExecutionCheckpoints.splice(
        0,
        store.prospectExecutionCheckpoints.length,
        ...loadedExecution.checkpoints
      );
      store.prospectStrategySourcePositions.splice(
        0,
        store.prospectStrategySourcePositions.length,
        ...loadedExecution.sourcePositions
      );
      store.prospectExecutionLeases.splice(
        0,
        store.prospectExecutionLeases.length,
        ...loadedExecution.leases
      );
      store.prospectExecutionAttempts.splice(
        0,
        store.prospectExecutionAttempts.length,
        ...loadedExecution.attempts
      );
      store.prospectProviderRequestLedgers.splice(
        0,
        store.prospectProviderRequestLedgers.length,
        ...loadedExecution.providerRequestLedgers
      );
      store.prospectProviderRequestDispatches.splice(
        0,
        store.prospectProviderRequestDispatches.length,
        ...loadedExecution.providerRequestDispatches
      );
      store.prospectProviderRequestAttemptBindings.splice(
        0,
        store.prospectProviderRequestAttemptBindings.length,
        ...loadedExecution.providerRequestAttemptBindings
      );
      store.prospectProviderRequestEvents.splice(
        0,
        store.prospectProviderRequestEvents.length,
        ...loadedExecution.providerRequestEvents
      );
      store.prospectProviderRequestAccountingEvidence.splice(
        0,
        store.prospectProviderRequestAccountingEvidence.length,
        ...loadedExecution.providerRequestAccountingEvidence
      );
      store.prospectSourceRawBatches.splice(
        0,
        store.prospectSourceRawBatches.length,
        ...loadedExecution.sourceRawBatches
      );
      store.prospectSourceRawRecords.splice(
        0,
        store.prospectSourceRawRecords.length,
        ...loadedExecution.sourceRawRecords
      );
      store.prospectSourceRawHits.splice(
        0,
        store.prospectSourceRawHits.length,
        ...loadedExecution.sourceRawHits
      );
      store.prospectExecutionPages.splice(
        0,
        store.prospectExecutionPages.length,
        ...loadedExecution.pages
      );
      store.prospectExecutionEvents.splice(
        0,
        store.prospectExecutionEvents.length,
        ...loadedExecution.events
      );
      store.prospectExecutionThrottleBuckets.splice(
        0,
        store.prospectExecutionThrottleBuckets.length,
        ...loadedExecution.throttleBuckets
      );
      store.aiModelConfigs.splice(
        0,
        store.aiModelConfigs.length,
        ...loadedAiModelConfigs
      );
      store.providerCatalog.splice(
        0,
        store.providerCatalog.length,
        ...loadedProviderCatalog
      );
      store.providerConnections.splice(
        0,
        store.providerConnections.length,
        ...loadedProviderConnections
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
  store = {
    mode: "mysql",
    users: await loadUsers(pool),
    dailyReports: await loadDailyReports(pool),
    dailyReportComments: await loadDailyReportComments(pool),
    internalMessages: await loadInternalMessages(pool),
    customers: await loadCustomers(pool),
    customerOwnershipEvents: await loadCustomerOwnershipEvents(pool),
    customerActivities: await loadCustomerActivities(pool),
    customerAcquisitionSourceEvents:
      await loadCustomerAcquisitionSourceEvents(pool),
    customerIntelligenceSuggestions:
      await loadCustomerIntelligenceSuggestions(pool),
    leads: await loadLeads(pool),
    leadActivities: await loadLeadActivities(pool),
    leadSourceEvents: await loadLeadSourceEvents(pool),
    todos: await loadTodos(pool),
    deals: await loadDeals(pool),
    dealEvents: await loadDealEvents(pool),
    reminders: await loadReminders(pool),
    knowledgeAssets: await loadKnowledgeAssets(pool),
    exams: await loadExams(pool),
    examQuestions: await loadExamQuestions(pool),
    examQuestionLinks: await loadExamQuestionLinks(pool),
    examAttempts: await loadExamAttempts(pool),
	    importExportJobs: await loadImportExportJobs(pool),
      tradeDocuments: await loadTradeDocuments(pool),
	    wecomMessages: await loadWecomMessages(pool),
		    ocrJobs: await loadOcrJobs(pool),
		    websiteOpportunities: await loadWebsiteOpportunities(pool),
        prospectCandidateProcessingStates:
          await loadProspectCandidateProcessingStates(pool),
		    aiModelConfigs: await loadAiModelConfigs(pool),
		    providerCatalog: await loadProviderCatalog(pool),
		    providerConnections: await loadProviderConnections(pool),
		    providerRequestLogs: await loadProviderRequestLogs(pool),
		    providerResponseCache: await loadProviderResponseCache(pool),
		    marketTradeObservations: await loadMarketTradeObservations(pool),
        marketOpportunityBatches: await loadMarketOpportunityBatches(pool),
        marketOpportunitySnapshots: await loadMarketOpportunitySnapshots(pool),
        marketOpportunityCalculationEvents: await loadMarketOpportunityCalculationEvents(pool),
		    agentJobs: await loadAgentJobs(pool),
		    agentJobIdempotencyAliases: await loadAgentJobIdempotencyAliases(pool),
        prospectCampaigns: await loadProspectCampaigns(pool),
        prospectCampaignVersions: await loadProspectCampaignVersions(pool),
        prospectCampaignEvents: await loadProspectCampaignEvents(pool),
        prospectStrategies: await loadProspectStrategies(pool),
        prospectStrategyEvents: await loadProspectStrategyEvents(pool),
        prospectSchedules: await loadProspectSchedules(pool),
        prospectSearchRuns: loadedProspectRunState.runs,
        prospectRunShards: loadedProspectRunState.shards,
        prospectRunEvents: loadedProspectRunState.events,
        prospectRunQueueParentBindings: loadedProspectRunState.parentBindings,
        prospectRunQueueChildBindings: loadedProspectRunState.childBindings,
        prospectExecutionKernelStates:
          loadedProspectExecutionState.kernelStates,
        prospectExecutionCheckpoints:
          loadedProspectExecutionState.checkpoints,
        prospectStrategySourcePositions:
          loadedProspectExecutionState.sourcePositions,
        prospectExecutionLeases: loadedProspectExecutionState.leases,
        prospectExecutionAttempts: loadedProspectExecutionState.attempts,
        prospectProviderRequestLedgers:
          loadedProspectExecutionState.providerRequestLedgers,
        prospectProviderRequestDispatches:
          loadedProspectExecutionState.providerRequestDispatches,
        prospectProviderRequestAttemptBindings:
          loadedProspectExecutionState.providerRequestAttemptBindings,
        prospectProviderRequestEvents:
          loadedProspectExecutionState.providerRequestEvents,
        prospectProviderRequestAccountingEvidence:
          loadedProspectExecutionState.providerRequestAccountingEvidence,
        prospectSourceRawBatches:
          loadedProspectExecutionState.sourceRawBatches,
        prospectSourceRawRecords:
          loadedProspectExecutionState.sourceRawRecords,
        prospectSourceRawHits: loadedProspectExecutionState.sourceRawHits,
        organizations: loadedOrganizationIdentityState.organizations,
        organizationIdentityClaims:
          loadedOrganizationIdentityState.organizationIdentityClaims,
        organizationAcceptedIdentifiers:
          loadedOrganizationIdentityState.organizationAcceptedIdentifiers,
        organizationIdentityResolutions:
          loadedOrganizationIdentityState.organizationIdentityResolutions,
        organizationSourceBindings:
          loadedOrganizationIdentityState.organizationSourceBindings,
        organizationIdentityConflicts:
          loadedOrganizationIdentityState.organizationIdentityConflicts,
        organizationIdentityConflictReviews:
          loadedOrganizationIdentityConflictReviewState
            .organizationIdentityConflictReviews,
        organizationCanonicalMappings:
          loadedOrganizationIdentityConflictReviewState
            .organizationCanonicalMappings,
        organizationAliasFacts:
          loadedOrganizationRelationState.organizationAliasFacts,
        organizationRelationFacts:
          loadedOrganizationRelationState.organizationRelationFacts,
        organizationIdentityEvents:
          loadedOrganizationIdentityState.organizationIdentityEvents,
        tenantProspects: loadedProspectCoverageState.tenantProspects,
        prospectCoverageEvents:
          loadedProspectCoverageState.prospectCoverageEvents,
        prospectEvidence:
          loadedProspectQualificationState.prospectEvidence,
        companyVerificationSnapshots:
          loadedProspectQualificationState.companyVerificationSnapshots,
        prospectIcpPolicySnapshots:
          loadedProspectQualificationState.prospectIcpPolicySnapshots,
        prospectIcpAssessmentSnapshots:
          loadedProspectQualificationState.prospectIcpAssessmentSnapshots,
        prospectContacts:
          loadedProspectQualificationState.prospectContacts,
        prospectContactChannels:
          loadedProspectQualificationState.prospectContactChannels,
        prospectContactVerificationSnapshots:
          loadedProspectQualificationState
            .prospectContactVerificationSnapshots,
        prospectSuppressionEvents:
          loadedProspectQualificationState.prospectSuppressionEvents,
        prospectContactabilityDecisions:
          loadedProspectQualificationState.prospectContactabilityDecisions,
        prospectTouchpoints: await loadProspectTouchpoints(pool),
        procurementSignals: await loadProcurementSignals(pool),
        dealRecommendations: await loadDealRecommendations(pool),
        acquisitionOutcomeFeedback:
          await loadAcquisitionOutcomeFeedback(pool),
        prospectStrategySuggestions:
          await loadProspectStrategySuggestions(pool),
        prospectExecutionPages: loadedProspectExecutionState.pages,
        prospectExecutionEvents: loadedProspectExecutionState.events,
        prospectExecutionThrottleBuckets:
          loadedProspectExecutionState.throttleBuckets,
		    leadSourceConfigs: await loadLeadSourceConfigs(pool),
		    planTasks: await loadPlanTasks(pool),
		    planTemplates: await loadPlanTemplates(pool),
		    problems: await loadProblems(pool),
			    memos: await loadMemos(pool),
		    competitors: await loadCompetitors(pool),
		    caseStudies: await loadCaseStudies(pool),
		    commissionProducts: await loadCommissionProducts(pool),
		    commissionRules: await loadCommissionRules(pool),
		    monthlySalesRecords: await loadMonthlySalesRecords(pool),
		    salesRecordAudits: await loadSalesRecordAudits(pool),
		    commissionCalculations: await loadCommissionCalculations(pool),
		    commissionItems: await loadCommissionItems(pool),
		    commissionExports: await loadCommissionExports(pool),
		    whatsappBindings: await loadWhatsAppBindings(pool),
		    whatsappMessages: await loadWhatsAppMessages(pool),
        persist,
        persistMutation,
        persistProspectExecutionMutation,
        persistProspectCandidateMutation,
        persistProspectCandidates,
        mutateCustomerOwnership,
        reloadProspectCandidates,
        reloadProspectRuns,
        resolveOrganizationStrongIdentity,
        reloadOrganizationIdentityTeam,
        reviewOrganizationIdentityConflict,
        reloadOrganizationIdentityConflictReviewTeam,
        recordOrganizationAlias,
        recordOrganizationRelation,
        reloadOrganizationRelationsTeam,
        recordProspectCoverage,
        setTenantProspectDisposition,
        convertProspectToLead,
        convertProspectToCustomer,
        reloadProspectCoverageTeam,
        applyProspectQualification,
        reloadProspectQualificationTeam,
        readBarrier,
        close
  };

  const seedDevelopmentData = ["test", "e2e"].includes(process.env.NODE_ENV || "")
    || process.env.CRM_SEED_DEVELOPMENT_DATA === "true";
  const existingProviderCodes = new Set(store.providerCatalog.map((item) => item.code));
  const missingDefaultProviders = defaultProviderCatalog.filter((item) => !existingProviderCodes.has(item.code));
  if (missingDefaultProviders.length) store.providerCatalog.push(...missingDefaultProviders);
  if (!store.providerConnections.length && providerConnections.length) {
    store.providerConnections.push(...providerConnections);
  }
  if (!store.providerRequestLogs.length && providerRequestLogs.length) {
    store.providerRequestLogs.push(...providerRequestLogs);
  }
  if (!store.providerResponseCache.length && providerResponseCache.length) {
    store.providerResponseCache.push(...providerResponseCache);
  }
  if (!store.marketTradeObservations.length && marketTradeObservations.length) {
    store.marketTradeObservations.push(...marketTradeObservations);
  }
  if (!store.marketOpportunityBatches.length && marketOpportunityBatches.length) {
    store.marketOpportunityBatches.push(...marketOpportunityBatches);
  }
  if (!store.marketOpportunitySnapshots.length && marketOpportunitySnapshots.length) {
    store.marketOpportunitySnapshots.push(...marketOpportunitySnapshots);
  }
  if (!store.marketOpportunityCalculationEvents.length && marketOpportunityCalculationEvents.length) {
    store.marketOpportunityCalculationEvents.push(...marketOpportunityCalculationEvents);
  }
  if (!store.agentJobs.length && agentJobs.length) {
    store.agentJobs.push(...agentJobs);
  }
  if (!store.agentJobIdempotencyAliases.length && agentJobIdempotencyAliases.length) {
    store.agentJobIdempotencyAliases.push(...agentJobIdempotencyAliases);
  }
  if (!store.prospectCampaigns.length && prospectCampaigns.length) {
    store.prospectCampaigns.push(...prospectCampaigns);
  }
  if (!store.prospectCampaignVersions.length && prospectCampaignVersions.length) {
    store.prospectCampaignVersions.push(...prospectCampaignVersions);
  }
  if (!store.prospectCampaignEvents.length && prospectCampaignEvents.length) {
    store.prospectCampaignEvents.push(...prospectCampaignEvents);
  }
  if (!store.prospectRunQueueParentBindings.length
    && prospectRunQueueParentBindings.length) {
    store.prospectRunQueueParentBindings.push(...prospectRunQueueParentBindings);
  }
  if (!store.prospectRunQueueChildBindings.length
    && prospectRunQueueChildBindings.length) {
    store.prospectRunQueueChildBindings.push(...prospectRunQueueChildBindings);
  }
  const loadedJobIds = new Set(store.agentJobs.map((item) => item.id));
  store.agentJobIdempotencyAliases.splice(
    0,
    store.agentJobIdempotencyAliases.length,
    ...store.agentJobIdempotencyAliases.filter((item) => loadedJobIds.has(item.jobId))
  );

  if (!store.users.length) {
    if (!seedDevelopmentData) {
      const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
      const password = process.env.INITIAL_ADMIN_PASSWORD || "";
      if (!email || password.length < 12) {
        throw new Error("首次生产部署必须配置 INITIAL_ADMIN_EMAIL 和至少 12 位的 INITIAL_ADMIN_PASSWORD");
      }
      store.users.push({
        id: "u_initial_super_admin",
        name: process.env.INITIAL_ADMIN_NAME?.trim() || "Super Admin",
        email,
        password: await hashPassword(password),
        role: "super_admin",
        teamId: "all",
        avatar: "SA",
        status: "active",
        authVersion: 1
      });
    } else {
      store.users.push(...users);
      store.customers.push(...customers);
      store.customerActivities.push(...customerActivities);
      store.customerIntelligenceSuggestions.push(
        ...customerIntelligenceSuggestions
      );
      store.leads.push(...leads);
      store.leadActivities.push(...leadActivities);
      store.leadSourceEvents.push(...leadSourceEvents);
      store.todos.push(...todos);
      store.deals.push(...deals);
      store.dealEvents.push(...dealEvents);
      store.reminders.push(...reminders);
      store.knowledgeAssets.push(...knowledgeAssets);
      store.exams.push(...exams);
      store.examQuestions.push(...examQuestions);
      store.examQuestionLinks.push(...examQuestionLinks);
      store.examAttempts.push(...examAttempts);
      store.importExportJobs.push(...importExportJobs);
      store.tradeDocuments.push(...tradeDocuments);
      store.wecomMessages.push(...wecomMessages);
      store.ocrJobs.push(...ocrJobs);
      store.websiteOpportunities.push(...websiteOpportunities);
      store.aiModelConfigs.push(...aiModelConfigs);
      store.leadSourceConfigs.push(...leadSourceConfigs);
      store.planTasks.push(...planTasks);
      store.planTemplates.push(...planTemplates);
      store.problems.push(...problems);
      store.memos.push(...memos);
      store.competitors.push(...competitors);
      store.caseStudies.push(...caseStudies);
      store.commissionProducts.push(...commissionProducts);
      store.commissionRules.push(...commissionRules);
      store.monthlySalesRecords.push(...monthlySalesRecords);
      store.salesRecordAudits.push(...salesRecordAudits);
      store.commissionCalculations.push(...commissionCalculations);
      store.commissionItems.push(...commissionItems);
      store.commissionExports.push(...commissionExports);
      store.whatsappBindings.push(...whatsappBindings);
      store.whatsappMessages.push(...whatsappMessages);
    }
    await store.persist();
  }
  if (seedDevelopmentData && !store.problems.length) {
    store.problems.push(...problems);
    await store.persist();
  }
  if (seedDevelopmentData && !store.memos.length) {
    store.memos.push(...memos);
    await store.persist();
  }
  if (seedDevelopmentData && !store.competitors.length) {
    store.competitors.push(...competitors);
    await store.persist();
  }
  if (seedDevelopmentData && !store.caseStudies.length) {
    store.caseStudies.push(...caseStudies);
    await store.persist();
  }
  if (seedDevelopmentData && !store.commissionProducts.length) {
    store.commissionProducts.push(...commissionProducts);
    store.commissionRules.push(...commissionRules);
    await store.persist();
  }
  if (seedDevelopmentData && !store.planTasks.length) {
    store.planTasks.push(...planTasks);
    await store.persist();
  }
  if (seedDevelopmentData && !store.planTemplates.length && planTemplates.length) {
    store.planTemplates.push(...planTemplates);
    await store.persist();
  }
  if (seedDevelopmentData && !store.tradeDocuments.length) {
    store.tradeDocuments.push(...tradeDocuments);
    await store.persist();
  }
  if (seedDevelopmentData && !store.examQuestions.length) {
    store.examQuestions.push(...examQuestions);
    await store.persist();
  }
  if (seedDevelopmentData && !store.examQuestionLinks.length) {
    store.examQuestionLinks.push(...examQuestionLinks);
    await store.persist();
  }
  if (seedDevelopmentData && !store.examAttempts.length) {
    store.examAttempts.push(...examAttempts);
    await store.persist();
  }
  const missingSeedUsers = seedDevelopmentData
    ? users.filter((seedUser) => !store.users.some((user) => user.id === seedUser.id || user.email === seedUser.email))
    : [];
  if (missingSeedUsers.length) {
    store.users.push(...missingSeedUsers);
    await store.persist();
  }
  if (missingDefaultProviders.length && store.users.length) {
    await store.persist();
  }
  const migratedConnections = migrateLegacyLeadSourceConfigs(store);
  if (migratedConnections) await store.persist();
  const missingVerificationReports = store.websiteOpportunities.filter(
    (item) => !item.verificationReport
  );
  if (missingVerificationReports.length) {
    missingVerificationReports.forEach(ensureProspectVerificationReport);
    await store.persistProspectCandidates?.(
      missingVerificationReports.map((item) => item.id)
    );
  }
  validateProspectCampaignPersistence(store);
  validateProspectRunPersistence(store);
  validateFormalCampaignNamespace(store);
  validateMarketOpportunityPersistence(store);
  const recoveredMarketAnalysisJobs = recoverInterruptedAgentJobs(
    store,
    "prospect.market_analysis"
  );
  if (recoveredMarketAnalysisJobs) await store.persist();

  return store;
}

async function ensureSchema(pool: mysql.Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(180) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    avatar VARCHAR(8),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    auth_version INT NOT NULL DEFAULT 1,
    outbound_email VARCHAR(180) DEFAULT '',
    email_sender_name VARCHAR(120) DEFAULT '',
    email_signature TEXT,
    smtp_host VARCHAR(180) DEFAULT '',
    smtp_port INT DEFAULT 465,
    smtp_secure BOOLEAN DEFAULT TRUE,
    smtp_user VARCHAR(180) DEFAULT '',
    smtp_password TEXT,
    last_development_email_at DATETIME NULL,
    last_development_email_to VARCHAR(180) DEFAULT '',
    last_development_email_subject VARCHAR(255) DEFAULT '',
    report_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query("ALTER TABLE users MODIFY role VARCHAR(20) NOT NULL");
  await pool.query("ALTER TABLE users MODIFY status VARCHAR(20) NOT NULL DEFAULT 'active'");
  await ensureColumn(pool, "users", "outbound_email", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "email_sender_name", "VARCHAR(120) DEFAULT ''");
  await ensureColumn(pool, "users", "email_signature", "TEXT");
  await ensureColumn(pool, "users", "smtp_host", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "smtp_port", "INT DEFAULT 465");
  await ensureColumn(pool, "users", "smtp_secure", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "users", "smtp_user", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "smtp_password", "TEXT");
  await ensureColumn(pool, "users", "last_development_email_at", "DATETIME NULL");
  await ensureColumn(pool, "users", "last_development_email_to", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "last_development_email_subject", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "users", "report_note", "TEXT");
  await ensureColumn(pool, "users", "auth_version", "INT NOT NULL DEFAULT 1");
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (
    id VARCHAR(64) PRIMARY KEY,
    company VARCHAR(200) NOT NULL,
    country VARCHAR(80),
    contact VARCHAR(100),
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    stage VARCHAR(40),
    amount DECIMAL(14,2) DEFAULT 0,
    health INT DEFAULT 0,
    customer_grade VARCHAR(1) NOT NULL DEFAULT 'C',
    next_reminder VARCHAR(100),
    wecom_bound BOOLEAN DEFAULT FALSE,
    billing_name VARCHAR(200) DEFAULT '',
    billing_address TEXT,
    document_contact VARCHAR(200) DEFAULT '',
    default_port_discharge VARCHAR(120) DEFAULT '',
    default_incoterm VARCHAR(80) DEFAULT '',
    default_payment_term VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "customers", "billing_name", "VARCHAR(200) DEFAULT ''");
  await ensureColumn(pool, "customers", "customer_grade", "VARCHAR(1) NOT NULL DEFAULT 'C'");
  await ensureColumn(pool, "customers", "billing_address", "TEXT");
  await ensureColumn(pool, "customers", "document_contact", "VARCHAR(200) DEFAULT ''");
  await ensureColumn(pool, "customers", "default_port_discharge", "VARCHAR(120) DEFAULT ''");
  await ensureColumn(pool, "customers", "default_incoterm", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "customers", "default_payment_term", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "customers", "pool_status", "VARCHAR(20) NOT NULL DEFAULT 'owned'");
  await ensureColumn(pool, "customers", "previous_owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "customers", "released_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "customers", "released_at", "DATETIME(3) NULL");
  await ensureColumn(pool, "customers", "release_reason", "VARCHAR(500) DEFAULT ''");
  await ensureColumn(pool, "customers", "claimed_at", "DATETIME(3) NULL");
  await ensureColumn(pool, "customers", "ownership_version", "INT NOT NULL DEFAULT 0");
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_ownership_events (
    id VARCHAR(90) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    from_owner_id VARCHAR(64) DEFAULT '',
    to_owner_id VARCHAR(64) DEFAULT '',
    event_type VARCHAR(20) NOT NULL,
    reason VARCHAR(500) DEFAULT '',
    operator_id VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_customer_ownership_customer(customer_id, created_at),
    INDEX idx_customer_ownership_team(team_id, created_at)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_activities (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    type VARCHAR(30) DEFAULT 'note',
    content TEXT,
    operator_id VARCHAR(64) DEFAULT '',
    next_reminder VARCHAR(100) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_customer_activities_customer(customer_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_acquisition_source_events (
    id VARCHAR(64) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    lead_id VARCHAR(64) NOT NULL,
    lead_source_event_id VARCHAR(64) NOT NULL,
    prospect_id VARCHAR(90) NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    source_channel VARCHAR(80) NOT NULL,
    source_campaign VARCHAR(120) DEFAULT '',
    source_url VARCHAR(500) DEFAULT '',
    conversion_mode VARCHAR(20) NOT NULL,
    processing_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_case_processing(team_id,owner_id,processing_key_hash),
    UNIQUE KEY uk_case_prospect(team_id,prospect_id),
    UNIQUE KEY uk_case_organization(team_id,organization_id),
    UNIQUE KEY uk_case_lead(team_id,owner_id,lead_id),
    INDEX idx_case_customer(customer_id),
    CONSTRAINT chk_case_mode CHECK (
      conversion_mode IN ('create_new','link_existing')
    )
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_intelligence_suggestions (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    prospect_candidate_id VARCHAR(64) NOT NULL,
    tenant_prospect_id VARCHAR(90) DEFAULT '',
    organization_id VARCHAR(90) DEFAULT '',
    lead_id VARCHAR(64) DEFAULT '',
    source_event_id VARCHAR(90) DEFAULT '',
    source_label VARCHAR(120) DEFAULT '',
    source_url VARCHAR(500) DEFAULT '',
    suggested_fields_json JSON,
    website VARCHAR(500) DEFAULT '',
    business VARCHAR(500) DEFAULT '',
    contact_info VARCHAR(500) DEFAULT '',
    evidence_summary TEXT,
    evidence_refs_json JSON,
    payload_hash CHAR(64) NOT NULL,
    suggestion_status VARCHAR(30) NOT NULL,
    accepted_fields_json JSON,
    reviewed_by VARCHAR(64) DEFAULT '',
    reviewed_at DATETIME NULL,
    review_note VARCHAR(500) DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uniq_customer_intelligence_payload(
      team_id,owner_id,customer_id,payload_hash
    ),
    INDEX idx_customer_intelligence_customer(
      team_id,owner_id,customer_id,suggestion_status
    ),
    INDEX idx_customer_intelligence_candidate(prospect_candidate_id),
    INDEX idx_customer_intelligence_organization(organization_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id VARCHAR(64) PRIMARY KEY,
    company VARCHAR(200) NOT NULL,
    contact VARCHAR(100) DEFAULT '',
    country VARCHAR(80) DEFAULT '',
    email VARCHAR(180) DEFAULT '',
    phone VARCHAR(80) DEFAULT '',
    wechat VARCHAR(80) DEFAULT '',
    source VARCHAR(80) DEFAULT '',
    intent VARCHAR(20) DEFAULT '中',
    stage VARCHAR(40) DEFAULT '新线索',
    status VARCHAR(20) DEFAULT 'new',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    estimated_amount DECIMAL(14,2) DEFAULT 0,
    next_follow_at VARCHAR(100) DEFAULT '',
    last_activity_at VARCHAR(100) DEFAULT '',
    remark TEXT,
    converted_customer_id VARCHAR(64) DEFAULT '',
    converted_deal_id VARCHAR(64) DEFAULT '',
    source_type VARCHAR(30) DEFAULT 'outbound',
    source_channel VARCHAR(80) DEFAULT 'manual',
    source_campaign VARCHAR(120) DEFAULT '',
    external_id VARCHAR(180) DEFAULT '',
    source_url VARCHAR(500) DEFAULT '',
    deleted_at DATETIME NULL,
    deleted_reason VARCHAR(255) DEFAULT '',
    deleted_by VARCHAR(64) DEFAULT '',
    purge_at DATETIME NULL,
    status_before_delete VARCHAR(20) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_leads_owner(owner_id),
    INDEX idx_leads_team(team_id),
    INDEX idx_leads_stage(stage)
  )`);
  await ensureColumn(pool, "leads", "converted_deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "leads", "source_type", "VARCHAR(30) DEFAULT 'outbound'");
  await ensureColumn(pool, "leads", "source_channel", "VARCHAR(80) DEFAULT 'manual'");
  await ensureColumn(pool, "leads", "source_campaign", "VARCHAR(120) DEFAULT ''");
  await ensureColumn(pool, "leads", "external_id", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "leads", "source_url", "VARCHAR(500) DEFAULT ''");
  await ensureColumn(pool, "leads", "deleted_at", "DATETIME NULL");
  await ensureColumn(pool, "leads", "deleted_reason", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "leads", "deleted_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "leads", "purge_at", "DATETIME NULL");
  await ensureColumn(pool, "leads", "status_before_delete", "VARCHAR(20) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (
    id VARCHAR(64) PRIMARY KEY,
    lead_id VARCHAR(64) NOT NULL,
    type VARCHAR(30) DEFAULT 'note',
    content TEXT,
    operator_id VARCHAR(64) DEFAULT '',
    next_follow_at VARCHAR(100) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lead_activities_lead(lead_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_source_events (
    id VARCHAR(64) PRIMARY KEY,
    lead_id VARCHAR(64) NOT NULL,
    source_type VARCHAR(30) NOT NULL,
    channel VARCHAR(80) NOT NULL,
    campaign VARCHAR(120) DEFAULT '',
    external_id VARCHAR(180) DEFAULT '',
    source_url VARCHAR(500) DEFAULT '',
    occurred_at DATETIME NOT NULL,
    received_at DATETIME NOT NULL,
    raw_payload JSON,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    UNIQUE KEY uniq_lead_source_external (owner_id, channel, external_id),
    INDEX idx_lead_source_events_lead(lead_id)
  )`);
  await ensureUniqueIndex(pool, "lead_source_events", "uniq_lead_source_external", ["owner_id", "channel", "external_id"]);
  await pool.query(`CREATE TABLE IF NOT EXISTS deals (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    title VARCHAR(200) NOT NULL,
    stage VARCHAR(40) NOT NULL,
    product VARCHAR(200) DEFAULT '',
    quantity INT DEFAULT 0,
    unit_price DECIMAL(14,2) DEFAULT 0,
    amount DECIMAL(14,2) DEFAULT 0,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    next_action VARCHAR(200),
    archived_at TIMESTAMP NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "deals", "product", "VARCHAR(200) DEFAULT ''");
  await ensureColumn(pool, "deals", "quantity", "INT DEFAULT 0");
  await ensureColumn(pool, "deals", "unit_price", "DECIMAL(14,2) DEFAULT 0");
  await ensureColumn(pool, "deals", "currency", "VARCHAR(12) DEFAULT 'USD'");
  await ensureColumn(pool, "deals", "amount_type", "VARCHAR(20) DEFAULT 'estimate'");
  await ensureColumn(pool, "deals", "next_action_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "deals", "expected_close_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "deals", "stage_changed_at", "DATETIME NULL");
  await ensureColumn(pool, "deals", "closed_at", "DATETIME NULL");
  await ensureColumn(pool, "deals", "won_reason", "TEXT");
  await ensureColumn(pool, "deals", "lost_reason", "TEXT");
  await ensureColumn(pool, "deals", "lost_reason_category", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "deals", "revisit_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "deals", "archived_at", "TIMESTAMP NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS deal_events (
    id VARCHAR(64) PRIMARY KEY,
    deal_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    content TEXT,
    operator_id VARCHAR(64) NOT NULL,
    from_stage VARCHAR(40) DEFAULT '',
    to_stage VARCHAR(40) DEFAULT '',
    next_action VARCHAR(200) DEFAULT '',
    next_action_at VARCHAR(40) DEFAULT '',
    related_document_id VARCHAR(64) DEFAULT '',
    created_at DATETIME NOT NULL,
    INDEX idx_deal_events_deal(deal_id),
    INDEX idx_deal_events_operator(operator_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS todos (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    type VARCHAR(40) NOT NULL,
    priority VARCHAR(20) NOT NULL,
    due_at VARCHAR(100),
    owner_id VARCHAR(64) NOT NULL,
	    team_id VARCHAR(64) NOT NULL,
	    related VARCHAR(200),
	    done BOOLEAN DEFAULT FALSE,
	    status VARCHAR(24) DEFAULT 'pending',
	    pin_state VARCHAR(20) DEFAULT '',
	    sort_order INT DEFAULT 0,
	    impact_amount DECIMAL(14,2),
	    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	    history_at TIMESTAMP NULL,
	    customer_id VARCHAR(64) DEFAULT '',
	    deal_id VARCHAR(64) DEFAULT '',
	    reminder_rule_id VARCHAR(64) DEFAULT '',
	    trigger_key VARCHAR(255) DEFAULT '',
	    snoozed_from VARCHAR(100) DEFAULT '',
	    snooze_reason VARCHAR(255) DEFAULT '',
	    snooze_count INT DEFAULT 0,
	    snoozed_by VARCHAR(64) DEFAULT '',
	    completed_at TIMESTAMP NULL,
	    completed_by VARCHAR(64) DEFAULT '',
	    completion_result VARCHAR(255) DEFAULT '',
	    INDEX idx_todos_owner_history(owner_id, history_at)
	  )`);
  await ensureColumn(pool, "todos", "status", "VARCHAR(24) DEFAULT 'pending'");
  await ensureColumn(pool, "todos", "pin_state", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "todos", "sort_order", "INT DEFAULT 0");
  await ensureColumn(pool, "todos", "created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await ensureColumn(pool, "todos", "history_at", "TIMESTAMP NULL");
  await ensureColumn(pool, "todos", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "reminder_rule_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "trigger_key", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "todos", "snoozed_from", "VARCHAR(100) DEFAULT ''");
  await ensureColumn(pool, "todos", "snooze_reason", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "todos", "snooze_count", "INT DEFAULT 0");
  await ensureColumn(pool, "todos", "snoozed_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "completed_at", "TIMESTAMP NULL");
  await ensureColumn(pool, "todos", "completed_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "completion_result", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "todos", "lead_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "prospect_candidate_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "tenant_prospect_id", "VARCHAR(90) DEFAULT ''");
  await ensureColumn(pool, "todos", "outreach_channel", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "todos", "touchpoint_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "cancelled_at", "DATETIME NULL");
  await ensureColumn(pool, "todos", "cancellation_reason", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS plan_tasks (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    phase VARCHAR(80),
    category VARCHAR(80),
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    status VARCHAR(30) NOT NULL DEFAULT 'planned',
    due_at VARCHAR(100),
    target VARCHAR(255),
    description TEXT,
    customer_id VARCHAR(64) DEFAULT '',
    lead_id VARCHAR(64) DEFAULT '',
    deal_id VARCHAR(64) DEFAULT '',
    completion_result TEXT,
    completed_at DATETIME NULL,
    cancellation_reason TEXT,
    cancelled_at DATETIME NULL,
    rescheduled_from VARCHAR(100) DEFAULT '',
    rescheduled_at DATETIME NULL,
    reschedule_reason VARCHAR(255) DEFAULT '',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_plan_tasks_owner(owner_id),
    INDEX idx_plan_tasks_team(team_id)
  )`);
  await ensureColumn(pool, "plan_tasks", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "lead_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "completion_result", "TEXT");
  await ensureColumn(pool, "plan_tasks", "completed_at", "DATETIME NULL");
  await ensureColumn(pool, "plan_tasks", "cancellation_reason", "TEXT");
  await ensureColumn(pool, "plan_tasks", "cancelled_at", "DATETIME NULL");
  await ensureColumn(pool, "plan_tasks", "rescheduled_from", "VARCHAR(100) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "rescheduled_at", "DATETIME NULL");
  await ensureColumn(pool, "plan_tasks", "reschedule_reason", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS plan_templates (
    id VARCHAR(64) PRIMARY KEY,
    section_name VARCHAR(40) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    output_text VARCHAR(255),
    badge VARCHAR(80),
    badge_tone VARCHAR(40),
    phase VARCHAR(80),
    category VARCHAR(80),
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    target VARCHAR(255),
    description TEXT,
    sort_order INT DEFAULT 0,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_plan_templates_owner(owner_id),
    INDEX idx_plan_templates_section(section_name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reminders (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    rule_text VARCHAR(255),
    due_at VARCHAR(100),
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    channel VARCHAR(40),
    status VARCHAR(40),
    rule_type VARCHAR(40),
    target_stage VARCHAR(40),
    days_count INT DEFAULT 3,
    priority VARCHAR(20) DEFAULT 'normal',
    enabled BOOLEAN DEFAULT TRUE,
    generated_count INT DEFAULT 0
  )`);
  await ensureColumn(pool, "reminders", "rule_type", "VARCHAR(40)");
  await ensureColumn(pool, "reminders", "target_stage", "VARCHAR(40)");
  await ensureColumn(pool, "reminders", "days_count", "INT DEFAULT 3");
  await ensureColumn(pool, "reminders", "priority", "VARCHAR(20) DEFAULT 'normal'");
  await ensureColumn(pool, "reminders", "enabled", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "reminders", "generated_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "target_owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "reminders", "last_run_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "reminders", "last_run_at", "TIMESTAMP NULL");
  await ensureColumn(pool, "reminders", "last_matched_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_created_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_skipped_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_failed_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_error", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_assets (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    status VARCHAR(40),
    owner_id VARCHAR(64),
    team_id VARCHAR(64) DEFAULT 'all',
    version VARCHAR(40),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "knowledge_assets", "team_id", "VARCHAR(64) DEFAULT 'all'");
  await pool.query(`CREATE TABLE IF NOT EXISTS exams (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    status VARCHAR(40),
    pass_rate DECIMAL(5,2),
    question_count INT DEFAULT 0,
    duration_minutes INT DEFAULT 20,
    pass_score INT DEFAULT 80,
    target_role VARCHAR(40) DEFAULT 'sales',
    owner_id VARCHAR(64) DEFAULT '',
    team_id VARCHAR(64) DEFAULT 'all',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "exams", "duration_minutes", "INT DEFAULT 20");
  await ensureColumn(pool, "exams", "pass_score", "INT DEFAULT 80");
  await ensureColumn(pool, "exams", "target_role", "VARCHAR(40) DEFAULT 'sales'");
  await ensureColumn(pool, "exams", "owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "exams", "team_id", "VARCHAR(64) DEFAULT 'all'");
  await ensureColumn(pool, "exams", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_questions (
    id VARCHAR(64) PRIMARY KEY,
    exam_id VARCHAR(64) DEFAULT 'bank',
    category VARCHAR(100),
    stem TEXT NOT NULL,
    options_json JSON NOT NULL,
    answer_index INT NOT NULL,
    answer_indexes_json JSON,
    question_type VARCHAR(20) DEFAULT 'single',
    tags_json JSON,
    explanation TEXT,
    difficulty VARCHAR(20),
    owner_id VARCHAR(64) DEFAULT '',
    team_id VARCHAR(64) DEFAULT 'all',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_questions_exam(exam_id)
  )`);
  await ensureColumn(pool, "exam_questions", "answer_indexes_json", "JSON");
  await ensureColumn(pool, "exam_questions", "question_type", "VARCHAR(20) DEFAULT 'single'");
  await ensureColumn(pool, "exam_questions", "tags_json", "JSON");
  await ensureColumn(pool, "exam_questions", "owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "exam_questions", "team_id", "VARCHAR(64) DEFAULT 'all'");
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_question_links (
    exam_id VARCHAR(64) NOT NULL,
    question_id VARCHAR(64) NOT NULL,
    sort_order INT DEFAULT 0,
    PRIMARY KEY (exam_id, question_id),
    INDEX idx_exam_question_links_exam(exam_id),
    INDEX idx_exam_question_links_question(question_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_attempts (
    id VARCHAR(64) PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    score DECIMAL(5,2),
    passed BOOLEAN,
    answers_json JSON,
    correct_count INT DEFAULT 0,
    total_questions INT DEFAULT 0,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_attempts_user(user_id),
    INDEX idx_exam_attempts_exam(exam_id)
  )`);
  await ensureColumn(pool, "exam_attempts", "answers_json", "JSON");
  await ensureColumn(pool, "exam_attempts", "correct_count", "INT DEFAULT 0");
  await ensureColumn(pool, "exam_attempts", "total_questions", "INT DEFAULT 0");
  await pool.query(`CREATE TABLE IF NOT EXISTS ocr_jobs (
    id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(40),
    confidence DECIMAL(5,2),
    fields_json JSON,
    created_by VARCHAR(64),
    owner_id VARCHAR(64) NOT NULL DEFAULT '',
    team_id VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "ocr_jobs", "owner_id", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureColumn(pool, "ocr_jobs", "team_id", "VARCHAR(64) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE ocr_jobs MODIFY COLUMN owner_id VARCHAR(64) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE ocr_jobs MODIFY COLUMN team_id VARCHAR(64) NOT NULL DEFAULT ''");
  await pool.query("UPDATE ocr_jobs SET owner_id = created_by WHERE owner_id = '' AND created_by IS NOT NULL AND created_by <> ''");
  await pool.query(`
    UPDATE ocr_jobs jobs
    JOIN users ON users.id = jobs.owner_id
    SET jobs.team_id = users.team_id
    WHERE jobs.team_id = ''
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS website_opportunities (
    id VARCHAR(64) PRIMARY KEY,
    company VARCHAR(200) NOT NULL,
    business VARCHAR(255),
    country VARCHAR(80),
    website VARCHAR(255),
    contact VARCHAR(120),
    contact_info VARCHAR(255),
    description TEXT,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    status VARCHAR(30),
    customer_id VARCHAR(64),
    deal_id VARCHAR(64),
    lead_id VARCHAR(64),
    parse_mode VARCHAR(20) DEFAULT 'rule',
    source_evidence_json JSON,
    last_development_email_at DATETIME NULL,
    last_development_email_subject VARCHAR(255) DEFAULT '',
    last_development_email_to VARCHAR(180) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_website_opps_owner(owner_id),
    INDEX idx_website_opps_team(team_id)
  )`);
  await ensureColumn(pool, "website_opportunities", "parse_mode", "VARCHAR(20) DEFAULT 'rule'");
  await ensureColumn(pool, "website_opportunities", "lead_id", "VARCHAR(64) DEFAULT NULL");
  await ensureColumn(pool, "website_opportunities", "source", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "source_label", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "source_evidence_json", "JSON");
  await ensureColumn(pool, "website_opportunities", "verification_report_json", "JSON");
  await ensureColumn(pool, "website_opportunities", "confidence", "INT NULL");
  await ensureColumn(pool, "website_opportunities", "last_development_email_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "last_development_email_subject", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "last_development_email_to", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "verified_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "status_changed_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "excluded_reason", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "tenant_prospect_id", "VARCHAR(64) DEFAULT NULL");
  await ensureColumn(pool, "website_opportunities", "organization_id", "VARCHAR(64) DEFAULT NULL");
  await ensureColumn(pool, "website_opportunities", "coverage_classification", "VARCHAR(40) DEFAULT NULL");
  await ensureColumn(pool, "website_opportunities", "coverage_queue_state", "VARCHAR(20) DEFAULT NULL");
  await ensureColumn(pool, "website_opportunities", "coverage_reason_code", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "last_touchpoint_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "last_touchpoint_channel", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "last_reply_classification", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "next_follow_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "outreach_state", "VARCHAR(30) DEFAULT 'uncontacted'");
  await ensureColumn(pool, "website_opportunities", "invalid_contact_channels_json", "JSON");
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_touchpoints (
    id VARCHAR(64) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    prospect_candidate_id VARCHAR(64) NOT NULL,
    tenant_prospect_id VARCHAR(90) DEFAULT '',
    organization_id VARCHAR(90) DEFAULT '',
    lead_id VARCHAR(64) DEFAULT '',
    channel VARCHAR(20) NOT NULL,
    direction VARCHAR(20) NOT NULL,
    contact_value VARCHAR(255) DEFAULT '',
    subject VARCHAR(255) DEFAULT '',
    content TEXT,
    reply_classification VARCHAR(40) DEFAULT '',
    request_id VARCHAR(120) NOT NULL,
    occurred_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uniq_prospect_touchpoint_request(
      owner_id,prospect_candidate_id,request_id
    ),
    INDEX idx_prospect_touchpoints_candidate(
      team_id,owner_id,prospect_candidate_id,occurred_at
    ),
    INDEX idx_prospect_touchpoints_lead(lead_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS procurement_signals (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    prospect_candidate_id VARCHAR(64) NOT NULL,
    tenant_prospect_id VARCHAR(90) DEFAULT '',
    organization_id VARCHAR(90) DEFAULT '',
    lead_id VARCHAR(64) DEFAULT '',
    customer_id VARCHAR(64) DEFAULT '',
    source_touchpoint_id VARCHAR(90) NOT NULL,
    source_type VARCHAR(30) NOT NULL,
    evidence_types_json JSON,
    evidence_summary TEXT,
    product VARCHAR(200) DEFAULT '',
    specification TEXT,
    quantity INT DEFAULT 0,
    quantity_type VARCHAR(20) DEFAULT 'unknown',
    target_price DECIMAL(14,2) DEFAULT 0,
    currency VARCHAR(12) DEFAULT 'USD',
    price_basis VARCHAR(80) DEFAULT '',
    delivery_requirement VARCHAR(500) DEFAULT '',
    certification_requirement VARCHAR(500) DEFAULT '',
    purchase_timeline VARCHAR(500) DEFAULT '',
    project_name VARCHAR(500) DEFAULT '',
    buyer_role VARCHAR(100) DEFAULT '',
    next_action VARCHAR(200) DEFAULT '',
    confidence INT DEFAULT 0,
    signal_status VARCHAR(30) NOT NULL,
    observed_at DATETIME NOT NULL,
    valid_until DATETIME NOT NULL,
    dismissed_reason VARCHAR(500) DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uniq_procurement_signal_touchpoint(
      team_id,owner_id,prospect_candidate_id,source_touchpoint_id
    ),
    INDEX idx_procurement_signals_candidate(
      team_id,owner_id,prospect_candidate_id,observed_at
    ),
    INDEX idx_procurement_signals_lead(lead_id),
    INDEX idx_procurement_signals_customer(customer_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS deal_recommendations (
    id VARCHAR(90) PRIMARY KEY,
    signal_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    prospect_candidate_id VARCHAR(64) NOT NULL,
    tenant_prospect_id VARCHAR(90) DEFAULT '',
    organization_id VARCHAR(90) DEFAULT '',
    lead_id VARCHAR(64) DEFAULT '',
    customer_id VARCHAR(64) DEFAULT '',
    suggested_title VARCHAR(200) NOT NULL,
    suggested_product VARCHAR(500) NOT NULL,
    suggested_quantity INT DEFAULT 0,
    suggested_unit_price DECIMAL(14,2) DEFAULT 0,
    suggested_amount DECIMAL(14,2) DEFAULT 0,
    currency VARCHAR(12) DEFAULT 'USD',
    initial_stage VARCHAR(40) DEFAULT '询盘',
    next_action VARCHAR(200) DEFAULT '',
    next_action_at VARCHAR(40) DEFAULT '',
    expected_close_at VARCHAR(40) DEFAULT '',
    reason_codes_json JSON,
    missing_fields_json JSON,
    evidence_refs_json JSON,
    recommendation_score INT DEFAULT 0,
    duplicate_deal_ids_json JSON,
    recommendation_status VARCHAR(40) NOT NULL,
    reviewed_by VARCHAR(64) DEFAULT '',
    reviewed_at DATETIME NULL,
    review_reason VARCHAR(500) DEFAULT '',
    linked_deal_id VARCHAR(64) DEFAULT '',
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uniq_deal_recommendation_signal(
      team_id,owner_id,signal_id
    ),
    INDEX idx_deal_recommendations_candidate(
      team_id,owner_id,prospect_candidate_id,recommendation_status
    ),
    INDEX idx_deal_recommendations_lead(lead_id),
    INDEX idx_deal_recommendations_customer(customer_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS acquisition_outcome_feedback (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    deal_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    lead_id VARCHAR(64) DEFAULT '',
    prospect_candidate_id VARCHAR(64) DEFAULT '',
    tenant_prospect_id VARCHAR(90) DEFAULT '',
    organization_id VARCHAR(90) DEFAULT '',
    campaign_id VARCHAR(90) DEFAULT '',
    campaign_version INT DEFAULT 0,
    strategy_id VARCHAR(90) DEFAULT '',
    run_id VARCHAR(90) DEFAULT '',
    provider_codes_json JSON,
    icp_assessment_id VARCHAR(90) DEFAULT '',
    icp_policy_id VARCHAR(90) DEFAULT '',
    outcome VARCHAR(12) NOT NULL,
    amount DECIMAL(14,2) DEFAULT 0,
    currency VARCHAR(12) DEFAULT 'USD',
    reason_category VARCHAR(80) DEFAULT '',
    reason_text TEXT,
    closed_at DATETIME NOT NULL,
    attribution_confidence INT NOT NULL,
    attribution_reason_codes_json JSON,
    payload_hash CHAR(64) NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uniq_acquisition_outcome_deal(team_id,owner_id,deal_id),
    INDEX idx_acquisition_outcome_scope(
      team_id,owner_id,campaign_id,strategy_id,closed_at
    ),
    INDEX idx_acquisition_outcome_provider(team_id,owner_id,outcome)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_strategy_suggestions (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(90) NOT NULL,
    campaign_version INT DEFAULT 0,
    strategy_id VARCHAR(90) NOT NULL,
    suggestion_type VARCHAR(60) NOT NULL,
    sample_metrics_json JSON,
    proposed_adjustments_json JSON,
    rationale TEXT,
    reason_codes_json JSON,
    sample_from DATETIME NULL,
    sample_to DATETIME NULL,
    payload_hash CHAR(64) NOT NULL,
    suggestion_status VARCHAR(20) NOT NULL,
    reviewed_by VARCHAR(64) DEFAULT '',
    reviewed_at DATETIME NULL,
    review_note VARCHAR(500) DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uniq_prospect_strategy_suggestion_payload(
      team_id,owner_id,payload_hash
    ),
    INDEX idx_prospect_strategy_suggestion_scope(
      team_id,owner_id,suggestion_status,created_at
    ),
    INDEX idx_prospect_strategy_suggestion_strategy(
      team_id,owner_id,campaign_id,strategy_id
    )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_model_configs (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(40) NOT NULL DEFAULT 'openai',
    protocol VARCHAR(40) NOT NULL DEFAULT 'openai-compatible',
    name VARCHAR(120) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    model VARCHAR(120) NOT NULL,
    api_key TEXT,
    enabled BOOLEAN DEFAULT FALSE,
    temperature DECIMAL(4,2) DEFAULT 0.10,
    use_lead_finder BOOLEAN DEFAULT TRUE,
    use_website_parse BOOLEAN DEFAULT TRUE,
    use_scoring BOOLEAN DEFAULT TRUE,
    use_email_draft BOOLEAN DEFAULT TRUE,
    use_exam BOOLEAN DEFAULT FALSE,
    last_test_at DATETIME NULL,
    last_test_status VARCHAR(20) DEFAULT 'untested',
    last_test_message VARCHAR(255) DEFAULT '',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_model_owner(owner_id)
  )`);
  await ensureColumn(pool, "ai_model_configs", "protocol", "VARCHAR(40) NOT NULL DEFAULT 'openai-compatible'");
  await ensureColumn(pool, "ai_model_configs", "temperature", "DECIMAL(4,2) DEFAULT 0.10");
  await ensureColumn(pool, "ai_model_configs", "use_lead_finder", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_website_parse", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_scoring", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_email_draft", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_exam", "BOOLEAN DEFAULT FALSE");
  await ensureColumn(pool, "ai_model_configs", "last_test_at", "DATETIME NULL");
  await ensureColumn(pool, "ai_model_configs", "last_test_status", "VARCHAR(20) DEFAULT 'untested'");
  await ensureColumn(pool, "ai_model_configs", "last_test_message", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_source_configs (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(40) NOT NULL,
    scope VARCHAR(20) NOT NULL DEFAULT 'personal',
    api_key TEXT,
    base_url VARCHAR(255) DEFAULT '',
    enabled BOOLEAN DEFAULT FALSE,
    last_test_at DATETIME NULL,
    last_test_status VARCHAR(20) DEFAULT 'untested',
    last_test_message VARCHAR(255) DEFAULT '',
    usage_json TEXT,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lead_source_owner(owner_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS provider_catalog (
    id VARCHAR(64) PRIMARY KEY,
    code VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    category VARCHAR(40) NOT NULL,
    source_level VARCHAR(40) NOT NULL,
    access_mode VARCHAR(40) NOT NULL,
    base_url VARCHAR(255) DEFAULT '',
    official_docs_url VARCHAR(255) DEFAULT '',
    capability_json JSON NOT NULL,
    allowed_fields_json JSON NOT NULL,
    license_policy_json JSON NOT NULL,
    default_rate_policy_json JSON NOT NULL,
    retention_policy_json JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    version VARCHAR(40) NOT NULL DEFAULT '1.0',
    reviewed_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_provider_catalog_status(status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS provider_connections (
    id VARCHAR(64) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    scope VARCHAR(20) NOT NULL DEFAULT 'personal',
    credential_ref VARCHAR(80) NOT NULL UNIQUE,
    configuration_encrypted TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'disabled',
    quota_policy_json JSON NOT NULL,
    budget_policy_json JSON NOT NULL,
    last_health_at DATETIME NULL,
    last_health_status VARCHAR(20) NOT NULL DEFAULT 'untested',
    last_error_code VARCHAR(80) DEFAULT '',
    last_health_message VARCHAR(255) DEFAULT '',
    usage_text TEXT,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    created_by VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_provider_connection_owner(provider_id, owner_id),
    INDEX idx_provider_connection_team(team_id),
    INDEX idx_provider_connection_status(status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS provider_request_logs (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    connection_id VARCHAR(64) DEFAULT '',
    run_id VARCHAR(80) NOT NULL,
    run_shard_id VARCHAR(120) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    endpoint_code VARCHAR(80) NOT NULL,
    http_status INT NOT NULL DEFAULT 0,
    attempt INT NOT NULL DEFAULT 1,
    quota_units DECIMAL(12,4) NOT NULL DEFAULT 0,
    cost_amount DECIMAL(16,6) NOT NULL DEFAULT 0,
    currency VARCHAR(12) DEFAULT '',
    duration_ms INT NOT NULL DEFAULT 0,
    response_size BIGINT NOT NULL DEFAULT 0,
    error_code VARCHAR(80) DEFAULT '',
    requested_at DATETIME(3) NOT NULL,
    INDEX idx_provider_request_team_time(team_id, requested_at),
    INDEX idx_provider_request_owner_time(owner_id, requested_at),
    INDEX idx_provider_request_run(run_id),
    INDEX idx_provider_request_provider(provider_id, requested_at)
  )`);
  await ensureDatetimePrecision(
    pool,
    "provider_request_logs",
    "requested_at",
    false
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS provider_response_cache (
    id VARCHAR(80) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    provider_version VARCHAR(40) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    payload_encrypted MEDIUMTEXT NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    fetched_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    license_scope VARCHAR(80) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    UNIQUE KEY uk_provider_response_cache(provider_id, provider_version, request_fingerprint, license_scope),
    INDEX idx_provider_response_cache_expiry(status, expires_at)
  )`);
  await ensureUniqueIndex(pool, "provider_response_cache", "uk_provider_response_cache", [
    "provider_id",
    "provider_version",
    "request_fingerprint",
    "license_scope"
  ]);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_campaigns (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL,
    current_version INT NOT NULL,
    revision_no INT NOT NULL,
    created_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    archived_at DATETIME(3) NULL,
    UNIQUE KEY uk_prospect_campaign_team_id(team_id, id),
    INDEX idx_prospect_campaign_owner_status(team_id, owner_id, status),
    INDEX idx_prospect_campaign_updated(team_id, updated_at),
    CONSTRAINT chk_prospect_campaign_status
      CHECK (status IN ('draft','active','paused','completed','archived')),
    CONSTRAINT chk_prospect_campaign_versions
      CHECK (current_version >= 1 AND revision_no >= 1)
  )`);
  await ensureUniqueIndex(
    pool,
    "prospect_campaigns",
    "uk_prospect_campaign_team_id",
    ["team_id", "id"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_campaign_versions (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    version_no INT NOT NULL,
    snapshot_json JSON NOT NULL,
    content_hash CHAR(64) NOT NULL,
    change_summary VARCHAR(500) DEFAULT '',
    created_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_campaign_version(team_id, campaign_id, version_no),
    INDEX idx_prospect_campaign_version_time(team_id, campaign_id, created_at),
    CONSTRAINT fk_prospect_campaign_version_campaign
      FOREIGN KEY (team_id, campaign_id)
      REFERENCES prospect_campaigns(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_campaign_version_no CHECK (version_no >= 1)
  )`);
  await ensureUniqueIndex(
    pool,
    "prospect_campaign_versions",
    "uk_prospect_campaign_version",
    ["team_id", "campaign_id", "version_no"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_campaign_events (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(100) NOT NULL,
    from_status VARCHAR(20) DEFAULT '',
    to_status VARCHAR(20) DEFAULT '',
    from_owner_id VARCHAR(64) DEFAULT '',
    to_owner_id VARCHAR(64) DEFAULT '',
    from_version INT NOT NULL DEFAULT 0,
    to_version INT NOT NULL DEFAULT 0,
    revision_no INT NOT NULL,
    reason VARCHAR(500) DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    INDEX idx_prospect_campaign_event_time(team_id, campaign_id, created_at),
    CONSTRAINT fk_prospect_campaign_event_campaign
      FOREIGN KEY (team_id, campaign_id)
      REFERENCES prospect_campaigns(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_campaign_event_revision CHECK (revision_no >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_strategies (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    campaign_version INT NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL,
    revision_no INT NOT NULL,
    execution_epoch INT NOT NULL DEFAULT 1,
    query_json JSON NOT NULL,
    provider_plan_json JSON NOT NULL,
    query_fingerprint CHAR(64) NOT NULL,
    fingerprint_version VARCHAR(20) NOT NULL,
    created_by VARCHAR(64) NOT NULL,
    approved_by VARCHAR(64) DEFAULT '',
    approved_at DATETIME(3) NULL,
    disabled_by VARCHAR(64) DEFAULT '',
    disabled_at DATETIME(3) NULL,
    disable_reason VARCHAR(500) DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_strategy_team_id(team_id, id),
    INDEX idx_prospect_strategy_campaign_status(
      team_id,
      campaign_id,
      campaign_version,
      status
    ),
    INDEX idx_prospect_strategy_owner_status(team_id, owner_id, status),
    INDEX idx_prospect_strategy_fingerprint(
      team_id,
      campaign_id,
      campaign_version,
      query_fingerprint
    ),
    CONSTRAINT fk_prospect_strategy_campaign_version
      FOREIGN KEY (team_id, campaign_id, campaign_version)
      REFERENCES prospect_campaign_versions(team_id, campaign_id, version_no)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_strategy_status
      CHECK (status IN ('draft','approved','disabled')),
    CONSTRAINT chk_prospect_strategy_revision CHECK (revision_no >= 1)
  )`);
  await ensureUniqueIndex(
    pool,
    "prospect_strategies",
    "uk_prospect_strategy_team_id",
    ["team_id", "id"]
  );
  await ensureUniqueIndex(
    pool,
    "prospect_strategies",
    "uk_prospect_strategy_run_ref",
    ["team_id", "campaign_id", "campaign_version", "id"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_strategy_events (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    strategy_id VARCHAR(80) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(100) NOT NULL,
    from_status VARCHAR(20) DEFAULT '',
    to_status VARCHAR(20) NOT NULL,
    from_revision INT NOT NULL,
    to_revision INT NOT NULL,
    reason VARCHAR(500) DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    INDEX idx_prospect_strategy_event_time(
      team_id,
      strategy_id,
      created_at
    ),
    CONSTRAINT fk_prospect_strategy_event_strategy
      FOREIGN KEY (team_id, strategy_id)
      REFERENCES prospect_strategies(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_strategy_event_revision
      CHECK (from_revision >= 0 AND to_revision >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_schedules (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    campaign_version INT NOT NULL,
    strategy_id VARCHAR(80) NOT NULL,
    frequency VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    timezone VARCHAR(100) NOT NULL,
    next_run_at DATETIME(3) NOT NULL,
    last_run_at DATETIME(3) NULL,
    last_run_id VARCHAR(80) DEFAULT '',
    last_planned_at DATETIME(3) NULL,
    last_failure_code VARCHAR(100) DEFAULT '',
    last_failure_reason VARCHAR(500) DEFAULT '',
    recurring_cost_approved BOOLEAN NOT NULL DEFAULT FALSE,
    revision_no INT NOT NULL,
    created_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_schedule_team_id(team_id, id),
    INDEX idx_prospect_schedule_due(team_id, status, next_run_at),
    INDEX idx_prospect_schedule_owner(team_id, owner_id, status),
    INDEX idx_prospect_schedule_strategy(team_id, strategy_id),
    CONSTRAINT fk_prospect_schedule_campaign_version
      FOREIGN KEY (team_id, campaign_id, campaign_version)
      REFERENCES prospect_campaign_versions(team_id, campaign_id, version_no)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_schedule_strategy
      FOREIGN KEY (team_id, campaign_id, campaign_version, strategy_id)
      REFERENCES prospect_strategies(
        team_id, campaign_id, campaign_version, id
      )
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_schedule_frequency
      CHECK (frequency IN ('daily','weekly','monthly')),
    CONSTRAINT chk_prospect_schedule_status
      CHECK (status IN ('active','paused')),
    CONSTRAINT chk_prospect_schedule_revision CHECK (revision_no >= 1)
  )`);
  await ensureUniqueIndex(
    pool,
    "prospect_schedules",
    "uk_prospect_schedule_team_id",
    ["team_id", "id"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_search_runs (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    campaign_version INT NOT NULL,
    strategy_id VARCHAR(80) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    revision_no INT NOT NULL,
    operation_code VARCHAR(40) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    query_fingerprint CHAR(64) NOT NULL,
    execution_snapshot_json JSON NOT NULL,
    execution_snapshot_hash CHAR(64) NOT NULL,
    queue_bridge_version VARCHAR(10) NULL,
    parent_run_id VARCHAR(80) DEFAULT '',
    created_by VARCHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    paused_at DATETIME(3) NULL,
    cancelled_at DATETIME(3) NULL,
    active_team_id VARCHAR(64)
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN (
            'queued','running','pause_requested','paused','cancel_requested'
          ) THEN team_id
          ELSE NULL
        END
      ) STORED,
    active_owner_id VARCHAR(64)
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN (
            'queued','running','pause_requested','paused','cancel_requested'
          ) THEN owner_id
          ELSE NULL
        END
      ) STORED,
    active_query_fingerprint CHAR(64)
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN (
            'queued','running','pause_requested','paused','cancel_requested'
          ) THEN query_fingerprint
          ELSE NULL
        END
      ) STORED,
    UNIQUE KEY uk_prospect_run_team_id(team_id, id),
    UNIQUE KEY uk_prospect_run_idempotency(
      team_id,
      created_by,
      operation_code,
      idempotency_key_hash
    ),
    UNIQUE KEY uk_prospect_run_active_fingerprint(
      active_team_id,
      active_owner_id,
      active_query_fingerprint
    ),
    INDEX idx_prospect_run_campaign(
      team_id,
      campaign_id,
      campaign_version,
      created_at
    ),
    INDEX idx_prospect_run_strategy(team_id, strategy_id, created_at),
    INDEX idx_prospect_run_owner_status(team_id, owner_id, status, created_at),
    CONSTRAINT fk_prospect_run_campaign_version
      FOREIGN KEY (team_id, campaign_id, campaign_version)
      REFERENCES prospect_campaign_versions(team_id, campaign_id, version_no)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_run_strategy
      FOREIGN KEY (
        team_id,
        campaign_id,
        campaign_version,
        strategy_id
      )
      REFERENCES prospect_strategies(
        team_id,
        campaign_id,
        campaign_version,
        id
      )
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_run_status
      CHECK (status IN (
        'queued','running','pause_requested','paused','cancel_requested',
        'cancelled','succeeded','succeeded_empty','partial_success','failed'
      )),
    CONSTRAINT chk_prospect_run_revision CHECK (revision_no >= 1),
    CONSTRAINT chk_prospect_run_operation
      CHECK (operation_code = 'create_search_run_v1'),
    CONSTRAINT chk_prospect_run_queue_bridge_version
      CHECK (
        queue_bridge_version IS NULL
        OR queue_bridge_version = 'v1'
      )
  )`);
  await ensureColumn(
    pool,
    "prospect_search_runs",
    "queue_bridge_version",
    "VARCHAR(10) NULL"
  );
  await ensureColumn(
    pool,
    "prospect_search_runs",
    "execution_epoch",
    "INT NOT NULL DEFAULT 1"
  );
  await replaceCheckConstraint(
    pool,
    "prospect_search_runs",
    "chk_prospect_run_status",
    `status IN (
      'queued','running','pause_requested','paused','cancel_requested',
      'cancelled','succeeded','succeeded_empty','partial_success','failed'
    )`
  );
  await pool.query(`ALTER TABLE prospect_search_runs
    MODIFY COLUMN active_team_id VARCHAR(64)
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN (
            'queued','running','pause_requested','paused','cancel_requested'
          ) THEN team_id
          ELSE NULL
        END
      ) STORED,
    MODIFY COLUMN active_owner_id VARCHAR(64)
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN (
            'queued','running','pause_requested','paused','cancel_requested'
          ) THEN owner_id
          ELSE NULL
        END
      ) STORED,
    MODIFY COLUMN active_query_fingerprint CHAR(64)
      GENERATED ALWAYS AS (
        CASE
          WHEN status IN (
            'queued','running','pause_requested','paused','cancel_requested'
          ) THEN query_fingerprint
          ELSE NULL
        END
      ) STORED`);
  await ensureCheckConstraint(
    pool,
    "prospect_search_runs",
    "chk_prospect_run_queue_bridge_version",
    "queue_bridge_version IS NULL OR queue_bridge_version = 'v1'"
  );
  await ensureUniqueIndex(
    pool,
    "prospect_search_runs",
    "uk_prospect_run_team_id",
    ["team_id", "id"]
  );
  await ensureUniqueIndex(
    pool,
    "prospect_search_runs",
    "uk_prospect_run_idempotency",
    ["team_id", "created_by", "operation_code", "idempotency_key_hash"]
  );
  await ensureUniqueIndex(
    pool,
    "prospect_search_runs",
    "uk_prospect_run_active_fingerprint",
    ["active_team_id", "active_owner_id", "active_query_fingerprint"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_run_shards (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    position_no INT NOT NULL,
    status VARCHAR(20) NOT NULL,
    page_limit INT NOT NULL,
    result_limit INT NOT NULL,
    budget_limit VARCHAR(64) NULL,
    currency VARCHAR(3) DEFAULT '',
    adapter_version VARCHAR(80) NOT NULL,
    contract_version VARCHAR(80) NOT NULL,
    catalog_version VARCHAR(80) NOT NULL,
    capabilities_json JSON NOT NULL,
    access_mode VARCHAR(30) NOT NULL,
    has_cursor BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_run_shard_provider(
      team_id,
      run_id,
      provider_code
    ),
    INDEX idx_prospect_run_shard_position(team_id, run_id, position_no),
    CONSTRAINT fk_prospect_run_shard_run
      FOREIGN KEY (team_id, run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_run_shard_status
      CHECK (status IN (
        'queued','running','retry_scheduled','pause_requested','paused',
        'cancel_requested','cancelled','succeeded','succeeded_empty',
        'partial_success','failed'
      )),
    CONSTRAINT chk_prospect_run_shard_limits
      CHECK (
        position_no >= 1
        AND page_limit >= 1
        AND result_limit >= 1
      ),
    CONSTRAINT chk_prospect_run_shard_cursor
      CHECK (has_cursor = FALSE)
  )`);
  await replaceCheckConstraint(
    pool,
    "prospect_run_shards",
    "chk_prospect_run_shard_status",
    `status IN (
      'queued','running','retry_scheduled','pause_requested','paused',
      'cancel_requested','cancelled','succeeded','succeeded_empty',
      'partial_success','failed'
    )`
  );
  await ensureUniqueIndex(
    pool,
    "prospect_run_shards",
    "uk_prospect_run_shard_team_run_id",
    ["team_id", "run_id", "id"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_run_events (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    sequence_no INT NOT NULL,
    event_type VARCHAR(20) NOT NULL,
    actor_id VARCHAR(64) NOT NULL,
    request_id VARCHAR(100) NOT NULL,
    from_status VARCHAR(20) DEFAULT '',
    to_status VARCHAR(20) NOT NULL,
    from_revision INT NOT NULL,
    to_revision INT NOT NULL,
    reason VARCHAR(500) DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_run_event_sequence(team_id, run_id, sequence_no),
    INDEX idx_prospect_run_event_time(team_id, run_id, created_at, id),
    CONSTRAINT fk_prospect_run_event_run
      FOREIGN KEY (team_id, run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_run_event_type
      CHECK (event_type IN ('created','paused','resumed','cancelled')),
    CONSTRAINT chk_prospect_run_event_revision
      CHECK (
        sequence_no >= 1
        AND from_revision >= 0
        AND to_revision = from_revision + 1
      )
  )`);
  await replaceCheckConstraint(
    pool,
    "prospect_run_events",
    "chk_prospect_run_event_type",
    `event_type IN (
      'created','started','pause_requested','paused','resumed',
      'cancel_requested','cancelled','completed','failed'
    )`
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS market_trade_observations (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    reporter_country VARCHAR(100) NOT NULL,
    partner_country VARCHAR(100) NOT NULL,
    reporter_code VARCHAR(16) DEFAULT '',
    partner_code VARCHAR(16) DEFAULT '',
    trade_flow VARCHAR(16) NOT NULL,
    classification VARCHAR(40) NOT NULL,
    commodity_code VARCHAR(32) NOT NULL,
    commodity_description VARCHAR(500) DEFAULT '',
    period_value VARCHAR(16) NOT NULL,
    trade_value_usd DECIMAL(24,4) NULL,
    net_weight_kg DECIMAL(24,6) NULL,
    quantity_value DECIMAL(24,6) NULL,
    quantity_unit VARCHAR(40) DEFAULT '',
    is_aggregate BOOLEAN NOT NULL DEFAULT FALSE,
    suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    status_flags_json JSON NOT NULL,
    raw_record_id VARCHAR(255) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    adapter_version VARCHAR(40) NOT NULL,
    source_revision VARCHAR(120) DEFAULT '',
    observed_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uk_market_trade_observation(
      team_id,
      owner_id,
      campaign_id,
      provider_id,
      reporter_country,
      partner_country,
      trade_flow,
      classification,
      commodity_code,
      period_value
    ),
    INDEX idx_market_trade_team_campaign(team_id, campaign_id, observed_at),
    INDEX idx_market_trade_owner_campaign(owner_id, campaign_id, observed_at)
  )`);
  await pool.query("ALTER TABLE market_trade_observations MODIFY COLUMN reporter_country VARCHAR(100) NOT NULL");
  await pool.query("ALTER TABLE market_trade_observations MODIFY COLUMN partner_country VARCHAR(100) NOT NULL");
  await pool.query("ALTER TABLE market_trade_observations MODIFY COLUMN classification VARCHAR(40) NOT NULL");
  await ensureColumn(pool, "market_trade_observations", "reporter_code", "VARCHAR(16) DEFAULT ''");
  await ensureColumn(pool, "market_trade_observations", "partner_code", "VARCHAR(16) DEFAULT ''");
  await ensureColumn(pool, "market_trade_observations", "commodity_description", "VARCHAR(500) DEFAULT ''");
  await ensureColumn(pool, "market_trade_observations", "source_revision", "VARCHAR(120) DEFAULT ''");
  await ensureUniqueIndex(pool, "market_trade_observations", "uk_market_trade_observation", [
    "team_id",
    "owner_id",
    "campaign_id",
    "provider_id",
    "reporter_country",
    "partner_country",
    "trade_flow",
    "classification",
    "commodity_code",
    "period_value"
  ]);
  await pool.query(`CREATE TABLE IF NOT EXISTS market_opportunity_batches (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    dataset_fingerprint CHAR(64) NOT NULL,
    policy_version VARCHAR(64) NOT NULL,
    status VARCHAR(30) NOT NULL,
    empty_reason VARCHAR(80) DEFAULT '',
    candidate_count INT NOT NULL DEFAULT 0,
    ready_count INT NOT NULL DEFAULT 0,
    comparison_periods_json JSON NOT NULL,
    first_trigger_job_id VARCHAR(80) NOT NULL,
    observation_cutoff_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_market_opportunity_batch(
      team_id,
      owner_id,
      campaign_id,
      provider_id,
      dataset_fingerprint,
      policy_version
    ),
    INDEX idx_market_opportunity_batch_scope(team_id, owner_id, campaign_id, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS market_opportunity_snapshots (
    id VARCHAR(80) PRIMARY KEY,
    batch_id VARCHAR(80) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    reporter_country VARCHAR(100) NOT NULL,
    reporter_code VARCHAR(16) DEFAULT '',
    classification VARCHAR(40) NOT NULL,
    commodity_code VARCHAR(32) NOT NULL,
    commodity_description VARCHAR(500) DEFAULT '',
    comparison_period VARCHAR(16) DEFAULT '',
    snapshot_status VARCHAR(30) NOT NULL,
    insufficiency_reasons_json JSON NOT NULL,
    metrics_json JSON NOT NULL,
    market_score DECIMAL(10,4) NULL,
    growth_score DECIMAL(10,4) NULL,
    china_supply_score DECIMAL(10,4) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_market_opportunity_snapshot(
      batch_id,
      reporter_code,
      reporter_country,
      classification,
      commodity_code
    ),
    INDEX idx_market_opportunity_snapshot_scope(team_id, owner_id, campaign_id, batch_id),
    INDEX idx_market_opportunity_snapshot_filter(batch_id, snapshot_status, classification, commodity_code)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS market_opportunity_calculation_events (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    trigger_job_id VARCHAR(80) NOT NULL,
    batch_id VARCHAR(80) NOT NULL,
    dataset_fingerprint CHAR(64) NOT NULL,
    policy_version VARCHAR(64) NOT NULL,
    outcome VARCHAR(30) NOT NULL,
    reused_batch BOOLEAN NOT NULL DEFAULT FALSE,
    sequence_no BIGINT NOT NULL,
    calculated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_market_opportunity_event_job(trigger_job_id),
    UNIQUE KEY uk_market_opportunity_event_sequence(sequence_no),
    INDEX idx_market_opportunity_event_scope(team_id, owner_id, campaign_id, calculated_at)
  )`);
  await ensureColumn(
    pool,
    "market_opportunity_batches",
    "first_trigger_job_id",
    "VARCHAR(80) NULL"
  );
  await ensureColumn(
    pool,
    "market_opportunity_batches",
    "observation_cutoff_at",
    "DATETIME NULL"
  );
  await ensureColumn(
    pool,
    "market_opportunity_calculation_events",
    "sequence_no",
    "BIGINT NULL"
  );
  await pool.query(`
    UPDATE market_opportunity_batches batch
    SET first_trigger_job_id = (
      SELECT event.trigger_job_id
      FROM market_opportunity_calculation_events event
      WHERE event.batch_id = batch.id
      ORDER BY event.calculated_at ASC, event.id ASC
      LIMIT 1
    )
    WHERE first_trigger_job_id IS NULL OR first_trigger_job_id = ''
  `);
  await pool.query(`
    UPDATE market_opportunity_calculation_events event
    INNER JOIN (
      SELECT id, ROW_NUMBER() OVER (ORDER BY calculated_at ASC, id ASC) AS sequence_no
      FROM market_opportunity_calculation_events
    ) ranked ON ranked.id = event.id
    SET event.sequence_no = ranked.sequence_no
    WHERE event.sequence_no IS NULL OR event.sequence_no <= 0
  `);
  await pool.query(
    "ALTER TABLE market_opportunity_batches MODIFY COLUMN first_trigger_job_id VARCHAR(80) NOT NULL"
  );
  await pool.query(
    "ALTER TABLE market_opportunity_batches MODIFY COLUMN observation_cutoff_at DATETIME(3) NULL"
  );
  await pool.query(
    "ALTER TABLE market_opportunity_batches MODIFY COLUMN created_at DATETIME(3) NOT NULL"
  );
  await pool.query(
    "ALTER TABLE market_opportunity_snapshots MODIFY COLUMN created_at DATETIME(3) NOT NULL"
  );
  await pool.query(
    "ALTER TABLE market_opportunity_calculation_events MODIFY COLUMN sequence_no BIGINT NOT NULL"
  );
  await pool.query(
    "ALTER TABLE market_opportunity_calculation_events MODIFY COLUMN calculated_at DATETIME(3) NOT NULL"
  );
  await ensureUniqueIndex(
    pool,
    "market_opportunity_batches",
    "uk_market_opportunity_batch",
    [
      "team_id",
      "owner_id",
      "campaign_id",
      "provider_id",
      "dataset_fingerprint",
      "policy_version"
    ]
  );
  await ensureUniqueIndex(
    pool,
    "market_opportunity_snapshots",
    "uk_market_opportunity_snapshot",
    ["batch_id", "reporter_code", "classification", "commodity_code"]
  );
  await ensureUniqueIndex(
    pool,
    "market_opportunity_calculation_events",
    "uk_market_opportunity_event_job",
    ["trigger_job_id"]
  );
  await ensureUniqueIndex(
    pool,
    "market_opportunity_calculation_events",
    "uk_market_opportunity_event_sequence",
    ["sequence_no"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_jobs (
    id VARCHAR(80) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    job_type VARCHAR(80) NOT NULL,
    aggregate_type VARCHAR(80) DEFAULT '',
    aggregate_id VARCHAR(100) DEFAULT '',
    parent_job_id VARCHAR(80) DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'queued',
    priority INT NOT NULL DEFAULT 50,
    idempotency_key CHAR(64) NOT NULL,
    policy_version VARCHAR(40) NOT NULL DEFAULT 'v1',
    input_json_encrypted MEDIUMTEXT NOT NULL,
    output_json_encrypted MEDIUMTEXT,
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    next_attempt_at DATETIME(3) NULL,
    error_code VARCHAR(80) DEFAULT '',
    error_message VARCHAR(255) DEFAULT '',
    trace_id VARCHAR(100) NOT NULL,
    started_at DATETIME(3) NULL,
    finished_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_agent_job_idempotency(team_id, job_type, idempotency_key),
    INDEX idx_agent_job_owner_time(owner_id, created_at),
    INDEX idx_agent_job_team_status(team_id, status, next_attempt_at),
    INDEX idx_agent_job_parent(parent_job_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_job_idempotency_aliases (
    id VARCHAR(80) PRIMARY KEY,
    job_id VARCHAR(80) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    job_type VARCHAR(80) NOT NULL,
    idempotency_key CHAR(64) NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uk_agent_job_alias_idempotency(team_id, job_type, idempotency_key),
    INDEX idx_agent_job_alias_job(job_id)
  )`);
  await repairAgentJobIdempotencyIntegrity(pool);
  await ensureUniqueIndex(pool, "agent_jobs", "uk_agent_job_idempotency", [
    "team_id",
    "job_type",
    "idempotency_key"
  ]);
  await ensureUniqueIndex(
    pool,
    "agent_jobs",
    "uk_agent_job_queue_bridge_ref",
    ["team_id", "owner_id", "id", "job_type", "parent_job_id"]
  );
  await ensureUniqueIndex(
    pool,
    "agent_jobs",
    "uk_agent_job_execution_ref",
    ["team_id", "owner_id", "id"]
  );
  await pool.query(`ALTER TABLE agent_jobs
    MODIFY COLUMN next_attempt_at DATETIME(3) NULL,
    MODIFY COLUMN started_at DATETIME(3) NULL,
    MODIFY COLUMN finished_at DATETIME(3) NULL,
    MODIFY COLUMN created_at DATETIME(3) NOT NULL`);
  await ensureUniqueIndex(
    pool,
    "agent_job_idempotency_aliases",
    "uk_agent_job_alias_idempotency",
    ["team_id", "job_type", "idempotency_key"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_run_queue_parent_bindings (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    job_type VARCHAR(80) NOT NULL,
    parent_job_id VARCHAR(80) NOT NULL DEFAULT '',
    bridge_version VARCHAR(10) NOT NULL,
    execution_snapshot_hash CHAR(64) NOT NULL,
    binding_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_run_queue_parent_run(team_id, run_id),
    UNIQUE KEY uk_prospect_run_queue_parent_job(team_id, job_id),
    UNIQUE KEY uk_prospect_run_queue_parent_child_ref(
      team_id,
      run_id,
      owner_id,
      job_id
    ),
    CONSTRAINT fk_prospect_run_queue_parent_run
      FOREIGN KEY (team_id, run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_run_queue_parent_job
      FOREIGN KEY (team_id, owner_id, job_id, job_type, parent_job_id)
      REFERENCES agent_jobs(team_id, owner_id, id, job_type, parent_job_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_run_queue_parent_contract
      CHECK (
        job_type = 'prospect.orchestrate'
        AND parent_job_id = ''
        AND bridge_version = 'v1'
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_run_queue_child_bindings (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    job_type VARCHAR(80) NOT NULL,
    parent_job_id VARCHAR(80) NOT NULL,
    bridge_version VARCHAR(10) NOT NULL,
    execution_snapshot_hash CHAR(64) NOT NULL,
    binding_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_run_queue_child_shard(team_id, run_id, shard_id),
    UNIQUE KEY uk_prospect_run_queue_child_job(team_id, job_id),
    CONSTRAINT fk_prospect_run_queue_child_run
      FOREIGN KEY (team_id, run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_run_queue_child_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_run_queue_child_parent
      FOREIGN KEY (team_id, run_id, owner_id, parent_job_id)
      REFERENCES prospect_run_queue_parent_bindings(
        team_id,
        run_id,
        owner_id,
        job_id
      )
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_run_queue_child_job
      FOREIGN KEY (team_id, owner_id, job_id, job_type, parent_job_id)
      REFERENCES agent_jobs(team_id, owner_id, id, job_type, parent_job_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_run_queue_child_contract
      CHECK (
        job_type = 'prospect.provider.fetch'
        AND parent_job_id <> ''
        AND bridge_version = 'v1'
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS search_execution_kernel_state (
    id VARCHAR(80) PRIMARY KEY,
    kernel_epoch BIGINT NOT NULL,
    instance_id VARCHAR(100) NOT NULL,
    started_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_search_execution_kernel_epoch
      CHECK (kernel_epoch >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_execution_checkpoints (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    run_epoch BIGINT NOT NULL,
    checkpoint_no INT NOT NULL,
    encrypted_cursor MEDIUMTEXT,
    cursor_hash CHAR(64) DEFAULT '',
    page_sequence INT NOT NULL DEFAULT 0,
    total_call_count INT NOT NULL DEFAULT 0,
    checkpoint_call_count INT NOT NULL DEFAULT 0,
    accepted_count INT NOT NULL DEFAULT 0,
    raw_count INT NOT NULL DEFAULT 0,
    invalid_count INT NOT NULL DEFAULT 0,
    duplicate_count INT NOT NULL DEFAULT 0,
    retry_after_at DATETIME(3) NULL,
    last_error_code VARCHAR(80) DEFAULT '',
    last_error_message VARCHAR(500) DEFAULT '',
    partial BOOLEAN NOT NULL DEFAULT FALSE,
    completion_reason VARCHAR(80) DEFAULT '',
    version_no BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_execution_checkpoint_shard(
      team_id, run_id, shard_id
    ),
    UNIQUE KEY uk_prospect_execution_checkpoint_id(team_id, id),
    CONSTRAINT fk_prospect_execution_checkpoint_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_execution_checkpoint_job
      FOREIGN KEY (team_id, owner_id, job_id)
      REFERENCES agent_jobs(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_execution_checkpoint_counts
      CHECK (
        run_epoch >= 1
        AND checkpoint_no >= 1
        AND page_sequence >= 0
        AND total_call_count >= 0
        AND checkpoint_call_count BETWEEN 0 AND 3
        AND accepted_count >= 0
        AND raw_count >= 0
        AND invalid_count >= 0
        AND duplicate_count >= 0
        AND version_no >= 1
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_execution_leases (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    kernel_epoch BIGINT NOT NULL,
    run_epoch BIGINT NOT NULL,
    fence_token BIGINT NOT NULL,
    claim_token_hmac CHAR(64) NOT NULL,
    worker_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL,
    claimed_at DATETIME(3) NOT NULL,
    heartbeat_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    deadline_at DATETIME(3) NOT NULL,
    request_started_at DATETIME(3) NULL,
    released_at DATETIME(3) NULL,
    release_reason VARCHAR(80) DEFAULT '',
    version_no BIGINT NOT NULL,
    active_job_id VARCHAR(80)
      GENERATED ALWAYS AS (
        CASE WHEN status = 'active' THEN job_id ELSE NULL END
      ) STORED,
    active_run_id VARCHAR(80)
      GENERATED ALWAYS AS (
        CASE WHEN status = 'active' THEN run_id ELSE NULL END
      ) STORED,
    UNIQUE KEY uk_prospect_execution_lease_id(team_id, id),
    UNIQUE KEY uk_prospect_execution_active_job(team_id, active_job_id),
    UNIQUE KEY uk_prospect_execution_active_run(team_id, active_run_id),
    UNIQUE KEY uk_prospect_execution_fence(team_id, job_id, fence_token),
    CONSTRAINT fk_prospect_execution_lease_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_execution_lease_job
      FOREIGN KEY (team_id, owner_id, job_id)
      REFERENCES agent_jobs(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_execution_lease_status
      CHECK (status IN ('active','released','expired')),
    CONSTRAINT chk_prospect_execution_lease_fence
      CHECK (
        kernel_epoch >= 1
        AND run_epoch >= 1
        AND fence_token >= 1
        AND version_no >= 1
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_execution_attempts (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    lease_id VARCHAR(90) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    checkpoint_no INT NOT NULL,
    checkpoint_call_no INT NOT NULL,
    provider_attempt_no INT NOT NULL,
    status VARCHAR(30) NOT NULL,
    request_hash CHAR(64) DEFAULT '',
    response_hash CHAR(64) DEFAULT '',
    error_code VARCHAR(80) DEFAULT '',
    error_message VARCHAR(500) DEFAULT '',
    retryable BOOLEAN NOT NULL DEFAULT FALSE,
    retry_after_at DATETIME(3) NULL,
    usage_json JSON NULL,
    cost_kind VARCHAR(20) NOT NULL,
    cost_amount DECIMAL(18,6) NULL,
    currency VARCHAR(3) DEFAULT '',
    started_at DATETIME(3) NULL,
    finished_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    version_no BIGINT NOT NULL,
    UNIQUE KEY uk_prospect_execution_attempt_lease(team_id, lease_id),
    UNIQUE KEY uk_prospect_execution_attempt_id(team_id, id),
    CONSTRAINT fk_prospect_execution_attempt_lease
      FOREIGN KEY (team_id, lease_id)
      REFERENCES prospect_execution_leases(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_execution_attempt_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_execution_attempt_job
      FOREIGN KEY (team_id, owner_id, job_id)
      REFERENCES agent_jobs(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_execution_attempt_status
      CHECK (status IN (
        'claimed','request_started','succeeded','failed',
        'request_outcome_unknown','cancelled_late'
      )),
    CONSTRAINT chk_prospect_execution_attempt_counts
      CHECK (
        checkpoint_no >= 1
        AND checkpoint_call_no BETWEEN 0 AND 3
        AND provider_attempt_no >= 0
        AND version_no >= 1
      ),
    CONSTRAINT chk_prospect_execution_attempt_cost
      CHECK (
        cost_kind IN ('actual','estimated','unknown')
        AND (cost_amount IS NULL OR cost_amount >= 0)
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_provider_request_ledgers (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    origin_attempt_id VARCHAR(90) NOT NULL,
    checkpoint_no INT NOT NULL,
    logical_request_no INT NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    connection_id VARCHAR(100) NOT NULL,
    connection_revision VARCHAR(100) NOT NULL,
    connection_config_hash CHAR(64) NOT NULL,
    endpoint_code VARCHAR(100) NOT NULL,
    adapter_version VARCHAR(100) NOT NULL,
    contract_version VARCHAR(100) NOT NULL,
    request_schema_version VARCHAR(100) NOT NULL,
    idempotency_key CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    encrypted_request_envelope MEDIUMTEXT,
    request_evidence_ref VARCHAR(500) DEFAULT '',
    status VARCHAR(30) NOT NULL,
    external_request_id VARCHAR(200) NULL,
    dispatch_confirmation_ref VARCHAR(500) DEFAULT '',
    encrypted_response_envelope MEDIUMTEXT,
    response_evidence_ref VARCHAR(500) DEFAULT '',
    response_hash CHAR(64) DEFAULT '',
    raw_response_hash CHAR(64) DEFAULT '',
    normalized_result_hash CHAR(64) DEFAULT '',
    response_accounting_evidence_hash CHAR(64) DEFAULT '',
    http_status INT NULL,
    provider_outcome_code VARCHAR(100) DEFAULT '',
    settlement_kind VARCHAR(40) DEFAULT '',
    settlement_hash CHAR(64) DEFAULT '',
    unknown_reason VARCHAR(500) DEFAULT '',
    error_code VARCHAR(100) DEFAULT '',
    kernel_epoch_at_prepare BIGINT NOT NULL,
    run_epoch_at_prepare BIGINT NOT NULL,
    fence_token_at_prepare BIGINT NOT NULL,
    lease_id_at_prepare VARCHAR(90) NOT NULL,
    prepared_at DATETIME(3) NOT NULL,
    dispatch_started_at DATETIME(3) NULL,
    dispatch_confirmed_at DATETIME(3) NULL,
    response_received_at DATETIME(3) NULL,
    unknown_at DATETIME(3) NULL,
    settled_at DATETIME(3) NULL,
    cancelled_late_at DATETIME(3) NULL,
    updated_at DATETIME(3) NOT NULL,
    version_no BIGINT NOT NULL,
    UNIQUE KEY uk_provider_request_ledger_id(team_id, id),
    UNIQUE KEY uk_provider_request_ledger_key(
      team_id, owner_id, connection_id, endpoint_code, idempotency_key
    ),
    UNIQUE KEY uk_provider_request_ledger_logical(
      team_id, run_id, shard_id, checkpoint_no, logical_request_no
    ),
    UNIQUE KEY uk_provider_request_ledger_external(
      team_id, provider_code, connection_id, endpoint_code, external_request_id
    ),
    CONSTRAINT fk_provider_request_ledger_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_ledger_job
      FOREIGN KEY (team_id, owner_id, job_id)
      REFERENCES agent_jobs(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_ledger_origin_attempt
      FOREIGN KEY (team_id, origin_attempt_id)
      REFERENCES prospect_execution_attempts(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_ledger_prepare_lease
      FOREIGN KEY (team_id, lease_id_at_prepare)
      REFERENCES prospect_execution_leases(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_provider_request_ledger_status
      CHECK (status IN (
        'prepared','dispatch_started','dispatch_confirmed',
        'response_received','outcome_unknown','settled','cancelled_late'
      )),
    CONSTRAINT chk_provider_request_ledger_numbers
      CHECK (
        checkpoint_no >= 1
        AND logical_request_no >= 1
        AND kernel_epoch_at_prepare >= 1
        AND run_epoch_at_prepare >= 1
        AND fence_token_at_prepare >= 1
        AND version_no >= 1
        AND (http_status IS NULL OR http_status BETWEEN 100 AND 599)
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_provider_request_dispatches (
    id VARCHAR(90) PRIMARY KEY,
    ledger_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    attempt_id VARCHAR(90) NOT NULL,
    dispatch_no INT NOT NULL,
    operation VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL,
    idempotency_key CHAR(64) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    replayed BOOLEAN NOT NULL DEFAULT FALSE,
    provider_executed BOOLEAN NOT NULL DEFAULT FALSE,
    external_request_id VARCHAR(200) DEFAULT '',
    response_hash CHAR(64) DEFAULT '',
    error_code VARCHAR(100) DEFAULT '',
    started_at DATETIME(3) NOT NULL,
    confirmed_at DATETIME(3) NULL,
    finished_at DATETIME(3) NULL,
    version_no BIGINT NOT NULL,
    UNIQUE KEY uk_provider_request_dispatch_id(team_id, id),
    UNIQUE KEY uk_provider_request_dispatch_no(
      team_id, ledger_id, dispatch_no
    ),
    CONSTRAINT fk_provider_request_dispatch_ledger
      FOREIGN KEY (team_id, ledger_id)
      REFERENCES prospect_provider_request_ledgers(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_dispatch_attempt
      FOREIGN KEY (team_id, attempt_id)
      REFERENCES prospect_execution_attempts(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_provider_request_dispatch_operation
      CHECK (operation IN (
        'dispatch','query_by_idempotency_key','query_by_external_request_id'
      )),
    CONSTRAINT chk_provider_request_dispatch_status
      CHECK (status IN (
        'started','confirmed','response_received','outcome_unknown','rejected'
      )),
    CONSTRAINT chk_provider_request_dispatch_numbers
      CHECK (dispatch_no >= 1 AND version_no >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_provider_request_attempt_bindings (
    id VARCHAR(90) PRIMARY KEY,
    ledger_id VARCHAR(90) NOT NULL,
    attempt_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    binding_no INT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_provider_request_binding_ledger_attempt(
      team_id, ledger_id, attempt_id
    ),
    UNIQUE KEY uk_provider_request_binding_no(
      team_id, ledger_id, binding_no
    ),
    CONSTRAINT fk_provider_request_binding_ledger
      FOREIGN KEY (team_id, ledger_id)
      REFERENCES prospect_provider_request_ledgers(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_binding_attempt
      FOREIGN KEY (team_id, attempt_id)
      REFERENCES prospect_execution_attempts(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_provider_request_binding_no
      CHECK (binding_no >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_provider_request_events (
    id VARCHAR(90) PRIMARY KEY,
    ledger_id VARCHAR(90) NOT NULL,
    dispatch_id VARCHAR(90) NULL,
    attempt_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    sequence_no INT NOT NULL,
    event_type VARCHAR(30) NOT NULL,
    from_status VARCHAR(30) DEFAULT '',
    to_status VARCHAR(30) NOT NULL,
    detail_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_provider_request_event_sequence(
      team_id, ledger_id, sequence_no
    ),
    CONSTRAINT fk_provider_request_event_ledger
      FOREIGN KEY (team_id, ledger_id)
      REFERENCES prospect_provider_request_ledgers(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_event_dispatch
      FOREIGN KEY (team_id, dispatch_id)
      REFERENCES prospect_provider_request_dispatches(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_provider_request_event_attempt
      FOREIGN KEY (team_id, attempt_id)
      REFERENCES prospect_execution_attempts(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_provider_request_event_status
      CHECK (
        event_type IN (
          'prepared','dispatch_started','dispatch_confirmed',
          'response_received','outcome_unknown','settled','cancelled_late'
        )
        AND to_status = event_type
        AND sequence_no >= 1
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_provider_request_accounting_evidence (
    id VARCHAR(90) PRIMARY KEY,
    ledger_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    sequence_no INT NOT NULL,
    provenance VARCHAR(30) NOT NULL,
    usage_json JSON NULL,
    cost_amount DECIMAL(18,6) NULL,
    currency VARCHAR(3) DEFAULT '',
    evidence_ref VARCHAR(500) DEFAULT '',
    evidence_hash CHAR(64) NOT NULL,
    estimation_method_version VARCHAR(100) DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_provider_request_accounting_sequence(
      team_id, ledger_id, sequence_no
    ),
    CONSTRAINT fk_provider_request_accounting_ledger
      FOREIGN KEY (team_id, ledger_id)
      REFERENCES prospect_provider_request_ledgers(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_provider_request_accounting_provenance
      CHECK (provenance IN (
        'unknown','estimated','provider_reported',
        'portal_export','invoice_confirmed'
      )),
    CONSTRAINT chk_provider_request_accounting_values
      CHECK (
        sequence_no >= 1
        AND (cost_amount IS NULL OR cost_amount >= 0)
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_execution_pages (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    attempt_id VARCHAR(90) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    checkpoint_no INT NOT NULL,
    page_sequence INT NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    accepted_count INT NOT NULL,
    raw_count INT NOT NULL,
    invalid_count INT NOT NULL,
    duplicate_count INT NOT NULL,
    partial BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_execution_page_sequence(
      team_id, run_id, shard_id, page_sequence
    ),
    UNIQUE KEY uk_prospect_execution_page_id(team_id, id),
    CONSTRAINT fk_prospect_execution_page_attempt
      FOREIGN KEY (team_id, attempt_id)
      REFERENCES prospect_execution_attempts(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_execution_page_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_execution_page_counts
      CHECK (
        checkpoint_no >= 1
        AND page_sequence >= 1
        AND accepted_count >= 0
        AND raw_count >= 0
        AND invalid_count >= 0
        AND duplicate_count >= 0
      )
  )`);
  await ensureUniqueIndex(
    pool,
    "prospect_execution_pages",
    "uk_prospect_execution_page_id",
    ["team_id", "id"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_strategy_source_positions (
    id VARCHAR(90) PRIMARY KEY,
    identity_hash CHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(80) NOT NULL,
    campaign_version INT NOT NULL,
    strategy_id VARCHAR(80) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    query_fingerprint CHAR(64) NOT NULL,
    connection_id VARCHAR(100) NOT NULL,
    endpoint_code VARCHAR(100) NOT NULL,
    adapter_version VARCHAR(100) NOT NULL,
    contract_version VARCHAR(100) NOT NULL,
    catalog_version VARCHAR(100) NOT NULL,
    time_window_mode VARCHAR(10) NOT NULL,
    time_window_from VARCHAR(10) NOT NULL DEFAULT '',
    time_window_to VARCHAR(10) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL,
    encrypted_cursor MEDIUMTEXT NOT NULL,
    cursor_hash CHAR(64) NOT NULL DEFAULT '',
    source_run_id VARCHAR(80) NOT NULL,
    source_shard_id VARCHAR(90) NOT NULL,
    source_page_id VARCHAR(90) NOT NULL,
    source_checkpoint_no INT NOT NULL,
    source_page_sequence INT NOT NULL,
    version_no BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_strategy_source_position_scope(
      team_id, owner_id, identity_hash
    ),
    UNIQUE KEY uk_prospect_strategy_source_position_id(team_id, id),
    INDEX idx_prospect_strategy_source_position_strategy(
      team_id, owner_id, campaign_id, strategy_id, provider_code
    ),
    CONSTRAINT fk_prospect_strategy_source_position_run
      FOREIGN KEY (team_id, source_run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_strategy_source_position_shard
      FOREIGN KEY (team_id, source_run_id, source_shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_prospect_strategy_source_position_page
      FOREIGN KEY (team_id, source_page_id)
      REFERENCES prospect_execution_pages(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_strategy_source_position_status
      CHECK (status IN ('continuable','exhausted')),
    CONSTRAINT chk_prospect_strategy_source_position_cursor
      CHECK (
        (status = 'continuable'
          AND encrypted_cursor <> ''
          AND cursor_hash <> '')
        OR
        (status = 'exhausted'
          AND encrypted_cursor = ''
          AND cursor_hash = '')
      ),
    CONSTRAINT chk_prospect_strategy_source_position_values
      CHECK (
        campaign_version >= 1
        AND source_checkpoint_no >= 1
        AND source_page_sequence >= 1
        AND version_no >= 1
        AND time_window_mode IN ('all','fixed')
      )
  )`);
  await ensureUniqueIndex(
    pool,
    "prospect_strategy_source_positions",
    "uk_prospect_strategy_source_position_scope",
    ["team_id", "owner_id", "identity_hash"]
  );
  await ensureUniqueIndex(
    pool,
    "prospect_strategy_source_positions",
    "uk_prospect_strategy_source_position_id",
    ["team_id", "id"]
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_source_raw_records (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    connection_id VARCHAR(100) NOT NULL,
    endpoint_code VARCHAR(100) NOT NULL,
    source_identity_hash CHAR(64) NOT NULL,
    artifact_hash CHAR(64) NOT NULL,
    envelope_version VARCHAR(40) NOT NULL,
    encrypted_envelope MEDIUMTEXT NOT NULL,
    envelope_hash CHAR(64) NOT NULL,
    first_observed_at DATETIME(3) NOT NULL,
    record_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_ps_raw_record_team_id(team_id, id),
    UNIQUE KEY uk_ps_raw_record_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_ps_raw_record_version(
      team_id, owner_id, provider_code, connection_id, endpoint_code,
      source_identity_hash, artifact_hash
    ),
    CONSTRAINT chk_ps_raw_record_envelope_version
      CHECK (envelope_version = 'provider-raw-v1')
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_source_raw_batches (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    attempt_id VARCHAR(90) NOT NULL,
    ledger_id VARCHAR(90) NOT NULL,
    page_id VARCHAR(90) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    connection_id VARCHAR(100) NOT NULL,
    endpoint_code VARCHAR(100) NOT NULL,
    adapter_version VARCHAR(100) NOT NULL,
    response_schema_version VARCHAR(100) NOT NULL,
    response_hash CHAR(64) NOT NULL,
    settlement_hash CHAR(64) NOT NULL,
    raw_artifact_hash CHAR(64) NOT NULL,
    record_count INT NOT NULL,
    license_policy VARCHAR(200) NOT NULL,
    retention_policy VARCHAR(200) NOT NULL,
    retention_days INT NOT NULL,
    retention_until DATETIME(3) NOT NULL,
    batch_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_ps_raw_batch_team_id(team_id, id),
    UNIQUE KEY uk_ps_raw_batch_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_ps_raw_batch_ledger(team_id, ledger_id),
    UNIQUE KEY uk_ps_raw_batch_page(team_id, page_id),
    CONSTRAINT fk_ps_raw_batch_run
      FOREIGN KEY (team_id, run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ps_raw_batch_shard
      FOREIGN KEY (team_id, run_id, shard_id)
      REFERENCES prospect_run_shards(team_id, run_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ps_raw_batch_job
      FOREIGN KEY (team_id, owner_id, job_id)
      REFERENCES agent_jobs(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ps_raw_batch_attempt
      FOREIGN KEY (team_id, attempt_id)
      REFERENCES prospect_execution_attempts(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ps_raw_batch_ledger
      FOREIGN KEY (team_id, ledger_id)
      REFERENCES prospect_provider_request_ledgers(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ps_raw_batch_page
      FOREIGN KEY (team_id, page_id)
      REFERENCES prospect_execution_pages(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_ps_raw_batch_schema
      CHECK (
        response_schema_version = 'fake-provider-source-records-v1'
      ),
    CONSTRAINT chk_ps_raw_batch_retention
      CHECK (
        record_count >= 0
        AND retention_days BETWEEN 1 AND 3650
        AND retention_until >= created_at
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_source_raw_hits (
    id VARCHAR(90) PRIMARY KEY,
    batch_id VARCHAR(90) NOT NULL,
    record_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) NOT NULL,
    job_id VARCHAR(80) NOT NULL,
    attempt_id VARCHAR(90) NOT NULL,
    ledger_id VARCHAR(90) NOT NULL,
    page_id VARCHAR(90) NOT NULL,
    ordinal INT NOT NULL,
    fetched_at DATETIME(3) NOT NULL,
    hit_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_ps_raw_hit_team_id(team_id, id),
    UNIQUE KEY uk_ps_raw_hit_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_ps_raw_hit_ordinal(team_id, batch_id, ordinal),
    INDEX idx_ps_raw_hit_record(team_id, owner_id, record_id),
    CONSTRAINT fk_ps_raw_hit_batch
      FOREIGN KEY (team_id, owner_id, batch_id)
      REFERENCES prospect_source_raw_batches(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_ps_raw_hit_record
      FOREIGN KEY (team_id, owner_id, record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_ps_raw_hit_ordinal CHECK (ordinal >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_candidate_processing (
    hit_id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    ledger_id VARCHAR(90) NOT NULL,
    processing_status VARCHAR(20) NOT NULL,
    failure_code VARCHAR(100) NOT NULL DEFAULT '',
    candidate_id VARCHAR(90) DEFAULT NULL,
    processed_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_pcp_team_owner_hit(team_id, owner_id, hit_id),
    INDEX idx_pcp_scope_status(
      team_id, owner_id, processing_status, processed_at
    ),
    CONSTRAINT fk_pcp_raw_hit
      FOREIGN KEY (team_id, owner_id, hit_id)
      REFERENCES prospect_source_raw_hits(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_pcp_status
      CHECK (processing_status IN ('completed', 'rejected'))
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_execution_events (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(80) NOT NULL,
    shard_id VARCHAR(90) DEFAULT '',
    job_id VARCHAR(80) DEFAULT '',
    event_type VARCHAR(40) NOT NULL,
    kernel_epoch BIGINT NOT NULL,
    run_epoch BIGINT NOT NULL,
    fence_token BIGINT NOT NULL,
    detail_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX idx_prospect_execution_event_run(
      team_id, run_id, created_at, id
    ),
    CONSTRAINT fk_prospect_execution_event_run
      FOREIGN KEY (team_id, run_id)
      REFERENCES prospect_search_runs(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_prospect_execution_event_numbers
      CHECK (
        kernel_epoch >= 1
        AND run_epoch >= 1
        AND fence_token >= 0
      )
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospect_execution_throttles (
    id CHAR(64) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    provider_code VARCHAR(80) NOT NULL,
    connection_id VARCHAR(100) NOT NULL,
    available_at DATETIME(3) NOT NULL,
    version_no BIGINT NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_prospect_execution_throttle_scope(
      team_id, provider_code, connection_id
    ),
    CONSTRAINT chk_prospect_execution_throttle_version
      CHECK (version_no >= 1)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS import_export_jobs (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL,
    rows_count INT DEFAULT 0,
    status VARCHAR(40),
    operator_id VARCHAR(64),
    created_at VARCHAR(100)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trade_documents (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) DEFAULT '',
    deal_id VARCHAR(64) DEFAULT '',
    revision INT DEFAULT 1,
    doc_type VARCHAR(10) NOT NULL,
    title VARCHAR(255) NOT NULL,
    doc_number VARCHAR(80) NOT NULL,
    issue_date VARCHAR(40),
    buyer VARCHAR(200),
    buyer_address TEXT,
    buyer_contact VARCHAR(200),
    seller VARCHAR(200),
    seller_address TEXT,
    currency VARCHAR(12),
    incoterm VARCHAR(80),
    payment_term VARCHAR(255),
    shipping_method VARCHAR(120),
    port_loading VARCHAR(120),
    port_discharge VARCHAR(120),
    validity_date VARCHAR(40),
    bank_info TEXT,
    notes TEXT,
    template_style VARCHAR(40),
    status VARCHAR(40),
    approval_note TEXT,
    approved_at VARCHAR(100),
    approved_by VARCHAR(64),
    audits_json JSON,
    send_records_json JSON,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    items_json JSON,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_trade_documents_owner(owner_id),
    INDEX idx_trade_documents_team(team_id)
  )`);
  await ensureColumn(pool, "trade_documents", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "trade_documents", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "trade_documents", "revision", "INT DEFAULT 1");
  await ensureColumn(pool, "trade_documents", "approval_note", "TEXT");
  await ensureColumn(pool, "trade_documents", "approved_at", "VARCHAR(100)");
  await ensureColumn(pool, "trade_documents", "approved_by", "VARCHAR(64)");
  await ensureColumn(pool, "trade_documents", "audits_json", "JSON");
  await ensureColumn(pool, "trade_documents", "send_records_json", "JSON");
	  await pool.query(`CREATE TABLE IF NOT EXISTS wecom_messages (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64),
    summary TEXT,
    owner_id VARCHAR(64),
    team_id VARCHAR(64),
    status VARCHAR(40),
	    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS problems (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(80),
    severity VARCHAR(20),
    status VARCHAR(30),
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    related_customer VARCHAR(200),
    root_cause TEXT,
    solution TEXT,
    next_action VARCHAR(255),
    due_at VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_problems_owner(owner_id),
    INDEX idx_problems_team(team_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS memos (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT,
    category VARCHAR(80),
    tags VARCHAR(255),
    customer_id VARCHAR(64) DEFAULT '',
    deal_id VARCHAR(64) DEFAULT '',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    archived BOOLEAN DEFAULT FALSE,
    deleted_at DATETIME NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_memos_owner(owner_id),
    INDEX idx_memos_team(team_id)
  )`);
  await ensureColumn(pool, "memos", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "memos", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "memos", "deleted_at", "DATETIME NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS competitors (
    id VARCHAR(64) PRIMARY KEY,
    company VARCHAR(200) NOT NULL,
    country VARCHAR(80),
    segment VARCHAR(100),
    threat_level VARCHAR(20),
    website VARCHAR(255),
    strengths TEXT,
    weaknesses TEXT,
    competing_products TEXT,
    our_strategy TEXT,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_competitors_owner(owner_id),
    INDEX idx_competitors_team(team_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS case_studies (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    customer VARCHAR(200),
    country VARCHAR(80),
    product VARCHAR(160),
    industry VARCHAR(120),
    result_text VARCHAR(255),
    story TEXT,
    reusable_points TEXT,
    status VARCHAR(30),
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_case_studies_owner(owner_id),
    INDEX idx_case_studies_team(team_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_products (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    category VARCHAR(100) DEFAULT '',
    model VARCHAR(120) DEFAULT '',
    currency VARCHAR(12) DEFAULT 'USD',
    default_price DECIMAL(14,2) DEFAULT 0,
    cost_price DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    remark TEXT,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at DATETIME NULL,
    INDEX idx_commission_products_status(status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_rules (
    id VARCHAR(64) PRIMARY KEY,
    product_id VARCHAR(64) NOT NULL,
    rule_type VARCHAR(30) NOT NULL,
    rate DECIMAL(8,4) DEFAULT 0,
    fixed_amount DECIMAL(14,2) DEFAULT 0,
    tier_json TEXT,
    gross_profit_rate DECIMAL(8,4) DEFAULT 0,
    effective_from VARCHAR(20) DEFAULT '',
    effective_to VARCHAR(20) DEFAULT '',
    enabled BOOLEAN DEFAULT TRUE,
    remark TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at DATETIME NULL,
    INDEX idx_commission_rules_product(product_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS monthly_sales_records (
    id VARCHAR(64) PRIMARY KEY,
    month_value VARCHAR(20) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) DEFAULT '',
    customer_name VARCHAR(200) DEFAULT '',
    deal_id VARCHAR(64) DEFAULT '',
    product_id VARCHAR(64) DEFAULT '',
    product_name VARCHAR(200) DEFAULT '',
    quantity DECIMAL(14,2) DEFAULT 0,
    unit_price DECIMAL(14,2) DEFAULT 0,
    sales_amount DECIMAL(14,2) DEFAULT 0,
    currency VARCHAR(12) DEFAULT 'USD',
    exchange_rate DECIMAL(14,4) DEFAULT 1,
    exchange_rate_date VARCHAR(20) DEFAULT '',
    exchange_rate_source VARCHAR(20) DEFAULT 'pending',
    settlement_currency VARCHAR(12) DEFAULT 'CNY',
    settlement_amount DECIMAL(14,2) DEFAULT 0,
    basis_type VARCHAR(30) DEFAULT 'deal_amount',
    basis_date VARCHAR(20) DEFAULT '',
    deal_archived_at VARCHAR(80) DEFAULT '',
    source_type VARCHAR(20) DEFAULT 'manual',
    status VARCHAR(30) DEFAULT 'draft',
    edited BOOLEAN DEFAULT FALSE,
    edit_note TEXT,
    last_edited_by VARCHAR(64) DEFAULT '',
    last_edited_at DATETIME NULL,
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    INDEX idx_monthly_sales_scope(month_value, owner_id),
    INDEX idx_monthly_sales_team(month_value, team_id),
    INDEX idx_monthly_sales_deal(deal_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_record_audits (
    id VARCHAR(64) PRIMARY KEY,
    record_id VARCHAR(64) NOT NULL,
    field_name VARCHAR(80) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    operator_id VARCHAR(64) NOT NULL,
    operator_name VARCHAR(120) DEFAULT '',
    created_at DATETIME NULL,
    INDEX idx_sales_record_audits_record(record_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_calculations (
    id VARCHAR(64) PRIMARY KEY,
    month_value VARCHAR(20) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    sales_amount DECIMAL(14,2) DEFAULT 0,
    auto_commission DECIMAL(14,2) DEFAULT 0,
    manual_adjustment DECIMAL(14,2) DEFAULT 0,
    final_commission DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'pending',
    version_no INT DEFAULT 1,
    is_current BOOLEAN DEFAULT TRUE,
    calculated_at DATETIME NULL,
    reviewed_by VARCHAR(64) DEFAULT '',
    reviewed_at DATETIME NULL,
    locked_by VARCHAR(64) DEFAULT '',
    locked_at DATETIME NULL,
    unlock_reason TEXT,
    INDEX idx_commission_calculations_scope(month_value, owner_id),
    INDEX idx_commission_calculations_team(month_value, team_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_items (
    id VARCHAR(64) PRIMARY KEY,
    calculation_id VARCHAR(64) NOT NULL,
    record_id VARCHAR(64) DEFAULT '',
    product_id VARCHAR(64) DEFAULT '',
    item_type VARCHAR(30) DEFAULT 'auto',
    source_type VARCHAR(20) DEFAULT 'auto',
    rule_snapshot_json TEXT,
    sales_amount DECIMAL(14,2) DEFAULT 0,
    auto_amount DECIMAL(14,2) DEFAULT 0,
    manual_amount DECIMAL(14,2) DEFAULT 0,
    final_amount DECIMAL(14,2) DEFAULT 0,
    remark TEXT,
    created_by VARCHAR(64) DEFAULT '',
    created_at DATETIME NULL,
    INDEX idx_commission_items_calc(calculation_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_exports (
    id VARCHAR(64) PRIMARY KEY,
    month_value VARCHAR(20) NOT NULL,
    scope_type VARCHAR(20) DEFAULT 'self',
    scope_owner_id VARCHAR(64) DEFAULT '',
    file_type VARCHAR(20) DEFAULT 'xlsx',
    rows_count INT DEFAULT 0,
    exported_by VARCHAR(64) NOT NULL,
    created_at DATETIME NULL,
    INDEX idx_commission_exports_month(month_value)
  )`);
  await ensureColumn(pool, "monthly_sales_records", "exchange_rate_date", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "monthly_sales_records", "exchange_rate_source", "VARCHAR(20) DEFAULT 'pending'");
  await ensureColumn(pool, "monthly_sales_records", "settlement_currency", "VARCHAR(12) DEFAULT 'CNY'");
  await ensureColumn(pool, "monthly_sales_records", "basis_type", "VARCHAR(30) DEFAULT 'deal_amount'");
  await ensureColumn(pool, "monthly_sales_records", "basis_date", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "commission_calculations", "version_no", "INT DEFAULT 1");
  await ensureColumn(pool, "commission_calculations", "is_current", "BOOLEAN DEFAULT TRUE");

  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_bindings (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL UNIQUE,
    phone_number VARCHAR(20) NOT NULL,
    wa_profile_name VARCHAR(100) DEFAULT '',
    last_message_at DATETIME NULL,
    unread_count INT DEFAULT 0,
    created_at DATETIME NULL,
    binding_mode VARCHAR(20) DEFAULT 'manual',
    user_id VARCHAR(64) DEFAULT '',
    session_data TEXT,
    twilio_phone_number VARCHAR(20) DEFAULT '',
    connection_status VARCHAR(20) DEFAULT 'disconnected',
    last_connected_at DATETIME NULL,
    INDEX idx_whatsapp_bindings_customer(customer_id),
    INDEX idx_whatsapp_bindings_user(user_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    direction VARCHAR(20) NOT NULL,
    content TEXT,
    content_translated TEXT,
    media_url VARCHAR(500) DEFAULT '',
    status VARCHAR(20) DEFAULT '',
    wa_message_id VARCHAR(128) DEFAULT '',
    created_at DATETIME NULL,
    INDEX idx_whatsapp_messages_customer(customer_id),
    INDEX idx_whatsapp_messages_created(created_at)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS daily_reports (
    id VARCHAR(64) PRIMARY KEY,
    report_date VARCHAR(10) NOT NULL,
    completed_work TEXT,
    customer_progress TEXT,
    results_text TEXT,
    risks_text TEXT,
    next_plan TEXT,
    support_needed TEXT,
    report_status VARCHAR(20) DEFAULT 'submitted',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    submitted_at DATETIME NULL,
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    UNIQUE KEY uk_daily_reports_owner_date(owner_id, report_date),
    INDEX idx_daily_reports_team_date(team_id, report_date),
    INDEX idx_daily_reports_owner(owner_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS daily_report_comments (
    id VARCHAR(64) PRIMARY KEY,
    report_id VARCHAR(64) NOT NULL,
    parent_id VARCHAR(64) DEFAULT '',
    content TEXT,
    author_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    INDEX idx_daily_report_comments_report(report_id, created_at),
    INDEX idx_daily_report_comments_team(team_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS internal_messages (
    id VARCHAR(64) PRIMARY KEY,
    thread_id VARCHAR(64) NOT NULL,
    sender_id VARCHAR(64) NOT NULL,
    recipient_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    message_type VARCHAR(20) DEFAULT 'manual',
    subject VARCHAR(180) DEFAULT '',
    content TEXT,
    related_type VARCHAR(30) DEFAULT '',
    related_id VARCHAR(64) DEFAULT '',
    read_at DATETIME NULL,
    created_at DATETIME NULL,
    updated_at DATETIME NULL,
    INDEX idx_internal_messages_recipient(recipient_id, created_at),
    INDEX idx_internal_messages_thread(thread_id, created_at),
    INDEX idx_internal_messages_team(team_id)
  )`);
}

async function rows<T>(pool: MysqlQuerySource, sql: string): Promise<T[]> {
  const [result] = await pool.query(sql);
  return result as T[];
}

async function ensureColumn(pool: mysql.Pool, table: string, column: string, definition: string) {
  const [result] = await pool.query(
    "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column]
  );
  const exists = Number((result as Array<{ count: number }>)[0]?.count || 0) > 0;
  if (!exists) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureDatetimePrecision(
  pool: mysql.Pool,
  table: string,
  column: string,
  nullable: boolean
) {
  const [result] = await pool.query(
    `SELECT data_type AS dataType,
            datetime_precision AS datetimePrecision,
            is_nullable AS isNullable
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [table, column]
  );
  const current = (result as Array<{
    dataType: string;
    datetimePrecision: number | null;
    isNullable: "YES" | "NO";
  }>)[0];
  if (
    current?.dataType === "datetime"
    && Number(current.datetimePrecision || 0) === 3
    && (current.isNullable === "YES") === nullable
  ) return;
  await pool.query(
    `ALTER TABLE \`${table}\`
     MODIFY COLUMN \`${column}\` DATETIME(3) ${nullable ? "NULL" : "NOT NULL"}`
  );
}

async function ensureUniqueIndex(pool: mysql.Pool, table: string, index: string, columns: string[]) {
  const [result] = await pool.query(
    "SELECT column_name AS columnName, non_unique AS nonUnique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY seq_in_index",
    [table, index]
  );
  const indexRows = result as Array<{ columnName: string; nonUnique: number }>;
  const current = indexRows.map((row) => row.columnName);
  const isUnique = indexRows.length > 0
    && indexRows.every((row) => Number(row.nonUnique) === 0);
  if (isUnique
    && current.length === columns.length
    && current.every((column, position) => column === columns[position])) return;
  if (current.length) await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
  await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (${columns.map((column) => `\`${column}\``).join(", ")})`);
}

async function ensureCheckConstraint(
  pool: mysql.Pool,
  table: string,
  constraint: string,
  expression: string
) {
  const [result] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.table_constraints
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND constraint_name = ?
       AND constraint_type = 'CHECK'`,
    [table, constraint]
  );
  const exists = Number(
    (result as Array<{ count: number }>)[0]?.count || 0
  ) > 0;
  if (!exists) {
    await pool.query(
      `ALTER TABLE \`${table}\`
       ADD CONSTRAINT \`${constraint}\` CHECK (${expression})`
    );
  }
}

async function replaceCheckConstraint(
  pool: mysql.Pool,
  table: string,
  constraint: string,
  expression: string
) {
  const [result] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.table_constraints
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND constraint_name = ?
       AND constraint_type = 'CHECK'`,
    [table, constraint]
  );
  const exists = Number(
    (result as Array<{ count: number }>)[0]?.count || 0
  ) > 0;
  if (exists) {
    await pool.query(
      `ALTER TABLE \`${table}\` DROP CHECK \`${constraint}\``
    );
  }
  await pool.query(
    `ALTER TABLE \`${table}\`
     ADD CONSTRAINT \`${constraint}\` CHECK (${expression})`
  );
}

async function repairAgentJobIdempotencyIntegrity(pool: mysql.Pool) {
  await pool.query(
    `DELETE alias
     FROM agent_job_idempotency_aliases alias
     LEFT JOIN agent_jobs job ON job.id = alias.job_id
     WHERE job.id IS NULL`
  );

  const scopeMismatch = await rows<{ count: number }>(
    pool,
    `SELECT COUNT(*) AS count
     FROM agent_job_idempotency_aliases alias
     INNER JOIN agent_jobs job ON job.id = alias.job_id
     WHERE alias.team_id <> job.team_id OR alias.job_type <> job.job_type`
  );
  if (Number(scopeMismatch[0]?.count || 0) > 0) {
    throw new Error("智能任务幂等别名与目标任务的团队或任务类型不一致");
  }

  const duplicatePrimary = await rows<{ count: number }>(
    pool,
    `SELECT COUNT(*) AS count
     FROM (
       SELECT team_id, job_type, idempotency_key
       FROM agent_jobs
       GROUP BY team_id, job_type, idempotency_key
       HAVING COUNT(*) > 1
     ) duplicate_keys`
  );
  if (Number(duplicatePrimary[0]?.count || 0) > 0) {
    throw new Error("智能任务主幂等键存在重复绑定");
  }

  const duplicateAlias = await rows<{ count: number }>(
    pool,
    `SELECT COUNT(*) AS count
     FROM (
       SELECT team_id, job_type, idempotency_key
       FROM agent_job_idempotency_aliases
       GROUP BY team_id, job_type, idempotency_key
       HAVING COUNT(*) > 1
     ) duplicate_keys`
  );
  if (Number(duplicateAlias[0]?.count || 0) > 0) {
    throw new Error("智能任务别名幂等键存在重复绑定");
  }

  await pool.query(
    `DELETE alias
     FROM agent_job_idempotency_aliases alias
     INNER JOIN agent_jobs job
       ON job.id = alias.job_id
      AND job.team_id = alias.team_id
      AND job.job_type = alias.job_type
      AND job.idempotency_key = alias.idempotency_key`
  );

  const crossTableConflict = await rows<{ count: number }>(
    pool,
    `SELECT COUNT(*) AS count
     FROM agent_job_idempotency_aliases alias
     INNER JOIN agent_jobs job
       ON job.team_id = alias.team_id
      AND job.job_type = alias.job_type
      AND job.idempotency_key = alias.idempotency_key
     WHERE job.id <> alias.job_id`
  );
  if (Number(crossTableConflict[0]?.count || 0) > 0) {
    throw new Error("智能任务幂等键在主任务与别名之间存在冲突绑定");
  }
}

async function loadUsers(pool: mysql.Pool): Promise<User[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM users")).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    password: row.password_hash,
    role: row.role,
    teamId: row.team_id,
    avatar: row.avatar,
    status: row.status,
    authVersion: Number(row.auth_version || 1),
    outboundEmail: row.outbound_email || "",
    emailSenderName: row.email_sender_name ?? "",
    emailSignature: row.email_signature || "",
    smtpHost: row.smtp_host || "",
    smtpPort: Number(row.smtp_port || 465),
    smtpSecure: row.smtp_secure === undefined || row.smtp_secure === null ? true : Boolean(row.smtp_secure),
    smtpUser: row.smtp_user || "",
    smtpPassword: row.smtp_password || "",
    hasSmtpPassword: Boolean(row.smtp_password),
    lastDevelopmentEmailAt: row.last_development_email_at instanceof Date ? row.last_development_email_at.toISOString() : row.last_development_email_at || "",
    lastDevelopmentEmailTo: row.last_development_email_to || "",
    lastDevelopmentEmailSubject: row.last_development_email_subject || "",
    reportNote: row.report_note || ""
  }));
}

async function loadLeads(pool: mysql.Pool): Promise<Lead[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM leads ORDER BY created_at DESC")).map((row) => ({
    id: row.id, company: row.company, contact: row.contact || "", country: row.country || "", email: row.email || "", phone: row.phone || "", wechat: row.wechat || "", source: row.source || "", sourceType: row.source_type || "outbound", sourceChannel: row.source_channel || "manual", sourceCampaign: row.source_campaign || "", externalId: row.external_id || "", sourceUrl: row.source_url || "", intent: row.intent || "中", stage: row.stage || "新线索", status: (row.status || "new") as Lead["status"], ownerId: row.owner_id, teamId: row.team_id, estimatedAmount: Number(row.estimated_amount || 0), nextFollowAt: row.next_follow_at || "", lastActivityAt: row.last_activity_at || "", remark: row.remark || "", convertedCustomerId: row.converted_customer_id || "", convertedDealId: row.converted_deal_id || "", createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString(), deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at || "", deletedReason: row.deleted_reason || "", deletedBy: row.deleted_by || "", purgeAt: row.purge_at instanceof Date ? row.purge_at.toISOString() : row.purge_at || "", statusBeforeDelete: row.status_before_delete || undefined
  }));
}

async function loadLeadActivities(pool: mysql.Pool): Promise<LeadActivity[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM lead_activities ORDER BY created_at DESC")).map((row) => ({
    id: row.id, leadId: row.lead_id, type: row.type || "note", content: row.content || "", operatorId: row.operator_id || "", nextFollowAt: row.next_follow_at || "", createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadLeadSourceEvents(pool: mysql.Pool): Promise<LeadSourceEvent[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM lead_source_events ORDER BY received_at DESC")).map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    sourceType: row.source_type || "outbound",
    channel: row.channel || "manual",
    campaign: row.campaign || "",
    externalId: row.external_id || "",
    sourceUrl: row.source_url || "",
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    rawPayload: typeof row.raw_payload === "string" ? row.raw_payload : JSON.stringify(row.raw_payload || {}),
    ownerId: row.owner_id,
    teamId: row.team_id
  }));
}

async function loadCustomers(pool: mysql.Pool): Promise<Customer[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM customers ORDER BY created_at DESC"
  )).map(customerFromRow);
}

function customerFromRow(row: Record<string, any>): Customer {
  return {
    id: row.id,
    company: row.company,
    country: row.country,
    contact: row.contact,
    ownerId: row.owner_id || "",
    teamId: row.team_id,
    stage: row.stage,
    amount: Number(row.amount),
    health: Number(row.health),
    grade: ["A", "B", "C", "D"].includes(row.customer_grade) ? row.customer_grade : "C",
    nextReminder: row.next_reminder,
    wecomBound: Boolean(row.wecom_bound),
    billingName: row.billing_name || "",
    billingAddress: row.billing_address || "",
    documentContact: row.document_contact || "",
    defaultPortDischarge: row.default_port_discharge || "",
    defaultIncoterm: row.default_incoterm || "",
    defaultPaymentTerm: row.default_payment_term || "",
    poolStatus: row.pool_status === "public" ? "public" : "owned",
    previousOwnerId: row.previous_owner_id || "",
    releasedBy: row.released_by || "",
    releasedAt: row.released_at instanceof Date
      ? row.released_at.toISOString()
      : row.released_at || "",
    releaseReason: row.release_reason || "",
    claimedAt: row.claimed_at instanceof Date
      ? row.claimed_at.toISOString()
      : row.claimed_at || "",
    ownershipVersion: Number(row.ownership_version || 0)
  };
}

async function loadCustomerOwnershipEvents(
  pool: mysql.Pool
): Promise<CustomerOwnershipEvent[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM customer_ownership_events
     ORDER BY created_at DESC`
  )).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    teamId: row.team_id,
    fromOwnerId: row.from_owner_id || "",
    toOwnerId: row.to_owner_id || "",
    action: row.event_type === "claimed" ? "claimed" : "released",
    reason: row.reason || "",
    operatorId: row.operator_id,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at || ""
  }));
}

async function loadCustomerActivities(pool: mysql.Pool): Promise<CustomerActivity[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM customer_activities ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    type: row.type || "note",
    content: row.content || "",
    operatorId: row.operator_id || "",
    nextReminder: row.next_reminder || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadCustomerAcquisitionSourceEvents(
  pool: mysql.Pool
): Promise<CustomerAcquisitionSourceEvent[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM customer_acquisition_source_events
     ORDER BY created_at DESC`
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    customerId: row.customer_id,
    leadId: row.lead_id,
    leadSourceEventId: row.lead_source_event_id,
    prospectId: row.prospect_id,
    organizationId: row.organization_id,
    sourceChannel: row.source_channel,
    sourceCampaign: row.source_campaign || "",
    sourceUrl: row.source_url || "",
    mode: row.conversion_mode,
    processingKeyHash: row.processing_key_hash,
    requestHash: row.request_hash,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at
  }));
}

async function loadCustomerIntelligenceSuggestions(
  pool: mysql.Pool
): Promise<CustomerIntelligenceSuggestion[]> {
  const jsonArray = (value: unknown) => value
    ? (typeof value === "string" ? JSON.parse(value) : value)
    : [];
  return (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM customer_intelligence_suggestions
     ORDER BY created_at DESC`
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    customerId: row.customer_id,
    prospectCandidateId: row.prospect_candidate_id,
    tenantProspectId: row.tenant_prospect_id || undefined,
    organizationId: row.organization_id || undefined,
    leadId: row.lead_id || undefined,
    sourceEventId: row.source_event_id || undefined,
    sourceLabel: row.source_label || "智能获客",
    sourceUrl: row.source_url || "",
    suggestedFields: jsonArray(row.suggested_fields_json),
    website: row.website || "",
    business: row.business || "",
    contactInfo: row.contact_info || "",
    evidenceSummary: row.evidence_summary || "",
    evidenceRefs: jsonArray(row.evidence_refs_json),
    payloadHash: row.payload_hash,
    status: row.suggestion_status,
    acceptedFields: jsonArray(row.accepted_fields_json),
    reviewedBy: row.reviewed_by || undefined,
    reviewedAt: row.reviewed_at instanceof Date
      ? row.reviewed_at.toISOString()
      : row.reviewed_at || undefined,
    reviewNote: row.review_note || undefined,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at
  }));
}

async function loadTodos(pool: mysql.Pool): Promise<Todo[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM todos ORDER BY done ASC, created_at DESC")).map((row) => ({
    id: row.id, title: row.title, type: row.type, priority: row.priority, status: row.status || "pending", pinState: row.pin_state || "", sortOrder: Number(row.sort_order || 0), dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, related: row.related, done: Boolean(row.done), impactAmount: row.impact_amount == null ? undefined : Number(row.impact_amount), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, historyAt: row.history_at instanceof Date ? row.history_at.toISOString() : row.history_at || undefined,
    customerId: row.customer_id || undefined, dealId: row.deal_id || undefined, reminderRuleId: row.reminder_rule_id || undefined, triggerKey: row.trigger_key || undefined, snoozedFrom: row.snoozed_from || undefined, snoozeReason: row.snooze_reason || undefined, snoozeCount: Number(row.snooze_count || 0), snoozedBy: row.snoozed_by || undefined, completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at || undefined, completedBy: row.completed_by || undefined, completionResult: row.completion_result || undefined,
    leadId: row.lead_id || undefined, prospectCandidateId: row.prospect_candidate_id || undefined, tenantProspectId: row.tenant_prospect_id || undefined, outreachChannel: row.outreach_channel || undefined, touchpointId: row.touchpoint_id || undefined, cancelledAt: row.cancelled_at instanceof Date ? row.cancelled_at.toISOString() : row.cancelled_at || undefined, cancellationReason: row.cancellation_reason || undefined
  }));
}

async function loadProspectTouchpoints(
  pool: mysql.Pool
): Promise<ProspectTouchpoint[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_touchpoints ORDER BY occurred_at DESC, created_at DESC"
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    prospectCandidateId: row.prospect_candidate_id,
    tenantProspectId: row.tenant_prospect_id || undefined,
    organizationId: row.organization_id || undefined,
    leadId: row.lead_id || undefined,
    channel: row.channel,
    direction: row.direction,
    contactValue: row.contact_value || "",
    subject: row.subject || "",
    content: row.content || "",
    replyClassification: row.reply_classification || undefined,
    requestId: row.request_id,
    occurredAt: row.occurred_at instanceof Date
      ? row.occurred_at.toISOString()
      : row.occurred_at,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at
  }));
}

async function loadProcurementSignals(
  pool: mysql.Pool
): Promise<ProcurementSignal[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM procurement_signals ORDER BY observed_at DESC, created_at DESC"
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    prospectCandidateId: row.prospect_candidate_id,
    tenantProspectId: row.tenant_prospect_id || undefined,
    organizationId: row.organization_id || undefined,
    leadId: row.lead_id || undefined,
    customerId: row.customer_id || undefined,
    sourceTouchpointId: row.source_touchpoint_id,
    sourceType: row.source_type,
    evidenceTypes: row.evidence_types_json
      ? (typeof row.evidence_types_json === "string"
        ? JSON.parse(row.evidence_types_json)
        : row.evidence_types_json)
      : [],
    evidenceSummary: row.evidence_summary || "",
    product: row.product || "",
    specification: row.specification || "",
    quantity: Number(row.quantity || 0),
    quantityType: row.quantity_type || "unknown",
    targetPrice: Number(row.target_price || 0),
    currency: row.currency || "USD",
    priceBasis: row.price_basis || "",
    deliveryRequirement: row.delivery_requirement || "",
    certificationRequirement: row.certification_requirement || "",
    purchaseTimeline: row.purchase_timeline || "",
    projectName: row.project_name || "",
    buyerRole: row.buyer_role || "",
    nextAction: row.next_action || "",
    confidence: Number(row.confidence || 0),
    status: row.signal_status,
    observedAt: row.observed_at instanceof Date
      ? row.observed_at.toISOString()
      : row.observed_at,
    validUntil: row.valid_until instanceof Date
      ? row.valid_until.toISOString()
      : row.valid_until,
    dismissedReason: row.dismissed_reason || undefined,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at
  }));
}

async function loadDealRecommendations(
  pool: mysql.Pool
): Promise<DealRecommendation[]> {
  const jsonArray = (value: unknown) => value
    ? (typeof value === "string" ? JSON.parse(value) : value)
    : [];
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM deal_recommendations ORDER BY created_at DESC"
  )).map((row) => ({
    id: row.id,
    signalId: row.signal_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    prospectCandidateId: row.prospect_candidate_id,
    tenantProspectId: row.tenant_prospect_id || undefined,
    organizationId: row.organization_id || undefined,
    leadId: row.lead_id || undefined,
    customerId: row.customer_id || undefined,
    suggestedTitle: row.suggested_title,
    suggestedProduct: row.suggested_product,
    suggestedQuantity: Number(row.suggested_quantity || 0),
    suggestedUnitPrice: Number(row.suggested_unit_price || 0),
    suggestedAmount: Number(row.suggested_amount || 0),
    currency: row.currency || "USD",
    initialStage: "询盘",
    nextAction: row.next_action || "",
    nextActionAt: row.next_action_at || "",
    expectedCloseAt: row.expected_close_at || "",
    reasonCodes: jsonArray(row.reason_codes_json),
    missingFields: jsonArray(row.missing_fields_json),
    evidenceRefs: jsonArray(row.evidence_refs_json),
    recommendationScore: Number(row.recommendation_score || 0),
    duplicateDealIds: jsonArray(row.duplicate_deal_ids_json),
    status: row.recommendation_status,
    reviewedBy: row.reviewed_by || undefined,
    reviewedAt: row.reviewed_at instanceof Date
      ? row.reviewed_at.toISOString()
      : row.reviewed_at || undefined,
    reviewReason: row.review_reason || undefined,
    linkedDealId: row.linked_deal_id || undefined,
    expiresAt: row.expires_at instanceof Date
      ? row.expires_at.toISOString()
      : row.expires_at,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at
  }));
}

async function loadAcquisitionOutcomeFeedback(
  pool: mysql.Pool
): Promise<AcquisitionOutcomeFeedback[]> {
  const jsonArray = (value: unknown) => value
    ? (typeof value === "string" ? JSON.parse(value) : value)
    : [];
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM acquisition_outcome_feedback ORDER BY closed_at DESC"
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    dealId: row.deal_id,
    customerId: row.customer_id,
    leadId: row.lead_id || "",
    prospectCandidateId: row.prospect_candidate_id || "",
    tenantProspectId: row.tenant_prospect_id || "",
    organizationId: row.organization_id || "",
    campaignId: row.campaign_id || "",
    campaignVersion: Number(row.campaign_version || 0),
    strategyId: row.strategy_id || "",
    runId: row.run_id || "",
    providerCodes: jsonArray(row.provider_codes_json),
    icpAssessmentId: row.icp_assessment_id || "",
    icpPolicyId: row.icp_policy_id || "",
    outcome: row.outcome,
    amount: Number(row.amount || 0),
    currency: row.currency || "USD",
    reasonCategory: row.reason_category || "",
    reason: row.reason_text || "",
    closedAt: row.closed_at instanceof Date
      ? row.closed_at.toISOString()
      : row.closed_at,
    attributionConfidence: Number(row.attribution_confidence || 0),
    attributionReasonCodes:
      jsonArray(row.attribution_reason_codes_json),
    payloadHash: row.payload_hash,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at
  }));
}

async function loadProspectStrategySuggestions(
  pool: mysql.Pool
): Promise<ProspectStrategySuggestion[]> {
  const jsonObject = (value: unknown) => value
    ? (typeof value === "string" ? JSON.parse(value) : value)
    : {};
  const jsonArray = (value: unknown) => value
    ? (typeof value === "string" ? JSON.parse(value) : value)
    : [];
  const iso = (value: unknown) => value instanceof Date
    ? value.toISOString()
    : String(value || "");
  return (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_strategy_suggestions
     ORDER BY created_at DESC`
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    campaignVersion: Number(row.campaign_version || 0),
    strategyId: row.strategy_id,
    suggestionType: row.suggestion_type,
    sampleMetrics: jsonObject(row.sample_metrics_json),
    proposedAdjustments: jsonObject(row.proposed_adjustments_json),
    rationale: row.rationale || "",
    reasonCodes: jsonArray(row.reason_codes_json),
    sampleFrom: iso(row.sample_from),
    sampleTo: iso(row.sample_to),
    payloadHash: row.payload_hash,
    status: row.suggestion_status,
    reviewedBy: row.reviewed_by || "",
    reviewedAt: iso(row.reviewed_at),
    reviewNote: row.review_note || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  }));
}

async function loadPlanTasks(pool: mysql.Pool): Promise<PlanTask[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM plan_tasks ORDER BY status = 'done' ASC, updated_at DESC, created_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    phase: row.phase || "计划任务",
    category: row.category || "客户开发",
    priority: row.priority || "normal",
    status: row.status || "planned",
    dueAt: row.due_at || "",
    target: row.target || "",
    description: row.description || "",
    customerId: row.customer_id || "",
    leadId: row.lead_id || "",
    dealId: row.deal_id || "",
    completionResult: row.completion_result || "",
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at || "",
    cancellationReason: row.cancellation_reason || "",
    cancelledAt: row.cancelled_at instanceof Date ? row.cancelled_at.toISOString() : row.cancelled_at || "",
    rescheduledFrom: row.rescheduled_from || "",
    rescheduledAt: row.rescheduled_at instanceof Date ? row.rescheduled_at.toISOString() : row.rescheduled_at || "",
    rescheduleReason: row.reschedule_reason || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadPlanTemplates(pool: mysql.Pool): Promise<PlanTemplate[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM plan_templates ORDER BY sort_order ASC, updated_at DESC")).map((row) => ({
    id: row.id,
    section: row.section_name || "knowledge",
    title: row.title,
    summary: row.summary || "",
    output: row.output_text || "",
    badge: row.badge || "",
    badgeTone: row.badge_tone || "",
    phase: row.phase || "计划任务",
    category: row.category || "客户开发",
    priority: row.priority || "normal",
    target: row.target || "",
    description: row.description || "",
    sortOrder: Number(row.sort_order || 0),
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadDeals(pool: mysql.Pool): Promise<Deal[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM deals")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    title: row.title,
    stage: row.stage,
    product: row.product || "",
    quantity: Number(row.quantity || 0),
    unitPrice: Number(row.unit_price || 0),
    amount: Number(row.amount),
    currency: row.currency || "USD",
    amountType: row.amount_type || (row.stage === "成交" ? "won" : row.stage === "已报价" || row.stage === "样品" || row.stage === "谈判" ? "quoted" : "estimate"),
    ownerId: row.owner_id,
    teamId: row.team_id,
    nextAction: row.next_action || "安排下一步跟进",
    nextActionAt: row.next_action_at || "",
    expectedCloseAt: row.expected_close_at || "",
    stageChangedAt: row.stage_changed_at instanceof Date ? row.stage_changed_at.toISOString() : row.stage_changed_at || new Date().toISOString(),
    closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at || undefined,
    wonReason: row.won_reason || undefined,
    lostReason: row.lost_reason || undefined,
    lostReasonCategory: row.lost_reason_category || undefined,
    revisitAt: row.revisit_at || undefined,
    archivedAt: row.archived_at instanceof Date ? row.archived_at.toISOString() : row.archived_at || undefined
  }));
}

async function loadDealEvents(pool: mysql.Pool): Promise<DealEvent[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM deal_events ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    dealId: row.deal_id,
    type: row.event_type,
    content: row.content || "",
    operatorId: row.operator_id,
    fromStage: row.from_stage || undefined,
    toStage: row.to_stage || undefined,
    nextAction: row.next_action || undefined,
    nextActionAt: row.next_action_at || undefined,
    relatedDocumentId: row.related_document_id || undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadReminders(pool: mysql.Pool): Promise<Reminder[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM reminders")).map((row) => ({
    id: row.id, title: row.title, rule: row.rule_text, dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, channel: "站内", status: row.enabled == null || Boolean(row.enabled) ? "enabled" : "disabled", ruleType: row.rule_type || undefined, targetStage: row.target_stage || undefined, days: row.days_count == null ? undefined : Number(row.days_count), priority: row.priority || "normal", enabled: row.enabled == null ? true : Boolean(row.enabled), generatedCount: Number(row.generated_count || 0), targetOwnerId: row.target_owner_id || row.owner_id, lastRunBy: row.last_run_by || undefined, lastRunAt: row.last_run_at instanceof Date ? row.last_run_at.toISOString() : row.last_run_at || undefined, lastMatchedCount: Number(row.last_matched_count || 0), lastCreatedCount: Number(row.last_created_count || 0), lastSkippedCount: Number(row.last_skipped_count || 0), lastFailedCount: Number(row.last_failed_count || 0), lastError: row.last_error || undefined
  }));
}

async function loadKnowledgeAssets(pool: mysql.Pool): Promise<KnowledgeAsset[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM knowledge_assets ORDER BY created_at DESC")).map((row) => ({
    id: row.id, title: row.title, category: row.category, status: row.status, ownerId: row.owner_id, teamId: row.team_id || "all", version: row.version
  }));
}

async function loadExams(pool: mysql.Pool): Promise<Exam[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exams ORDER BY updated_at DESC, id DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    passRate: Number(row.pass_rate),
    questionCount: Number(row.question_count),
    durationMinutes: Number(row.duration_minutes || 20),
    passScore: Number(row.pass_score || 80),
    targetRole: row.target_role || "sales",
    ownerId: row.owner_id || "",
    teamId: row.team_id || "all",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadExamQuestions(pool: mysql.Pool): Promise<ExamQuestion[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exam_questions ORDER BY updated_at DESC, id DESC")).map((row) => ({
    id: row.id,
    examId: row.exam_id,
    category: row.category,
    stem: row.stem,
    options: typeof row.options_json === "string" ? JSON.parse(row.options_json) : row.options_json,
    answerIndex: Number(row.answer_index),
    answerIndexes: row.answer_indexes_json ? (typeof row.answer_indexes_json === "string" ? JSON.parse(row.answer_indexes_json) : row.answer_indexes_json) : [Number(row.answer_index)],
    questionType: row.question_type || "single",
    tags: row.tags_json ? (typeof row.tags_json === "string" ? JSON.parse(row.tags_json) : row.tags_json) : [],
    explanation: row.explanation || "",
    difficulty: row.difficulty || "medium",
    ownerId: row.owner_id || "",
    teamId: row.team_id || "all",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadExamQuestionLinks(pool: mysql.Pool): Promise<ExamQuestionLink[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exam_question_links ORDER BY exam_id ASC, sort_order ASC")).map((row) => ({
    examId: row.exam_id,
    questionId: row.question_id,
    sortOrder: Number(row.sort_order || 0)
  }));
}

async function loadExamAttempts(pool: mysql.Pool): Promise<ExamAttempt[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exam_attempts ORDER BY submitted_at DESC")).map((row) => ({
    id: row.id,
    examId: row.exam_id,
    userId: row.user_id,
    score: Number(row.score),
    passed: Boolean(row.passed),
    answers: row.answers_json ? (typeof row.answers_json === "string" ? JSON.parse(row.answers_json) : row.answers_json) : {},
    correctCount: Number(row.correct_count || 0),
    totalQuestions: Number(row.total_questions || 0),
    submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at
  }));
}

async function loadImportExportJobs(pool: mysql.Pool): Promise<ImportExportJob[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM import_export_jobs")).map((row) => ({
    id: row.id, name: row.name, type: row.type, rows: Number(row.rows_count), status: row.status, operatorId: row.operator_id, createdAt: row.created_at
  }));
}

async function loadTradeDocuments(pool: mysql.Pool): Promise<TradeDocument[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM trade_documents ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id || "",
    dealId: row.deal_id || "",
    revision: Number(row.revision || 1),
    type: row.doc_type,
    title: row.title,
    number: row.doc_number,
    issueDate: row.issue_date,
    buyer: row.buyer,
    buyerAddress: row.buyer_address,
    buyerContact: row.buyer_contact,
    seller: row.seller,
    sellerAddress: row.seller_address,
    currency: row.currency,
    incoterm: row.incoterm,
    paymentTerm: row.payment_term,
    shippingMethod: row.shipping_method,
    portLoading: row.port_loading,
    portDischarge: row.port_discharge,
    validityDate: row.validity_date,
    bankInfo: row.bank_info,
    notes: row.notes,
    templateStyle: row.template_style || "executive",
    status: row.status || "draft",
    approvalNote: row.approval_note || "",
    approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : row.approved_at || undefined,
    approvedBy: row.approved_by || undefined,
    audits: row.audits_json ? (typeof row.audits_json === "string" ? JSON.parse(row.audits_json) : row.audits_json) : [],
    sendRecords: row.send_records_json ? (typeof row.send_records_json === "string" ? JSON.parse(row.send_records_json) : row.send_records_json) : [],
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    items: row.items_json ? (typeof row.items_json === "string" ? JSON.parse(row.items_json) : row.items_json) : []
  }));
}

async function loadWecomMessages(pool: mysql.Pool): Promise<WecomMessage[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM wecom_messages")).map((row) => ({
    id: row.id, customerId: row.customer_id, summary: row.summary, ownerId: row.owner_id, teamId: row.team_id, status: row.status
  }));
}

async function loadOcrJobs(pool: mysql.Pool): Promise<OcrJob[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM ocr_jobs")).map((row) => ({
    id: row.id,
    status: row.status,
    confidence: Number(row.confidence),
    fields: typeof row.fields_json === "string" ? JSON.parse(row.fields_json) : row.fields_json,
    ownerId: row.owner_id || row.created_by || "",
    teamId: row.team_id || ""
  }));
}

async function loadWebsiteOpportunities(pool: MysqlQuerySource): Promise<WebsiteOpportunity[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM website_opportunities ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    company: row.company,
    business: row.business,
    country: row.country,
    website: row.website,
    contact: row.contact,
    contactInfo: row.contact_info,
    description: row.description,
    ownerId: row.owner_id,
    teamId: row.team_id,
    status: row.status,
    customerId: row.customer_id || undefined,
    dealId: row.deal_id || undefined,
    leadId: row.lead_id || undefined,
    parseMode: row.parse_mode || "rule",
    source: row.source || undefined,
    sourceLabel: row.source_label || undefined,
    sourceEvidence: row.source_evidence_json
      ? (typeof row.source_evidence_json === "string" ? JSON.parse(row.source_evidence_json) : row.source_evidence_json)
      : [],
    verificationReport: row.verification_report_json
      ? (typeof row.verification_report_json === "string"
        ? JSON.parse(row.verification_report_json)
        : row.verification_report_json)
      : undefined,
    confidence: row.confidence === undefined || row.confidence === null ? undefined : Number(row.confidence),
    lastDevelopmentEmailAt: row.last_development_email_at instanceof Date ? row.last_development_email_at.toISOString() : row.last_development_email_at || "",
    lastDevelopmentEmailSubject: row.last_development_email_subject || "",
    lastDevelopmentEmailTo: row.last_development_email_to || "",
    verifiedAt: row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at || "",
    statusChangedAt: row.status_changed_at instanceof Date ? row.status_changed_at.toISOString() : row.status_changed_at || "",
    excludedReason: row.excluded_reason || "",
    tenantProspectId: row.tenant_prospect_id || undefined,
    organizationId: row.organization_id || undefined,
    coverageClassification: row.coverage_classification || undefined,
    coverageQueueState: row.coverage_queue_state || undefined,
    coverageReasonCode: row.coverage_reason_code || "",
    lastTouchpointAt: row.last_touchpoint_at instanceof Date ? row.last_touchpoint_at.toISOString() : row.last_touchpoint_at || "",
    lastTouchpointChannel: row.last_touchpoint_channel || undefined,
    lastReplyClassification: row.last_reply_classification || undefined,
    nextFollowAt: row.next_follow_at || "",
    outreachState: row.outreach_state || "uncontacted",
    invalidContactChannels: row.invalid_contact_channels_json
      ? (typeof row.invalid_contact_channels_json === "string"
        ? JSON.parse(row.invalid_contact_channels_json)
        : row.invalid_contact_channels_json)
      : [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadProspectCandidateProcessingStates(
  pool: MysqlQuerySource
): Promise<ProspectCandidateProcessingState[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_candidate_processing
     ORDER BY processed_at, hit_id`
  )).map((row) => ({
    hitId: row.hit_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    ledgerId: row.ledger_id,
    status: row.processing_status,
    failureCode: row.failure_code || "",
    candidateId: row.candidate_id || undefined,
    processedAt: mysqlIsoDate(row.processed_at),
    updatedAt: mysqlIsoDate(row.updated_at)
  }));
}

async function loadAiModelConfigs(
  pool: MysqlQuerySource
): Promise<AiModelConfig[]> {
  const storedRows = await rows<Record<string, any>>(pool, "SELECT * FROM ai_model_configs ORDER BY updated_at DESC");
  const configs: AiModelConfig[] = [];
  for (const row of storedRows) {
    const provider = row.provider || "openai";
    const context = {
      id: row.id,
      provider,
      ownerId: row.owner_id,
      teamId: row.team_id
    };
    const storedApiKey = row.api_key || "";
    const apiKey = storedApiKey && isEncryptedAiModelApiKey(storedApiKey)
      ? decryptAiModelApiKey(context, storedApiKey)
      : storedApiKey;
    if (storedApiKey && !isEncryptedAiModelApiKey(storedApiKey)) {
      await pool.query(
        "UPDATE ai_model_configs SET api_key = ? WHERE id = ?",
        [encryptAiModelApiKey(context, storedApiKey), row.id]
      );
    }
    configs.push({
      id: row.id,
      provider,
      protocol: row.protocol || (provider === "anthropic" ? "anthropic" : provider === "gemini" ? "gemini" : "openai-compatible"),
      name: row.name,
      baseUrl: row.base_url,
      model: row.model,
      apiKey,
      enabled: Boolean(row.enabled),
      temperature: Number(row.temperature ?? 0.1),
      useLeadFinder: row.use_lead_finder === undefined || row.use_lead_finder === null ? true : Boolean(row.use_lead_finder),
      useWebsiteParse: row.use_website_parse === undefined || row.use_website_parse === null ? true : Boolean(row.use_website_parse),
      useScoring: row.use_scoring === undefined || row.use_scoring === null ? true : Boolean(row.use_scoring),
      useEmailDraft: row.use_email_draft === undefined || row.use_email_draft === null ? true : Boolean(row.use_email_draft),
      useExam: Boolean(row.use_exam),
      lastTestAt: row.last_test_at instanceof Date ? row.last_test_at.toISOString() : row.last_test_at || undefined,
      lastTestStatus: row.last_test_status || "untested",
      lastTestMessage: row.last_test_message || "",
      ownerId: row.owner_id,
      teamId: row.team_id,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    });
  }
  return configs;
}

async function loadLeadSourceConfigs(pool: mysql.Pool): Promise<LeadSourceConfig[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM lead_source_configs ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    provider: row.provider,
    scope: row.scope === "team" ? "team" : "personal",
    apiKey: row.api_key || "",
    baseUrl: row.base_url || "",
    enabled: Boolean(row.enabled),
    lastTestAt: row.last_test_at instanceof Date ? row.last_test_at.toISOString() : row.last_test_at || undefined,
    lastTestStatus: row.last_test_status || "untested",
    lastTestMessage: row.last_test_message || "",
    usageJson: row.usage_json || undefined,
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadProviderCatalog(
  pool: MysqlQuerySource
): Promise<ProviderCatalogItem[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM provider_catalog ORDER BY created_at ASC, code ASC")).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    sourceLevel: row.source_level,
    accessMode: row.access_mode,
    baseUrl: row.base_url || "",
    officialDocsUrl: row.official_docs_url || "",
    capabilities: typeof row.capability_json === "string" ? JSON.parse(row.capability_json) : row.capability_json || [],
    allowedFields: typeof row.allowed_fields_json === "string" ? JSON.parse(row.allowed_fields_json) : row.allowed_fields_json || [],
    licensePolicy: typeof row.license_policy_json === "string" ? JSON.parse(row.license_policy_json) : row.license_policy_json || {},
    defaultRatePolicy: typeof row.default_rate_policy_json === "string" ? JSON.parse(row.default_rate_policy_json) : row.default_rate_policy_json || {},
    retentionPolicy: typeof row.retention_policy_json === "string" ? JSON.parse(row.retention_policy_json) : row.retention_policy_json || {},
    status: row.status,
    version: row.version || "1.0",
    reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadProviderConnections(
  pool: MysqlQuerySource
): Promise<ProviderConnection[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM provider_connections ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    scope: row.scope === "team" || row.scope === "platform" ? row.scope : "personal",
    credentialRef: row.credential_ref,
    configurationEncrypted: row.configuration_encrypted,
    status: row.status === "active" || row.status === "error" ? row.status : "disabled",
    quotaPolicy: typeof row.quota_policy_json === "string" ? JSON.parse(row.quota_policy_json) : row.quota_policy_json || {},
    budgetPolicy: typeof row.budget_policy_json === "string" ? JSON.parse(row.budget_policy_json) : row.budget_policy_json || {},
    lastHealthAt: row.last_health_at instanceof Date ? row.last_health_at.toISOString() : row.last_health_at || "",
    lastHealthStatus: row.last_health_status === "passed" || row.last_health_status === "failed" ? row.last_health_status : "untested",
    lastErrorCode: row.last_error_code || "",
    lastHealthMessage: row.last_health_message || "",
    usage: row.usage_text || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadProviderRequestLogs(
  pool: MysqlQuerySource
): Promise<ProviderRequestLog[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM provider_request_logs ORDER BY requested_at DESC")).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    providerId: row.provider_id,
    connectionId: row.connection_id || "",
    runId: row.run_id,
    runShardId: row.run_shard_id,
    requestFingerprint: row.request_fingerprint,
    endpointCode: row.endpoint_code,
    httpStatus: Number(row.http_status || 0),
    attempt: Number(row.attempt || 1),
    quotaUnits: Number(row.quota_units || 0),
    costAmount: Number(row.cost_amount || 0),
    currency: row.currency || "",
    durationMs: Number(row.duration_ms || 0),
    responseSize: Number(row.response_size || 0),
    errorCode: row.error_code || "",
    requestedAt: row.requested_at instanceof Date ? row.requested_at.toISOString() : row.requested_at
  }));
}

async function loadProviderResponseCache(pool: mysql.Pool): Promise<ProviderResponseCache[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM provider_response_cache ORDER BY fetched_at DESC"
  )).map((row) => ({
    id: row.id,
    providerId: row.provider_id,
    providerVersion: row.provider_version,
    requestFingerprint: row.request_fingerprint,
    payloadEncrypted: row.payload_encrypted,
    payloadHash: row.payload_hash,
    fetchedAt: row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    licenseScope: row.license_scope,
    status: row.status === "invalid" ? "invalid" : "active"
  }));
}

async function loadMarketTradeObservations(pool: mysql.Pool): Promise<MarketTradeObservation[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM market_trade_observations ORDER BY observed_at DESC"
  )).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    providerId: row.provider_id,
    reporterCountry: row.reporter_country,
    partnerCountry: row.partner_country,
    reporterCode: row.reporter_code || "",
    partnerCode: row.partner_code || "",
    tradeFlow: row.trade_flow === "EXPORT" ? "EXPORT" : "IMPORT",
    classification: row.classification,
    commodityCode: row.commodity_code,
    commodityDescription: row.commodity_description || "",
    period: row.period_value,
    tradeValueUsd: row.trade_value_usd === null ? null : Number(row.trade_value_usd),
    netWeightKg: row.net_weight_kg === null ? null : Number(row.net_weight_kg),
    quantity: row.quantity_value === null ? null : Number(row.quantity_value),
    quantityUnit: row.quantity_unit || "",
    isAggregate: Boolean(row.is_aggregate),
    suppressed: Boolean(row.suppressed),
    statusFlags: typeof row.status_flags_json === "string"
      ? JSON.parse(row.status_flags_json)
      : row.status_flags_json || [],
    rawRecordId: row.raw_record_id,
    payloadHash: row.payload_hash,
    adapterVersion: row.adapter_version,
    sourceRevision: row.source_revision || "",
    observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

const marketOpportunityStatusSchema = z.enum([
  "metrics_ready",
  "partial",
  "insufficient_data"
]);
const marketOpportunitySnapshotStatusSchema = z.enum([
  "metrics_ready",
  "insufficient_data"
]);
const marketOpportunityEvidencePersistenceSchema = z.object({
  observationId: z.string().min(1).max(80),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  providerId: z.literal("un_comtrade"),
  adapterVersion: z.string().min(1).max(40),
  sourceRevision: z.string().max(120),
  period: z.string().regex(/^\d{4}$/),
  reporterCountry: z.string().min(1).max(100),
  reporterCode: z.string().min(1).max(16),
  partnerCountry: z.string().min(1).max(100),
  partnerCode: z.string().max(16),
  tradeFlow: z.literal("IMPORT"),
  classification: z.string().min(1).max(40),
  commodityCode: z.string().min(1).max(32),
  tradeValueUsd: z.number().finite().nonnegative().nullable(),
  suppressed: z.boolean(),
  statusFlags: z.array(z.string().max(80))
}).strict();
const marketOpportunityMetricsPersistenceSchema = z.object({
  metricVersion: z.literal("market_opportunity_facts_v1"),
  reportedImportValueSeries: z.array(z.object({
    period: z.string().regex(/^\d{4}$/),
    tradeValueUsd: z.number().finite().nonnegative(),
    evidence: marketOpportunityEvidencePersistenceSchema
  }).strict()).max(3),
  yoyChanges: z.array(z.object({
    fromPeriod: z.string().regex(/^\d{4}$/),
    toPeriod: z.string().regex(/^\d{4}$/),
    value: z.number().finite().nullable(),
    reason: z.string().max(80)
  }).strict()).max(2),
  twoYearCagr: z.number().finite().nullable(),
  twoYearCagrReason: z.string().max(80),
  chinaMainlandSupplyShare: z.number().finite().min(0).max(1).nullable(),
  chinaMainlandSupplyShareReason: z.string().max(80),
  chinaMainlandEvidence: marketOpportunityEvidencePersistenceSchema.nullable()
}).strict();
const marketOpportunityBatchPersistenceSchema = z.object({
  id: z.string().min(1).max(80),
  teamId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  campaignId: z.string().min(1).max(80),
  providerId: z.literal("un_comtrade"),
  datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  policyVersion: z.literal("market_opportunity_facts_v1"),
  status: marketOpportunityStatusSchema,
  emptyReason: z.enum([
    "",
    "no_eligible_observations",
    "missing_world_series",
    "non_contiguous_three_year_series",
    "all_candidates_insufficient"
  ]),
  candidateCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  comparisonPeriods: z.array(z.string().regex(/^\d{4}$/)),
  firstTriggerJobId: z.string().min(1).max(80),
  observationCutoffAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
}).strict();
const marketOpportunitySnapshotPersistenceSchema = z.object({
  id: z.string().min(1).max(80),
  batchId: z.string().min(1).max(80),
  teamId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  campaignId: z.string().min(1).max(80),
  providerId: z.literal("un_comtrade"),
  reporterCountry: z.string().min(1).max(100),
  reporterCode: z.string().min(1).max(16),
  classification: z.string().min(1).max(40),
  commodityCode: z.string().min(1).max(32),
  commodityDescription: z.string().max(500),
  comparisonPeriod: z.union([z.literal(""), z.string().regex(/^\d{4}$/)]),
  snapshotStatus: marketOpportunitySnapshotStatusSchema,
  insufficiencyReasons: z.array(z.string().min(1).max(120)),
  metrics: marketOpportunityMetricsPersistenceSchema,
  marketScore: z.null(),
  growthScore: z.null(),
  chinaSupplyScore: z.null(),
  createdAt: z.string().datetime()
}).strict();
const marketOpportunityCalculationPersistenceSchema = z.object({
  id: z.string().min(1).max(80),
  teamId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  campaignId: z.string().min(1).max(80),
  triggerJobId: z.string().min(1).max(80),
  batchId: z.string().min(1).max(80),
  datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  policyVersion: z.literal("market_opportunity_facts_v1"),
  outcome: marketOpportunityStatusSchema,
  reusedBatch: z.boolean(),
  sequence: z.number().int().positive(),
  calculatedAt: z.string().datetime()
}).strict();

type MysqlQuerySource = Pick<mysql.Pool, "query">;

function mysqlIsoDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value || "");
}

function mysqlJson(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

const prospectCampaignStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "archived"
]);
const uuidV4Pattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const prospectCampaignIdPersistenceSchema = z.string().regex(
  new RegExp(`^pc_${uuidV4Pattern}$`, "i")
);
const prospectCampaignPersistenceSchema = z.object({
  id: prospectCampaignIdPersistenceSchema,
  teamId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  status: prospectCampaignStatusSchema,
  currentVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdBy: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.union([z.literal(""), z.string().datetime()])
}).strict();
const prospectCampaignVersionPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^pcv_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  version: z.number().int().positive(),
  snapshot: z.object({
    goal: z.string().max(1000),
    products: z.array(z.string().min(1).max(200)).max(100),
    markets: z.array(z.string().min(1).max(200)).max(100),
    customerTypes: z.array(z.string().min(1).max(200)).max(100),
    applicationScenarios: z.array(z.string().min(1).max(200)).max(100),
    icpRules: z.array(z.string().min(1).max(200)).max(100),
    exclusionRules: z.array(z.string().min(1).max(200)).max(100),
    sourceProviderIds: z.array(
      z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/)
    ).max(100)
  }).strict(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  changeSummary: z.string().max(500),
  createdBy: z.string().min(1).max(64),
  createdAt: z.string().datetime()
}).strict();
const prospectCampaignEventPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^pce_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  eventType: z.enum([
    "created",
    "updated",
    "owner_transferred",
    "strategy_created",
    "version_created",
    "status_changed"
  ]),
  actorId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(100),
  fromStatus: z.union([z.literal(""), prospectCampaignStatusSchema]),
  toStatus: z.union([z.literal(""), prospectCampaignStatusSchema]),
  fromOwnerId: z.string().max(64),
  toOwnerId: z.string().max(64),
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  reason: z.string().max(500),
  createdAt: z.string().datetime()
}).strict();
const prospectStrategyQueryPersistenceSchema = z.object({
  keywordMode: z.enum(["campaign_products", "specific"]),
  positiveKeywords: z.array(z.string().min(1).max(200)).max(100),
  synonyms: z.array(z.string().min(1).max(200)).max(100),
  industryTerms: z.array(z.string().min(1).max(200)).max(100),
  purchaseScenarioTerms: z.array(z.string().min(1).max(200)).max(100),
  countryMode: z.enum(["campaign_markets", "global", "specific"]),
  countries: z.array(z.string().min(1).max(200)).max(100),
  languages: z.array(z.string().min(1).max(200)).max(100),
  customerTypeMode: z.enum(["campaign_customer_types", "all", "specific"]),
  customerTypes: z.array(z.string().min(1).max(200)).max(100),
  exclusionKeywords: z.array(z.string().min(1).max(200)).max(100),
  exclusionDomains: z.array(z.string().min(1).max(253)).max(100),
  timeWindow: z.object({
    mode: z.enum(["all", "fixed"]),
    from: z.string().max(10),
    to: z.string().max(10)
  }).strict()
}).strict();
const prospectStrategyProviderPlanPersistenceSchema = z.array(z.object({
  providerId: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  priority: z.number().int().min(1).max(100),
  pageLimit: z.number().int().min(1).max(100),
  resultLimit: z.number().int().min(1).max(1000),
  budgetLimit: z.number().finite().min(0).max(1_000_000).nullable(),
  currency: z.union([z.literal(""), z.string().regex(/^[A-Z]{3}$/)])
}).strict()).max(30);
const prospectStrategyStatusSchema = z.enum(["draft", "approved", "disabled"]);
const prospectStrategyPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^ps_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  campaignVersion: z.number().int().positive(),
  name: z.string().min(1).max(160),
  status: prospectStrategyStatusSchema,
  revision: z.number().int().positive(),
  query: prospectStrategyQueryPersistenceSchema,
  providerPlan: prospectStrategyProviderPlanPersistenceSchema,
  queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprintVersion: z.literal("v1"),
  ownerId: z.string().min(1).max(64),
  createdBy: z.string().min(1).max(64),
  approvedBy: z.string().max(64),
  approvedAt: z.union([z.literal(""), z.string().datetime()]),
  disabledBy: z.string().max(64),
  disabledAt: z.union([z.literal(""), z.string().datetime()]),
  disableReason: z.string().max(500),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
const prospectStrategyEventPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^pse_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  strategyId: z.string().regex(new RegExp(`^ps_${uuidV4Pattern}$`, "i")),
  eventType: z.enum([
    "created",
    "updated",
    "approved",
    "disabled",
    "owner_transferred"
  ]),
  actorId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(100),
  fromStatus: z.union([z.literal(""), prospectStrategyStatusSchema]),
  toStatus: prospectStrategyStatusSchema,
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().positive(),
  reason: z.string().max(500),
  createdAt: z.string().datetime()
}).strict();
const prospectSchedulePersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^psc_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  campaignVersion: z.number().int().positive(),
  strategyId: z.string().regex(new RegExp(`^ps_${uuidV4Pattern}$`, "i")),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  status: z.enum(["active", "paused"]),
  timezone: z.string().min(1).max(100),
  nextRunAt: z.string().datetime(),
  lastRunAt: z.union([z.literal(""), z.string().datetime()]),
  lastRunId: z.union([
    z.literal(""),
    z.string().regex(new RegExp(`^pr_${uuidV4Pattern}$`, "i"))
  ]),
  lastPlannedAt: z.union([z.literal(""), z.string().datetime()]),
  lastFailureCode: z.string().max(100),
  lastFailureReason: z.string().max(500),
  recurringCostApproved: z.boolean(),
  revision: z.number().int().positive(),
  createdBy: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
const prospectSearchRunStatusPersistenceSchema = z.enum([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed"
]);
const prospectRunShardStatusPersistenceSchema = z.enum([
  "queued",
  "running",
  "retry_scheduled",
  "pause_requested",
  "paused",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed"
]);
const providerAccessModePersistenceSchema = z.enum([
  "api",
  "bulk_file",
  "website_controlled",
  "manual_assisted",
  "disabled"
]);
const prospectResolvedQueryPersistenceSchema = z.object({
  positiveKeywords: z.array(z.string().min(1).max(200)).max(100),
  synonyms: z.array(z.string().min(1).max(200)).max(100),
  industryTerms: z.array(z.string().min(1).max(200)).max(100),
  purchaseScenarioTerms: z.array(z.string().min(1).max(200)).max(100),
  countries: z.array(z.string().min(1).max(200)).max(100),
  languages: z.array(z.string().min(1).max(200)).max(100),
  customerTypes: z.array(z.string().min(1).max(200)).max(100),
  exclusionKeywords: z.array(z.string().min(1).max(200)).max(100),
  exclusionDomains: z.array(z.string().min(1).max(253)).max(100),
  timeWindow: z.object({
    mode: z.enum(["all", "fixed"]),
    from: z.string().max(10),
    to: z.string().max(10)
  }).strict()
}).strict();
const prospectRunProviderSnapshotPersistenceSchema = z.object({
  providerCode: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  position: z.number().int().min(1).max(30),
  priority: z.number().int().min(1).max(100),
  pageLimit: z.number().int().min(1).max(100),
  resultLimit: z.number().int().min(1).max(1000),
  budgetLimit: z.number().finite().min(0).max(1_000_000).nullable(),
  currency: z.union([z.literal(""), z.string().regex(/^[A-Z]{3}$/)]),
  adapterVersion: z.string().min(1).max(80),
  contractVersion: z.string().min(1).max(80),
  catalogVersion: z.string().min(1).max(80),
  capabilities: z.array(z.string().min(1).max(100)).max(100),
  accessMode: providerAccessModePersistenceSchema
}).strict();
const prospectRunExecutionSnapshotPersistenceSchema = z.object({
  contractVersion: z.literal("search_run_control_plane_v1"),
  campaign: z.object({
    id: prospectCampaignIdPersistenceSchema,
    name: z.string().min(1).max(160),
    version: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot: prospectCampaignVersionPersistenceSchema.shape.snapshot
  }).strict(),
  strategy: z.object({
    id: prospectStrategyPersistenceSchema.shape.id,
    name: z.string().min(1).max(160),
    revision: z.number().int().positive(),
    fingerprintVersion: z.literal("v1"),
    queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    query: prospectStrategyQueryPersistenceSchema
  }).strict(),
  resolvedQuery: prospectResolvedQueryPersistenceSchema,
  providerPlan: z.array(
    prospectRunProviderSnapshotPersistenceSchema
  ).min(1).max(30)
}).strict();
const prospectSearchRunPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^pr_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  campaignVersion: z.number().int().positive(),
  strategyId: prospectStrategyPersistenceSchema.shape.id,
  ownerId: z.string().min(1).max(64),
  status: prospectSearchRunStatusPersistenceSchema,
  revision: z.number().int().positive(),
  executionEpoch: z.number().int().positive(),
  operationCode: z.literal("create_search_run_v1"),
  idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  executionSnapshot: prospectRunExecutionSnapshotPersistenceSchema,
  executionSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  queueBridgeVersion: z.literal("v1").nullable(),
  parentRunId: z.literal(""),
  createdBy: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  pausedAt: z.union([z.literal(""), z.string().datetime()]),
  cancelledAt: z.union([z.literal(""), z.string().datetime()])
}).strict();
const prospectRunShardPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^prsh_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  runId: prospectSearchRunPersistenceSchema.shape.id,
  providerCode: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  position: z.number().int().min(1).max(30),
  status: prospectRunShardStatusPersistenceSchema,
  pageLimit: z.number().int().min(1).max(100),
  resultLimit: z.number().int().min(1).max(1000),
  budgetLimit: z.number().finite().min(0).max(1_000_000).nullable(),
  currency: z.union([z.literal(""), z.string().regex(/^[A-Z]{3}$/)]),
  adapterVersion: z.string().min(1).max(80),
  contractVersion: z.string().min(1).max(80),
  catalogVersion: z.string().min(1).max(80),
  capabilities: z.array(z.string().min(1).max(100)).max(100),
  accessMode: providerAccessModePersistenceSchema,
  hasCursor: z.literal(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
const prospectRunEventPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^pre_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  runId: prospectSearchRunPersistenceSchema.shape.id,
  sequence: z.number().int().positive(),
  eventType: z.enum([
    "created",
    "started",
    "pause_requested",
    "paused",
    "resumed",
    "cancel_requested",
    "cancelled",
    "completed",
    "failed"
  ]),
  actorId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(100),
  fromStatus: z.union([
    z.literal(""),
    prospectSearchRunStatusPersistenceSchema
  ]),
  toStatus: prospectSearchRunStatusPersistenceSchema,
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().positive(),
  reason: z.string().max(500),
  createdAt: z.string().datetime()
}).strict();
const prospectRunQueueParentBindingPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^prqpb_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  runId: prospectSearchRunPersistenceSchema.shape.id,
  ownerId: z.string().min(1).max(64),
  jobId: z.string().regex(new RegExp(`^aj_${uuidV4Pattern}$`, "i")),
  jobType: z.literal("prospect.orchestrate"),
  parentJobId: z.literal(""),
  bridgeVersion: z.literal("v1"),
  executionSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
}).strict();
const prospectRunQueueChildBindingPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^prqcb_${uuidV4Pattern}$`, "i")),
  teamId: z.string().min(1).max(64),
  runId: prospectSearchRunPersistenceSchema.shape.id,
  shardId: prospectRunShardPersistenceSchema.shape.id,
  ownerId: z.string().min(1).max(64),
  jobId: z.string().regex(new RegExp(`^aj_${uuidV4Pattern}$`, "i")),
  jobType: z.literal("prospect.provider.fetch"),
  parentJobId: z.string().regex(new RegExp(`^aj_${uuidV4Pattern}$`, "i")),
  bridgeVersion: z.literal("v1"),
  executionSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
}).strict();
const prospectStrategySourcePositionPersistenceSchema = z.object({
  id: z.string().regex(new RegExp(`^pssp_${uuidV4Pattern}$`, "i")),
  identityHash: z.string().regex(/^[a-f0-9]{64}$/),
  teamId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  campaignId: prospectCampaignIdPersistenceSchema,
  campaignVersion: z.number().int().positive(),
  strategyId: prospectStrategyPersistenceSchema.shape.id,
  providerCode: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  connectionId: z.string().min(1).max(100),
  endpointCode: z.string().min(1).max(100),
  adapterVersion: z.string().min(1).max(100),
  contractVersion: z.string().min(1).max(100),
  catalogVersion: z.string().min(1).max(100),
  timeWindowMode: z.enum(["all", "fixed"]),
  timeWindowFrom: z.string().max(10),
  timeWindowTo: z.string().max(10),
  status: z.enum(["continuable", "exhausted"]),
  encryptedCursor: z.string(),
  cursorHash: z.string(),
  sourceRunId: prospectSearchRunPersistenceSchema.shape.id,
  sourceShardId: prospectRunShardPersistenceSchema.shape.id,
  sourcePageId: z.string().regex(new RegExp(`^pexpg_${uuidV4Pattern}$`, "i")),
  sourceCheckpointNo: z.number().int().positive(),
  sourcePageSequence: z.number().int().positive(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((position, context) => {
  const hasEncryptedCursor = Boolean(position.encryptedCursor);
  const hasCursorHash = /^[a-f0-9]{64}$/.test(position.cursorHash);
  if (position.status === "continuable"
    ? !hasEncryptedCursor || !hasCursorHash
    : hasEncryptedCursor || Boolean(position.cursorHash)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "续搜位置状态与游标密文不一致"
    });
  }
  if (position.status === "continuable"
    && !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      position.encryptedCursor
    )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "续搜位置游标密文格式无效"
    });
  }
  if (position.timeWindowMode === "all"
    ? Boolean(position.timeWindowFrom || position.timeWindowTo)
    : !position.timeWindowFrom || !position.timeWindowTo) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "续搜位置时间窗口无效"
    });
  }
});

function parseProspectCampaignPersistence<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label}持久化校验失败`, { cause: parsed.error });
  }
  return parsed.data;
}

async function loadProspectCampaigns(
  pool: MysqlQuerySource
): Promise<ProspectCampaign[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_campaigns ORDER BY updated_at DESC"
  )).map((row) => parseProspectCampaignPersistence(
    prospectCampaignPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      ownerId: row.owner_id,
      name: row.name,
      status: row.status,
      currentVersion: Number(row.current_version),
      revision: Number(row.revision_no),
      createdBy: row.created_by,
      createdAt: mysqlIsoDate(row.created_at),
      updatedAt: mysqlIsoDate(row.updated_at),
      archivedAt: row.archived_at ? mysqlIsoDate(row.archived_at) : ""
    },
    "获客项目"
  ));
}

async function loadProspectCampaignVersions(
  pool: MysqlQuerySource
): Promise<ProspectCampaignVersion[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_campaign_versions ORDER BY version_no DESC"
  )).map((row) => {
    const snapshot = normalizeProspectCampaignSnapshot(
      mysqlJson(row.snapshot_json)
    );
    return parseProspectCampaignPersistence(
      prospectCampaignVersionPersistenceSchema,
      {
        id: row.id,
        teamId: row.team_id,
        campaignId: row.campaign_id,
        version: Number(row.version_no),
        snapshot,
        contentHash: row.content_hash,
        changeSummary: row.change_summary || "",
        createdBy: row.created_by,
        createdAt: mysqlIsoDate(row.created_at)
      },
      "获客项目版本"
    );
  });
}

async function loadProspectCampaignEvents(
  pool: MysqlQuerySource
): Promise<ProspectCampaignEvent[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_campaign_events ORDER BY created_at DESC, id DESC"
  )).map((row) => parseProspectCampaignPersistence(
    prospectCampaignEventPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      campaignId: row.campaign_id,
      eventType: row.event_type,
      actorId: row.actor_id,
      requestId: row.request_id,
      fromStatus: row.from_status || "",
      toStatus: row.to_status || "",
      fromOwnerId: row.from_owner_id || "",
      toOwnerId: row.to_owner_id || "",
      fromVersion: Number(row.from_version || 0),
      toVersion: Number(row.to_version || 0),
      revision: Number(row.revision_no),
      reason: row.reason || "",
      createdAt: mysqlIsoDate(row.created_at)
    },
    "获客项目审计事件"
  ));
}

async function loadProspectStrategies(
  pool: MysqlQuerySource
): Promise<ProspectStrategy[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_strategies ORDER BY updated_at DESC, id DESC"
  )).map((row) => {
    const query = normalizeProspectStrategyQuery(mysqlJson(row.query_json));
    const providerPlan = normalizeProspectStrategyProviderPlan(
      mysqlJson(row.provider_plan_json)
    );
    return parseProspectCampaignPersistence(
      prospectStrategyPersistenceSchema,
      {
        id: row.id,
        teamId: row.team_id,
        campaignId: row.campaign_id,
        campaignVersion: Number(row.campaign_version),
        name: row.name,
        status: row.status,
        revision: Number(row.revision_no),
        query,
        providerPlan,
        queryFingerprint: row.query_fingerprint,
        fingerprintVersion: row.fingerprint_version,
        ownerId: row.owner_id,
        createdBy: row.created_by,
        approvedBy: row.approved_by || "",
        approvedAt: row.approved_at ? mysqlIsoDate(row.approved_at) : "",
        disabledBy: row.disabled_by || "",
        disabledAt: row.disabled_at ? mysqlIsoDate(row.disabled_at) : "",
        disableReason: row.disable_reason || "",
        createdAt: mysqlIsoDate(row.created_at),
        updatedAt: mysqlIsoDate(row.updated_at)
      },
      "获客搜索策略"
    );
  });
}

async function loadProspectStrategyEvents(
  pool: MysqlQuerySource
): Promise<ProspectStrategyEvent[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_strategy_events ORDER BY created_at DESC, id DESC"
  )).map((row) => parseProspectCampaignPersistence(
    prospectStrategyEventPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      campaignId: row.campaign_id,
      strategyId: row.strategy_id,
      eventType: row.event_type,
      actorId: row.actor_id,
      requestId: row.request_id,
      fromStatus: row.from_status || "",
      toStatus: row.to_status,
      fromRevision: Number(row.from_revision),
      toRevision: Number(row.to_revision),
      reason: row.reason || "",
      createdAt: mysqlIsoDate(row.created_at)
    },
    "获客搜索策略审计事件"
  ));
}

async function loadProspectSchedules(
  pool: MysqlQuerySource
): Promise<ProspectSchedule[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM prospect_schedules ORDER BY next_run_at ASC, id ASC"
  )).map((row) => parseProspectCampaignPersistence(
    prospectSchedulePersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      ownerId: row.owner_id,
      campaignId: row.campaign_id,
      campaignVersion: Number(row.campaign_version),
      strategyId: row.strategy_id,
      frequency: row.frequency,
      status: row.status,
      timezone: row.timezone,
      nextRunAt: mysqlIsoDate(row.next_run_at),
      lastRunAt: row.last_run_at ? mysqlIsoDate(row.last_run_at) : "",
      lastRunId: row.last_run_id || "",
      lastPlannedAt: row.last_planned_at
        ? mysqlIsoDate(row.last_planned_at)
        : "",
      lastFailureCode: row.last_failure_code || "",
      lastFailureReason: row.last_failure_reason || "",
      recurringCostApproved: Boolean(row.recurring_cost_approved),
      revision: Number(row.revision_no),
      createdBy: row.created_by,
      createdAt: mysqlIsoDate(row.created_at),
      updatedAt: mysqlIsoDate(row.updated_at)
    },
    "定时获客计划"
  ));
}

async function loadProspectSearchRuns(
  pool: MysqlQuerySource
): Promise<ProspectSearchRun[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT *
     FROM prospect_search_runs
     ORDER BY created_at DESC, id DESC`
  )).map((row) => parseProspectCampaignPersistence(
    prospectSearchRunPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      campaignId: row.campaign_id,
      campaignVersion: Number(row.campaign_version),
      strategyId: row.strategy_id,
      ownerId: row.owner_id,
      status: row.status,
      revision: Number(row.revision_no),
      executionEpoch: Number(row.execution_epoch || 1),
      operationCode: row.operation_code,
      idempotencyKeyHash: row.idempotency_key_hash,
      requestHash: row.request_hash,
      queryFingerprint: row.query_fingerprint,
      executionSnapshot: mysqlJson(row.execution_snapshot_json),
      executionSnapshotHash: row.execution_snapshot_hash,
      queueBridgeVersion: row.queue_bridge_version === "v1" ? "v1" : null,
      parentRunId: row.parent_run_id || "",
      createdBy: row.created_by,
      createdAt: mysqlIsoDate(row.created_at),
      updatedAt: mysqlIsoDate(row.updated_at),
      pausedAt: row.paused_at ? mysqlIsoDate(row.paused_at) : "",
      cancelledAt: row.cancelled_at ? mysqlIsoDate(row.cancelled_at) : ""
    },
    "获客搜索运行"
  ));
}

async function loadProspectRunShards(
  pool: MysqlQuerySource
): Promise<ProspectRunShard[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT *
     FROM prospect_run_shards
     ORDER BY run_id, position_no, id`
  )).map((row) => parseProspectCampaignPersistence(
    prospectRunShardPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      runId: row.run_id,
      providerCode: row.provider_code,
      position: Number(row.position_no),
      status: row.status,
      pageLimit: Number(row.page_limit),
      resultLimit: Number(row.result_limit),
      budgetLimit: row.budget_limit === null
        ? null
        : Number(row.budget_limit),
      currency: row.currency || "",
      adapterVersion: row.adapter_version,
      contractVersion: row.contract_version,
      catalogVersion: row.catalog_version,
      capabilities: mysqlJson(row.capabilities_json),
      accessMode: row.access_mode,
      hasCursor: Boolean(row.has_cursor),
      createdAt: mysqlIsoDate(row.created_at),
      updatedAt: mysqlIsoDate(row.updated_at)
    },
    "获客搜索运行分片"
  ));
}

async function loadProspectRunEvents(
  pool: MysqlQuerySource
): Promise<ProspectRunEvent[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT *
     FROM prospect_run_events
     ORDER BY run_id, sequence_no, id`
  )).map((row) => parseProspectCampaignPersistence(
    prospectRunEventPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      runId: row.run_id,
      sequence: Number(row.sequence_no),
      eventType: row.event_type,
      actorId: row.actor_id,
      requestId: row.request_id,
      fromStatus: row.from_status || "",
      toStatus: row.to_status,
      fromRevision: Number(row.from_revision),
      toRevision: Number(row.to_revision),
      reason: row.reason || "",
      createdAt: mysqlIsoDate(row.created_at)
    },
    "获客搜索运行审计事件"
  ));
}

async function loadProspectRunQueueParentBindings(
  pool: MysqlQuerySource
): Promise<ProspectRunQueueParentBinding[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT *
     FROM prospect_run_queue_parent_bindings
     ORDER BY created_at, id`
  )).map((row) => parseProspectCampaignPersistence(
    prospectRunQueueParentBindingPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      runId: row.run_id,
      ownerId: row.owner_id,
      jobId: row.job_id,
      jobType: row.job_type,
      parentJobId: row.parent_job_id || "",
      bridgeVersion: row.bridge_version,
      executionSnapshotHash: row.execution_snapshot_hash,
      bindingHash: row.binding_hash,
      createdAt: mysqlIsoDate(row.created_at)
    },
    "获客搜索运行父桥接绑定"
  ));
}

async function loadProspectRunQueueChildBindings(
  pool: MysqlQuerySource
): Promise<ProspectRunQueueChildBinding[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT *
     FROM prospect_run_queue_child_bindings
     ORDER BY created_at, id`
  )).map((row) => parseProspectCampaignPersistence(
    prospectRunQueueChildBindingPersistenceSchema,
    {
      id: row.id,
      teamId: row.team_id,
      runId: row.run_id,
      shardId: row.shard_id,
      ownerId: row.owner_id,
      jobId: row.job_id,
      jobType: row.job_type,
      parentJobId: row.parent_job_id,
      bridgeVersion: row.bridge_version,
      executionSnapshotHash: row.execution_snapshot_hash,
      bindingHash: row.binding_hash,
      createdAt: mysqlIsoDate(row.created_at)
    },
    "获客搜索运行子桥接绑定"
  ));
}

async function loadProspectRunState(pool: MysqlQuerySource) {
  const runs = await loadProspectSearchRuns(pool);
  const shards = await loadProspectRunShards(pool);
  const events = await loadProspectRunEvents(pool);
  const parentBindings = await loadProspectRunQueueParentBindings(pool);
  const childBindings = await loadProspectRunQueueChildBindings(pool);
  return { runs, shards, events, parentBindings, childBindings };
}

async function loadProspectExecutionState(pool: MysqlQuerySource) {
  const kernelStates = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM search_execution_kernel_state ORDER BY id`
  )).map((row): ProspectExecutionKernelState => ({
    id: "search_execution_kernel_v1",
    kernelEpoch: Number(row.kernel_epoch),
    instanceId: row.instance_id,
    startedAt: mysqlIsoDate(row.started_at),
    updatedAt: mysqlIsoDate(row.updated_at)
  }));
  const checkpoints = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_execution_checkpoints
     ORDER BY team_id, run_id, shard_id`
  )).map((row): ProspectExecutionCheckpoint => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    providerCode: row.provider_code,
    runEpoch: Number(row.run_epoch),
    checkpointNo: Number(row.checkpoint_no),
    encryptedCursor: row.encrypted_cursor || "",
    cursorHash: row.cursor_hash || "",
    pageSequence: Number(row.page_sequence),
    totalCallCount: Number(row.total_call_count),
    checkpointCallCount: Number(row.checkpoint_call_count),
    acceptedCount: Number(row.accepted_count),
    rawCount: Number(row.raw_count),
    invalidCount: Number(row.invalid_count),
    duplicateCount: Number(row.duplicate_count),
    retryAfterAt: row.retry_after_at
      ? mysqlIsoDate(row.retry_after_at)
      : "",
    lastErrorCode: row.last_error_code || "",
    lastErrorMessage: row.last_error_message || "",
    partial: Boolean(row.partial),
    completionReason: row.completion_reason || "",
    version: Number(row.version_no),
    createdAt: mysqlIsoDate(row.created_at),
    updatedAt: mysqlIsoDate(row.updated_at)
  }));
  const leases = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_execution_leases
     ORDER BY team_id, run_id, claimed_at, id`
  )).map((row): ProspectExecutionLease => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    kernelEpoch: Number(row.kernel_epoch),
    runEpoch: Number(row.run_epoch),
    fenceToken: Number(row.fence_token),
    claimTokenHmac: row.claim_token_hmac,
    workerId: row.worker_id,
    status: row.status,
    claimedAt: mysqlIsoDate(row.claimed_at),
    heartbeatAt: mysqlIsoDate(row.heartbeat_at),
    expiresAt: mysqlIsoDate(row.expires_at),
    deadlineAt: mysqlIsoDate(row.deadline_at),
    requestStartedAt: row.request_started_at
      ? mysqlIsoDate(row.request_started_at)
      : "",
    releasedAt: row.released_at ? mysqlIsoDate(row.released_at) : "",
    releaseReason: row.release_reason || "",
    version: Number(row.version_no)
  }));
  const attempts = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_execution_attempts
     ORDER BY team_id, run_id, created_at, id`
  )).map((row): ProspectExecutionAttempt => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    leaseId: row.lease_id,
    providerCode: row.provider_code,
    checkpointNo: Number(row.checkpoint_no),
    checkpointCallNo: Number(row.checkpoint_call_no),
    providerAttemptNo: Number(row.provider_attempt_no),
    status: row.status,
    requestHash: row.request_hash || "",
    responseHash: row.response_hash || "",
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    retryable: Boolean(row.retryable),
    retryAfterAt: row.retry_after_at
      ? mysqlIsoDate(row.retry_after_at)
      : "",
    usageJson: row.usage_json
      ? canonicalJsonStringify(mysqlJson(row.usage_json))
      : "",
    costKind: row.cost_kind,
    costAmount: row.cost_amount === null
      ? null
      : Number(row.cost_amount),
    currency: row.currency || "",
    startedAt: row.started_at ? mysqlIsoDate(row.started_at) : "",
    finishedAt: row.finished_at ? mysqlIsoDate(row.finished_at) : "",
    createdAt: mysqlIsoDate(row.created_at),
    version: Number(row.version_no)
  }));
  const providerRequestLedgers = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_provider_request_ledgers
     ORDER BY team_id, run_id, shard_id, checkpoint_no, logical_request_no`
  )).map((row): ProspectProviderRequestLedger => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    originAttemptId: row.origin_attempt_id,
    checkpointNo: Number(row.checkpoint_no),
    logicalRequestNo: Number(row.logical_request_no),
    providerCode: row.provider_code,
    connectionId: row.connection_id,
    connectionRevision: row.connection_revision,
    connectionConfigHash: row.connection_config_hash,
    endpointCode: row.endpoint_code,
    adapterVersion: row.adapter_version,
    contractVersion: row.contract_version,
    requestSchemaVersion: row.request_schema_version,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    encryptedRequestEnvelope: row.encrypted_request_envelope || "",
    requestEvidenceRef: row.request_evidence_ref || "",
    status: row.status,
    externalRequestId: row.external_request_id || "",
    dispatchConfirmationRef: row.dispatch_confirmation_ref || "",
    encryptedResponseEnvelope: row.encrypted_response_envelope || "",
    responseEvidenceRef: row.response_evidence_ref || "",
    responseHash: row.response_hash || "",
    rawResponseHash: row.raw_response_hash || "",
    normalizedResultHash: row.normalized_result_hash || "",
    responseAccountingEvidenceHash:
      row.response_accounting_evidence_hash || "",
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    providerOutcomeCode: row.provider_outcome_code || "",
    settlementKind: row.settlement_kind || "",
    settlementHash: row.settlement_hash || "",
    unknownReason: row.unknown_reason || "",
    errorCode: row.error_code || "",
    kernelEpochAtPrepare: Number(row.kernel_epoch_at_prepare),
    runEpochAtPrepare: Number(row.run_epoch_at_prepare),
    fenceTokenAtPrepare: Number(row.fence_token_at_prepare),
    leaseIdAtPrepare: row.lease_id_at_prepare,
    preparedAt: mysqlIsoDate(row.prepared_at),
    dispatchStartedAt: row.dispatch_started_at
      ? mysqlIsoDate(row.dispatch_started_at)
      : "",
    dispatchConfirmedAt: row.dispatch_confirmed_at
      ? mysqlIsoDate(row.dispatch_confirmed_at)
      : "",
    responseReceivedAt: row.response_received_at
      ? mysqlIsoDate(row.response_received_at)
      : "",
    unknownAt: row.unknown_at ? mysqlIsoDate(row.unknown_at) : "",
    settledAt: row.settled_at ? mysqlIsoDate(row.settled_at) : "",
    cancelledLateAt: row.cancelled_late_at
      ? mysqlIsoDate(row.cancelled_late_at)
      : "",
    updatedAt: mysqlIsoDate(row.updated_at),
    version: Number(row.version_no)
  }));
  const providerRequestDispatches = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_provider_request_dispatches
     ORDER BY team_id, ledger_id, dispatch_no`
  )).map((row): ProspectProviderRequestDispatch => ({
    id: row.id,
    ledgerId: row.ledger_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    attemptId: row.attempt_id,
    dispatchNo: Number(row.dispatch_no),
    operation: row.operation,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    replayed: Boolean(row.replayed),
    providerExecuted: Boolean(row.provider_executed),
    externalRequestId: row.external_request_id || "",
    responseHash: row.response_hash || "",
    errorCode: row.error_code || "",
    startedAt: mysqlIsoDate(row.started_at),
    confirmedAt: row.confirmed_at ? mysqlIsoDate(row.confirmed_at) : "",
    finishedAt: row.finished_at ? mysqlIsoDate(row.finished_at) : "",
    version: Number(row.version_no)
  }));
  const providerRequestAttemptBindings = (
    await rows<Record<string, any>>(
      pool,
      `SELECT * FROM prospect_provider_request_attempt_bindings
       ORDER BY team_id, ledger_id, binding_no`
    )
  ).map((row): ProspectProviderRequestAttemptBinding => ({
    id: row.id,
    ledgerId: row.ledger_id,
    attemptId: row.attempt_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    bindingNo: Number(row.binding_no),
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const providerRequestEvents = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_provider_request_events
     ORDER BY team_id, ledger_id, sequence_no`
  )).map((row): ProspectProviderRequestEvent => ({
    id: row.id,
    ledgerId: row.ledger_id,
    dispatchId: row.dispatch_id || "",
    attemptId: row.attempt_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    sequence: Number(row.sequence_no),
    eventType: row.event_type,
    fromStatus: row.from_status || "",
    toStatus: row.to_status,
    detailHash: row.detail_hash,
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const providerRequestAccountingEvidence = (
    await rows<Record<string, any>>(
      pool,
      `SELECT * FROM prospect_provider_request_accounting_evidence
       ORDER BY team_id, ledger_id, sequence_no`
    )
  ).map((row): ProspectProviderRequestAccountingEvidence => ({
    id: row.id,
    ledgerId: row.ledger_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    sequence: Number(row.sequence_no),
    provenance: row.provenance,
    usageJson: row.usage_json
      ? canonicalJsonStringify(mysqlJson(row.usage_json))
      : "",
    costAmount: row.cost_amount === null
      ? null
      : Number(row.cost_amount),
    currency: row.currency || "",
    evidenceRef: row.evidence_ref || "",
    evidenceHash: row.evidence_hash,
    estimationMethodVersion: row.estimation_method_version || "",
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const pages = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_execution_pages
     ORDER BY team_id, run_id, shard_id, page_sequence`
  )).map((row): ProspectExecutionPage => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    providerCode: row.provider_code,
    checkpointNo: Number(row.checkpoint_no),
    pageSequence: Number(row.page_sequence),
    payloadHash: row.payload_hash,
    acceptedCount: Number(row.accepted_count),
    rawCount: Number(row.raw_count),
    invalidCount: Number(row.invalid_count),
    duplicateCount: Number(row.duplicate_count),
    partial: Boolean(row.partial),
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const sourcePositions = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_strategy_source_positions
     ORDER BY team_id, owner_id, campaign_id, strategy_id, provider_code`
  )).map((row): ProspectStrategySourcePosition => ({
    id: row.id,
    identityHash: row.identity_hash,
    teamId: row.team_id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    campaignVersion: Number(row.campaign_version),
    strategyId: row.strategy_id,
    providerCode: row.provider_code,
    queryFingerprint: row.query_fingerprint,
    connectionId: row.connection_id,
    endpointCode: row.endpoint_code,
    adapterVersion: row.adapter_version,
    contractVersion: row.contract_version,
    catalogVersion: row.catalog_version,
    timeWindowMode: row.time_window_mode,
    timeWindowFrom: row.time_window_from || "",
    timeWindowTo: row.time_window_to || "",
    status: row.status,
    encryptedCursor: row.encrypted_cursor || "",
    cursorHash: row.cursor_hash || "",
    sourceRunId: row.source_run_id,
    sourceShardId: row.source_shard_id,
    sourcePageId: row.source_page_id,
    sourceCheckpointNo: Number(row.source_checkpoint_no),
    sourcePageSequence: Number(row.source_page_sequence),
    version: Number(row.version_no),
    createdAt: mysqlIsoDate(row.created_at),
    updatedAt: mysqlIsoDate(row.updated_at)
  }));
  const sourceRawRecords = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_source_raw_records
     ORDER BY team_id, owner_id, provider_code, connection_id,
       endpoint_code, first_observed_at, id`
  )).map((row): ProspectSourceRawRecord => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    providerCode: row.provider_code,
    connectionId: row.connection_id,
    endpointCode: row.endpoint_code,
    sourceIdentityHash: row.source_identity_hash,
    artifactHash: row.artifact_hash,
    envelopeVersion: row.envelope_version,
    encryptedEnvelope: row.encrypted_envelope,
    envelopeHash: row.envelope_hash,
    firstObservedAt: mysqlIsoDate(row.first_observed_at),
    recordHash: row.record_hash,
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const sourceRawBatches = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_source_raw_batches
     ORDER BY team_id, run_id, shard_id, created_at, id`
  )).map((row): ProspectSourceRawBatch => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    ledgerId: row.ledger_id,
    pageId: row.page_id,
    providerCode: row.provider_code,
    connectionId: row.connection_id,
    endpointCode: row.endpoint_code,
    adapterVersion: row.adapter_version,
    responseSchemaVersion: row.response_schema_version,
    responseHash: row.response_hash,
    settlementHash: row.settlement_hash,
    rawArtifactHash: row.raw_artifact_hash,
    recordCount: Number(row.record_count),
    licensePolicy: row.license_policy,
    retentionPolicy: row.retention_policy,
    retentionDays: Number(row.retention_days),
    retentionUntil: mysqlIsoDate(row.retention_until),
    batchHash: row.batch_hash,
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const sourceRawHits = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_source_raw_hits
     ORDER BY team_id, batch_id, ordinal, id`
  )).map((row): ProspectSourceRawHit => ({
    id: row.id,
    batchId: row.batch_id,
    recordId: row.record_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    ledgerId: row.ledger_id,
    pageId: row.page_id,
    ordinal: Number(row.ordinal),
    fetchedAt: mysqlIsoDate(row.fetched_at),
    hitHash: row.hit_hash,
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const events = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_execution_events
     ORDER BY team_id, run_id, created_at, id`
  )).map((row): ProspectExecutionEvent => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    runId: row.run_id,
    shardId: row.shard_id || "",
    jobId: row.job_id || "",
    eventType: row.event_type,
    kernelEpoch: Number(row.kernel_epoch),
    runEpoch: Number(row.run_epoch),
    fenceToken: Number(row.fence_token),
    detailHash: row.detail_hash,
    createdAt: mysqlIsoDate(row.created_at)
  }));
  const throttleBuckets = (await rows<Record<string, any>>(
    pool,
    `SELECT * FROM prospect_execution_throttles
     ORDER BY team_id, provider_code, connection_id`
  )).map((row): ProspectExecutionThrottleBucket => ({
    id: row.id,
    teamId: row.team_id,
    providerCode: row.provider_code,
    connectionId: row.connection_id,
    availableAt: mysqlIsoDate(row.available_at),
    version: Number(row.version_no),
    updatedAt: mysqlIsoDate(row.updated_at)
  }));
  return {
    kernelStates,
    checkpoints,
    leases,
    attempts,
    providerRequestLedgers,
    providerRequestDispatches,
    providerRequestAttemptBindings,
    providerRequestEvents,
    providerRequestAccountingEvidence,
    sourceRawBatches,
    sourceRawRecords,
    sourceRawHits,
    sourcePositions,
    pages,
    events,
    throttleBuckets
  };
}

export function validateProspectCampaignPersistence(store: CrmStore) {
  for (const campaign of store.prospectCampaigns) {
    prospectCampaignPersistenceSchema.parse(campaign);
  }
  for (const version of store.prospectCampaignVersions) {
    prospectCampaignVersionPersistenceSchema.parse(version);
  }
  for (const auditEvent of store.prospectCampaignEvents) {
    prospectCampaignEventPersistenceSchema.parse(auditEvent);
  }
  for (const strategy of store.prospectStrategies) {
    prospectStrategyPersistenceSchema.parse(strategy);
  }
  for (const strategyEvent of store.prospectStrategyEvents) {
    prospectStrategyEventPersistenceSchema.parse(strategyEvent);
  }
  for (const schedule of store.prospectSchedules) {
    prospectSchedulePersistenceSchema.parse(schedule);
  }

  const campaigns = new Map<string, ProspectCampaign>();
  const versionKeys = new Set<string>();
  const versionsByCampaign = new Map<string, ProspectCampaignVersion[]>();
  const eventIds = new Set<string>();
  const strategies = new Map<string, ProspectStrategy>();
  const scheduleIds = new Set<string>();
  const strategyEventIds = new Set<string>();
  const strategyEventsByStrategy = new Map<string, ProspectStrategyEvent[]>();
  for (const campaign of store.prospectCampaigns) {
    if (campaigns.has(campaign.id)) throw new Error("获客项目存在重复主键");
    campaigns.set(campaign.id, campaign);
    const owner = store.users.find((item) => item.id === campaign.ownerId);
    if (!owner || owner.teamId !== campaign.teamId || owner.role === "super_admin") {
      throw new Error("获客项目负责人不存在或团队不一致");
    }
    if (campaign.status === "archived" ? !campaign.archivedAt : Boolean(campaign.archivedAt)) {
      throw new Error("获客项目归档状态与归档时间不一致");
    }
    if (campaign.updatedAt < campaign.createdAt) {
      throw new Error("获客项目更新时间早于创建时间");
    }
  }
  for (const version of store.prospectCampaignVersions) {
    const campaign = campaigns.get(version.campaignId);
    if (!campaign || campaign.teamId !== version.teamId) {
      throw new Error("获客项目版本引用了不存在或跨团队的项目");
    }
    const key = [version.teamId, version.campaignId, version.version].join("|");
    if (versionKeys.has(key)) throw new Error("获客项目版本号重复");
    versionKeys.add(key);
    const normalized = normalizeProspectCampaignSnapshot(version.snapshot);
    if (!isDeepStrictEqual(normalized, version.snapshot)
      || prospectCampaignSnapshotHash(normalized) !== version.contentHash) {
      throw new Error("获客项目版本快照或内容哈希不一致");
    }
    const list = versionsByCampaign.get(version.campaignId) || [];
    list.push(version);
    versionsByCampaign.set(version.campaignId, list);
  }
  for (const campaign of store.prospectCampaigns) {
    const versions = versionsByCampaign.get(campaign.id) || [];
    const highestVersion = Math.max(0, ...versions.map((item) => item.version));
    if (!versions.some((item) => item.version === campaign.currentVersion)
      || highestVersion !== campaign.currentVersion) {
      throw new Error("获客项目当前版本指针无效");
    }
  }
  for (const auditEvent of store.prospectCampaignEvents) {
    if (eventIds.has(auditEvent.id)) throw new Error("获客项目审计事件主键重复");
    eventIds.add(auditEvent.id);
    const campaign = campaigns.get(auditEvent.campaignId);
    if (!campaign
      || campaign.teamId !== auditEvent.teamId
      || auditEvent.revision > campaign.revision) {
      throw new Error("获客项目审计事件引用无效");
    }
  }
  for (const strategy of store.prospectStrategies) {
    if (strategies.has(strategy.id)) throw new Error("获客搜索策略存在重复主键");
    strategies.set(strategy.id, strategy);
    const campaign = campaigns.get(strategy.campaignId);
    const version = store.prospectCampaignVersions.find((item) =>
      item.teamId === strategy.teamId
      && item.campaignId === strategy.campaignId
      && item.version === strategy.campaignVersion
    );
    if (!campaign
      || !version
      || campaign.teamId !== strategy.teamId
      || campaign.ownerId !== strategy.ownerId) {
      throw new Error("获客搜索策略引用无效或负责人和项目不一致");
    }
    const normalizedQuery = normalizeProspectStrategyQuery(strategy.query);
    const normalizedProviderPlan = normalizeProspectStrategyProviderPlan(
      strategy.providerPlan
    );
    if (!isDeepStrictEqual(normalizedQuery, strategy.query)
      || !isDeepStrictEqual(normalizedProviderPlan, strategy.providerPlan)
      || prospectStrategyFingerprint({
        version,
        query: normalizedQuery,
        providerPlan: normalizedProviderPlan
      }) !== strategy.queryFingerprint) {
      throw new Error("获客搜索策略规范化内容或查询指纹不一致");
    }
    if (strategy.updatedAt < strategy.createdAt) {
      throw new Error("获客搜索策略更新时间早于创建时间");
    }
    if (strategy.status === "draft"
      && (strategy.approvedBy
        || strategy.approvedAt
        || strategy.disabledBy
        || strategy.disabledAt)) {
      throw new Error("草稿搜索策略包含无效审批或禁用信息");
    }
    if (strategy.status === "approved"
      && (!strategy.approvedBy
        || !strategy.approvedAt
        || strategy.disabledBy
        || strategy.disabledAt)) {
      throw new Error("已审批搜索策略的审批状态不完整");
    }
    if (strategy.status === "disabled"
      && (!strategy.disabledBy || !strategy.disabledAt)) {
      throw new Error("已禁用搜索策略的禁用状态不完整");
    }
  }
  for (const schedule of store.prospectSchedules) {
    if (scheduleIds.has(schedule.id)) {
      throw new Error("定时获客计划存在重复主键");
    }
    scheduleIds.add(schedule.id);
    const campaign = campaigns.get(schedule.campaignId);
    const strategy = strategies.get(schedule.strategyId);
    const owner = store.users.find((item) => item.id === schedule.ownerId);
    if (!campaign
      || !strategy
      || !owner
      || campaign.teamId !== schedule.teamId
      || strategy.teamId !== schedule.teamId
      || strategy.campaignId !== schedule.campaignId
      || strategy.campaignVersion !== schedule.campaignVersion
      || owner.teamId !== schedule.teamId
      || owner.role === "super_admin") {
      throw new Error("定时获客计划引用无效或跨团队");
    }
    if (schedule.updatedAt < schedule.createdAt
      || schedule.nextRunAt < schedule.createdAt) {
      throw new Error("定时获客计划时间状态无效");
    }
    if (Boolean(schedule.lastRunAt) !== Boolean(schedule.lastPlannedAt)
      || Boolean(schedule.lastRunId) && !schedule.lastRunAt) {
      throw new Error("定时获客计划最近运行信息不完整");
    }
  }
  for (const strategyEvent of store.prospectStrategyEvents) {
    if (strategyEventIds.has(strategyEvent.id)) {
      throw new Error("获客搜索策略审计事件主键重复");
    }
    strategyEventIds.add(strategyEvent.id);
    const strategy = strategies.get(strategyEvent.strategyId);
    if (!strategy
      || strategy.teamId !== strategyEvent.teamId
      || strategy.campaignId !== strategyEvent.campaignId
      || strategyEvent.toRevision > strategy.revision
      || strategyEvent.fromRevision + 1 !== strategyEvent.toRevision) {
      throw new Error("获客搜索策略审计事件引用无效");
    }
    const list = strategyEventsByStrategy.get(strategyEvent.strategyId) || [];
    list.push(strategyEvent);
    strategyEventsByStrategy.set(strategyEvent.strategyId, list);
  }
  for (const strategy of store.prospectStrategies) {
    const events = (strategyEventsByStrategy.get(strategy.id) || [])
      .sort((left, right) => left.toRevision - right.toRevision);
    if (events.length !== strategy.revision
      || events[0]?.eventType !== "created"
      || events[0]?.fromRevision !== 0
      || events[0]?.toRevision !== 1
      || events.some((item, index) => item.toRevision !== index + 1)) {
      throw new Error("获客搜索策略 revision 与审计事件链不完整");
    }
  }
}

function isValidPersistedRunTransition(
  fromStatus: ProspectSearchRun["status"],
  toStatus: ProspectSearchRun["status"]
) {
  const transitions: Record<
    ProspectSearchRun["status"],
    ReadonlySet<ProspectSearchRun["status"]>
  > = {
    queued: new Set([
      "running",
      "paused",
      "cancelled",
      "succeeded_empty"
    ]),
    running: new Set([
      "pause_requested",
      "paused",
      "cancel_requested",
      "cancelled",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ]),
    pause_requested: new Set([
      "paused",
      "cancel_requested",
      "cancelled",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ]),
    paused: new Set(["queued", "cancelled"]),
    cancel_requested: new Set(["cancelled"]),
    cancelled: new Set(),
    succeeded: new Set(),
    succeeded_empty: new Set(),
    partial_success: new Set(),
    failed: new Set()
  };
  return transitions[fromStatus].has(toStatus);
}

function isValidPersistedShardTransition(
  fromStatus: ProspectRunShard["status"],
  toStatus: ProspectRunShard["status"]
) {
  const transitions: Record<
    ProspectRunShard["status"],
    ReadonlySet<ProspectRunShard["status"]>
  > = {
    queued: new Set([
      "running",
      "paused",
      "cancelled",
      "succeeded_empty"
    ]),
    running: new Set([
      "queued",
      "retry_scheduled",
      "pause_requested",
      "paused",
      "cancel_requested",
      "cancelled",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ]),
    retry_scheduled: new Set([
      "running",
      "pause_requested",
      "paused",
      "cancel_requested",
      "cancelled",
      "failed"
    ]),
    pause_requested: new Set([
      "paused",
      "cancel_requested",
      "cancelled",
      "succeeded",
      "succeeded_empty",
      "partial_success",
      "failed"
    ]),
    paused: new Set(["queued", "retry_scheduled", "cancelled"]),
    cancel_requested: new Set(["cancelled"]),
    cancelled: new Set(),
    succeeded: new Set(["cancelled"]),
    succeeded_empty: new Set(["cancelled"]),
    partial_success: new Set(["cancelled"]),
    failed: new Set(["cancelled"])
  };
  return transitions[fromStatus].has(toStatus);
}

function expectedPersistedRunEventType(
  fromStatus: ProspectSearchRun["status"],
  toStatus: ProspectSearchRun["status"]
): ProspectRunEvent["eventType"] | "" {
  if (fromStatus === "queued" && toStatus === "running") return "started";
  if (toStatus === "pause_requested") return "pause_requested";
  if (toStatus === "paused") return "paused";
  if (fromStatus === "paused" && toStatus === "queued") return "resumed";
  if (toStatus === "cancel_requested") return "cancel_requested";
  if (toStatus === "cancelled") return "cancelled";
  if (toStatus === "failed") return "failed";
  if (toStatus === "succeeded"
    || toStatus === "succeeded_empty"
    || toStatus === "partial_success") {
    return "completed";
  }
  return "";
}

export function validateProspectRunPersistence(store: CrmStore) {
  for (const run of store.prospectSearchRuns) {
    prospectSearchRunPersistenceSchema.parse(run);
  }
  for (const shard of store.prospectRunShards) {
    prospectRunShardPersistenceSchema.parse(shard);
  }
  for (const event of store.prospectRunEvents) {
    prospectRunEventPersistenceSchema.parse(event);
  }
  for (const binding of store.prospectRunQueueParentBindings) {
    prospectRunQueueParentBindingPersistenceSchema.parse(binding);
  }
  for (const binding of store.prospectRunQueueChildBindings) {
    prospectRunQueueChildBindingPersistenceSchema.parse(binding);
  }

  const campaigns = new Map(
    store.prospectCampaigns.map((item) => [
      `${item.teamId}|${item.id}`,
      item
    ])
  );
  const versions = new Map(
    store.prospectCampaignVersions.map((item) => [
      `${item.teamId}|${item.campaignId}|${item.version}`,
      item
    ])
  );
  const strategies = new Map(
    store.prospectStrategies.map((item) => [
      `${item.teamId}|${item.campaignId}|${item.campaignVersion}|${item.id}`,
      item
    ])
  );
  const runs = new Map<string, ProspectSearchRun>();
  const idempotencyScopes = new Set<string>();
  const activeScopes = new Set<string>();
  const shardsByRun = new Map<string, ProspectRunShard[]>();
  const eventsByRun = new Map<string, ProspectRunEvent[]>();
  const shardIds = new Set<string>();
  const eventIds = new Set<string>();
  const activeRunStatuses = new Set<ProspectSearchRun["status"]>([
    "queued",
    "running",
    "pause_requested",
    "paused",
    "cancel_requested"
  ]);

  for (const run of store.prospectSearchRuns) {
    if (runs.has(run.id)) throw new Error("获客搜索运行存在重复主键");
    runs.set(run.id, run);
    const campaign = campaigns.get(`${run.teamId}|${run.campaignId}`);
    const version = versions.get(
      `${run.teamId}|${run.campaignId}|${run.campaignVersion}`
    );
    const strategy = strategies.get(
      `${run.teamId}|${run.campaignId}|${run.campaignVersion}|${run.strategyId}`
    );
    if (!campaign || !version || !strategy) {
      throw new Error("获客搜索运行引用了不存在或跨团队的项目版本或策略");
    }
    if (run.updatedAt < run.createdAt) {
      throw new Error("获客搜索运行更新时间早于创建时间");
    }
    if (run.status === "queued" && (run.pausedAt || run.cancelledAt)) {
      throw new Error("排队中的获客搜索运行包含无效暂停或取消时间");
    }
    if (run.status === "paused" && (!run.pausedAt || run.cancelledAt)) {
      throw new Error("暂停的获客搜索运行时间状态不完整");
    }
    if (run.status === "cancelled" && !run.cancelledAt) {
      throw new Error("已取消的获客搜索运行缺少取消时间");
    }
    if ((run.pausedAt
        && (run.pausedAt < run.createdAt || run.pausedAt > run.updatedAt))
      || (run.cancelledAt
        && (run.cancelledAt < run.createdAt
          || run.cancelledAt > run.updatedAt))) {
      throw new Error("获客搜索运行状态时间超出生命周期");
    }
    const idempotencyScope = [
      run.teamId,
      run.createdBy,
      run.operationCode,
      run.idempotencyKeyHash
    ].join("|");
    if (idempotencyScopes.has(idempotencyScope)) {
      throw new Error("获客搜索运行幂等作用域重复");
    }
    idempotencyScopes.add(idempotencyScope);
    if (activeRunStatuses.has(run.status)) {
      const activeScope = [
        run.teamId,
        run.ownerId,
        run.queryFingerprint
      ].join("|");
      if (activeScopes.has(activeScope)) {
        throw new Error("同一负责人存在重复的活动获客搜索运行");
      }
      activeScopes.add(activeScope);
      if (campaign.ownerId !== run.ownerId
        || strategy.ownerId !== run.ownerId) {
        throw new Error("活动获客搜索运行的负责人和当前项目或策略不一致");
      }
    }

    const snapshot = run.executionSnapshot;
    if (prospectRunExecutionSnapshotHash(snapshot)
      !== run.executionSnapshotHash) {
      throw new Error("获客搜索运行执行快照哈希不一致");
    }
    if (snapshot.campaign.id !== run.campaignId
      || snapshot.campaign.version !== run.campaignVersion
      || snapshot.campaign.contentHash !== version.contentHash
      || !isDeepStrictEqual(snapshot.campaign.snapshot, version.snapshot)) {
      throw new Error("获客搜索运行项目版本快照不一致");
    }
    if (snapshot.strategy.id !== run.strategyId
      || snapshot.strategy.revision > strategy.revision
      || snapshot.strategy.name !== strategy.name
      || snapshot.strategy.queryFingerprint !== run.queryFingerprint
      || run.queryFingerprint !== strategy.queryFingerprint
      || !isDeepStrictEqual(snapshot.strategy.query, strategy.query)) {
      throw new Error("获客搜索运行策略快照不一致");
    }
    const resolvedQuery = resolveProspectStrategyQuery(
      snapshot.strategy.query,
      version
    );
    if (!isDeepStrictEqual(snapshot.resolvedQuery, resolvedQuery)) {
      throw new Error("获客搜索运行解析查询快照不一致");
    }
    if (snapshot.providerPlan.length !== strategy.providerPlan.length) {
      throw new Error("获客搜索运行数据源快照数量不一致");
    }
    const providerCodes = new Set<string>();
    snapshot.providerPlan.forEach((provider, index) => {
      const strategyProvider = strategy.providerPlan[index];
      if (!strategyProvider
        || providerCodes.has(provider.providerCode)
        || provider.position !== index + 1
        || provider.providerCode !== strategyProvider.providerId
        || provider.priority !== strategyProvider.priority
        || provider.pageLimit !== strategyProvider.pageLimit
        || provider.resultLimit !== strategyProvider.resultLimit
        || provider.budgetLimit !== strategyProvider.budgetLimit
        || provider.currency !== strategyProvider.currency
        || !isDeepStrictEqual(
          provider.capabilities,
          [...provider.capabilities].sort()
        )) {
        throw new Error("获客搜索运行数据源快照内容不一致");
      }
      providerCodes.add(provider.providerCode);
    });
  }

  for (const shard of store.prospectRunShards) {
    if (shardIds.has(shard.id)) throw new Error("获客搜索运行分片主键重复");
    shardIds.add(shard.id);
    const run = runs.get(shard.runId);
    if (!run || run.teamId !== shard.teamId) {
      throw new Error("获客搜索运行分片引用无效或跨团队");
    }
    const list = shardsByRun.get(shard.runId) || [];
    list.push(shard);
    shardsByRun.set(shard.runId, list);
  }

  for (const event of store.prospectRunEvents) {
    if (eventIds.has(event.id)) {
      throw new Error("获客搜索运行审计事件主键重复");
    }
    eventIds.add(event.id);
    const run = runs.get(event.runId);
    if (!run || run.teamId !== event.teamId) {
      throw new Error("获客搜索运行审计事件引用无效或跨团队");
    }
    const list = eventsByRun.get(event.runId) || [];
    list.push(event);
    eventsByRun.set(event.runId, list);
  }

  for (const run of store.prospectSearchRuns) {
    const shards = (shardsByRun.get(run.id) || [])
      .sort((left, right) => left.position - right.position);
    if (shards.length !== run.executionSnapshot.providerPlan.length) {
      throw new Error("获客搜索运行分片集合不完整");
    }
    const shardProviderCodes = new Set<string>();
    shards.forEach((shard, index) => {
      const provider = run.executionSnapshot.providerPlan[index];
      if (!provider
        || shardProviderCodes.has(shard.providerCode)
        || shard.teamId !== run.teamId
        || shard.providerCode !== provider.providerCode
        || shard.position !== provider.position
        || shard.pageLimit !== provider.pageLimit
        || shard.resultLimit !== provider.resultLimit
        || shard.budgetLimit !== provider.budgetLimit
        || shard.currency !== provider.currency
        || shard.adapterVersion !== provider.adapterVersion
        || shard.contractVersion !== provider.contractVersion
        || shard.catalogVersion !== provider.catalogVersion
        || !isDeepStrictEqual(shard.capabilities, provider.capabilities)
        || shard.accessMode !== provider.accessMode
        || shard.hasCursor
        || shard.createdAt !== run.createdAt
        || shard.updatedAt < shard.createdAt
        || (run.queueBridgeVersion === null && shard.status !== run.status)) {
        throw new Error("获客搜索运行分片与不可变执行快照不一致");
      }
      shardProviderCodes.add(shard.providerCode);
    });

    const events = (eventsByRun.get(run.id) || [])
      .sort((left, right) => left.sequence - right.sequence);
    if (events.length !== run.revision
      || events[0]?.eventType !== "created"
      || events[0]?.sequence !== 1
      || events[0]?.fromStatus !== ""
      || events[0]?.toStatus !== "queued"
      || events[0]?.fromRevision !== 0
      || events[0]?.toRevision !== 1
      || events[0]?.createdAt !== run.createdAt) {
      throw new Error("获客搜索运行 revision 与首个审计事件不一致");
    }
    let previousStatus: ProspectSearchRun["status"] = "queued";
    let previousCreatedAt = events[0]?.createdAt || "";
    events.forEach((event, index) => {
      if (event.sequence !== index + 1
        || event.fromRevision !== index
        || event.toRevision !== index + 1
        || event.createdAt < previousCreatedAt) {
        throw new Error("获客搜索运行审计事件序列不连续");
      }
      if (index > 0) {
        const expectedType = expectedPersistedRunEventType(
          previousStatus,
          event.toStatus
        );
        if (event.fromStatus !== previousStatus
          || !isValidPersistedRunTransition(previousStatus, event.toStatus)
          || event.eventType !== expectedType) {
          throw new Error("获客搜索运行审计事件状态转换无效");
        }
      }
      previousStatus = event.toStatus;
      previousCreatedAt = event.createdAt;
    });
    const lastEvent = events.at(-1);
    if (!lastEvent
      || lastEvent.toStatus !== run.status
      || lastEvent.toRevision !== run.revision
      || lastEvent.createdAt !== run.updatedAt) {
      throw new Error("获客搜索运行当前状态与审计事件链不一致");
    }
  }
  validateProspectExecutionPersistence(store);
  validateAllProspectRunQueueBridges(store);
}

function validateProspectExecutionPersistence(store: CrmStore) {
  const hashPattern = /^[a-f0-9]{64}$/;
  const executionFactsCount =
    store.prospectExecutionCheckpoints.length
    + store.prospectExecutionLeases.length
    + store.prospectExecutionAttempts.length
    + store.prospectProviderRequestLedgers.length
    + store.prospectProviderRequestDispatches.length
    + store.prospectProviderRequestEvents.length
    + store.prospectProviderRequestAttemptBindings.length
    + store.prospectProviderRequestAccountingEvidence.length
    + store.prospectStrategySourcePositions.length
    + store.prospectExecutionPages.length
    + store.prospectExecutionEvents.length
    + store.prospectExecutionThrottleBuckets.length;
  if (store.prospectExecutionKernelStates.length > 1
    || (executionFactsCount > 0
      && store.prospectExecutionKernelStates.length !== 1)) {
    throw new Error("搜索执行内核状态数量无效");
  }
  const kernelState = store.prospectExecutionKernelStates[0];
  if (kernelState && (kernelState.id !== "search_execution_kernel_v1"
    || !Number.isInteger(kernelState.kernelEpoch)
    || kernelState.kernelEpoch < 1
    || !kernelState.instanceId
    || kernelState.updatedAt < kernelState.startedAt)) {
    throw new Error("搜索执行内核 epoch 状态无效");
  }

  const runs = new Map(
    store.prospectSearchRuns.map((item) => [item.id, item])
  );
  const shards = new Map(
    store.prospectRunShards.map((item) => [item.id, item])
  );
  const jobs = new Map(store.agentJobs.map((item) => [item.id, item]));
  const parentBindingsByRun = new Map(
    store.prospectRunQueueParentBindings.map((item) => [item.runId, item])
  );
  const childBindingsByShard = new Map(
    store.prospectRunQueueChildBindings.map((item) => [item.shardId, item])
  );
  const checkpointsByShard = new Map<string, ProspectExecutionCheckpoint>();
  const checkpointIds = new Set<string>();
  for (const checkpoint of store.prospectExecutionCheckpoints) {
    const run = runs.get(checkpoint.runId);
    const shard = shards.get(checkpoint.shardId);
    const job = jobs.get(checkpoint.jobId);
    const binding = childBindingsByShard.get(checkpoint.shardId);
    if (checkpointIds.has(checkpoint.id)
      || checkpointsByShard.has(checkpoint.shardId)
      || !run
      || !shard
      || !job
      || !binding
      || checkpoint.teamId !== run.teamId
      || checkpoint.ownerId !== run.ownerId
      || shard.teamId !== run.teamId
      || shard.runId !== run.id
      || checkpoint.providerCode !== shard.providerCode
      || binding.teamId !== checkpoint.teamId
      || binding.runId !== checkpoint.runId
      || binding.ownerId !== checkpoint.ownerId
      || binding.jobId !== checkpoint.jobId
      || job.teamId !== checkpoint.teamId
      || job.ownerId !== checkpoint.ownerId
      || job.jobType !== "prospect.provider.fetch"
      || checkpoint.runEpoch < 1
      || checkpoint.runEpoch > run.executionEpoch
      || checkpoint.checkpointNo < 1
      || checkpoint.pageSequence < 0
      || checkpoint.totalCallCount < 0
      || checkpoint.checkpointCallCount < 0
      || checkpoint.checkpointCallCount > 3
      || checkpoint.acceptedCount < 0
      || checkpoint.rawCount < 0
      || checkpoint.invalidCount < 0
      || checkpoint.duplicateCount < 0
      || checkpoint.acceptedCount > shard.resultLimit
      || checkpoint.pageSequence > shard.pageLimit
      || checkpoint.version < 1
      || checkpoint.updatedAt < checkpoint.createdAt
      || Boolean(checkpoint.encryptedCursor) !== Boolean(checkpoint.cursorHash)
      || (checkpoint.cursorHash && !hashPattern.test(checkpoint.cursorHash))
      || (checkpoint.completionReason && checkpoint.encryptedCursor)) {
      throw new Error("搜索执行 checkpoint 引用、计数或作用域无效");
    }
    checkpointIds.add(checkpoint.id);
    checkpointsByShard.set(checkpoint.shardId, checkpoint);
  }

  const leaseIds = new Set<string>();
  const activeRunScopes = new Set<string>();
  const activeJobScopes = new Set<string>();
  const fenceScopes = new Set<string>();
  const leasesById = new Map<string, ProspectExecutionLease>();
  for (const lease of store.prospectExecutionLeases) {
    const run = runs.get(lease.runId);
    const shard = shards.get(lease.shardId);
    const job = jobs.get(lease.jobId);
    const binding = childBindingsByShard.get(lease.shardId);
    const fenceScope = `${lease.teamId}|${lease.jobId}|${lease.fenceToken}`;
    if (leaseIds.has(lease.id)
      || fenceScopes.has(fenceScope)
      || !kernelState
      || !run
      || !shard
      || !job
      || !binding
      || lease.teamId !== run.teamId
      || lease.ownerId !== run.ownerId
      || shard.teamId !== run.teamId
      || shard.runId !== run.id
      || binding.jobId !== lease.jobId
      || binding.teamId !== lease.teamId
      || binding.ownerId !== lease.ownerId
      || job.teamId !== lease.teamId
      || job.ownerId !== lease.ownerId
      || job.jobType !== "prospect.provider.fetch"
      || lease.kernelEpoch < 1
      || lease.kernelEpoch > kernelState.kernelEpoch
      || lease.runEpoch < 1
      || lease.runEpoch > run.executionEpoch
      || lease.fenceToken < 1
      || !hashPattern.test(lease.claimTokenHmac)
      || !lease.workerId
      || lease.version < 1
      || lease.heartbeatAt < lease.claimedAt
      || lease.expiresAt < lease.heartbeatAt
      || lease.deadlineAt < lease.expiresAt
      || (lease.requestStartedAt
        && lease.requestStartedAt < lease.claimedAt)
      || (lease.releasedAt && lease.releasedAt < lease.claimedAt)) {
      throw new Error("搜索执行租约引用、epoch、fence 或时间状态无效");
    }
    if (lease.status === "active") {
      const runScope = `${lease.teamId}|${lease.runId}`;
      const jobScope = `${lease.teamId}|${lease.jobId}`;
      const validRunEpoch = run.status === "cancel_requested"
        ? lease.runEpoch === run.executionEpoch - 1
        : lease.runEpoch === run.executionEpoch;
      if (activeRunScopes.has(runScope)
        || activeJobScopes.has(jobScope)
        || !validRunEpoch
        || !["running", "pause_requested", "cancel_requested"].includes(
          run.status
        )
        || !["running", "pause_requested", "cancel_requested"].includes(
          shard.status
        )
        || job.status !== "running"
        || lease.releasedAt
        || lease.releaseReason) {
        throw new Error("同一搜索运行或任务存在冲突的活动租约");
      }
      activeRunScopes.add(runScope);
      activeJobScopes.add(jobScope);
    } else if (!lease.releasedAt || !lease.releaseReason) {
      throw new Error("已释放或过期的搜索执行租约缺少结算事实");
    }
    leaseIds.add(lease.id);
    fenceScopes.add(fenceScope);
    leasesById.set(lease.id, lease);
  }

  const attemptIds = new Set<string>();
  const attemptLeaseIds = new Set<string>();
  const sentCallScopes = new Set<string>();
  const attemptsByShard = new Map<string, ProspectExecutionAttempt[]>();
  const attemptsById = new Map<string, ProspectExecutionAttempt>();
  for (const attempt of store.prospectExecutionAttempts) {
    const run = runs.get(attempt.runId);
    const shard = shards.get(attempt.shardId);
    const job = jobs.get(attempt.jobId);
    const lease = leasesById.get(attempt.leaseId);
    const checkpoint = checkpointsByShard.get(attempt.shardId);
    const sentCallScope = [
      attempt.teamId,
      attempt.shardId,
      attempt.checkpointNo,
      attempt.checkpointCallNo
    ].join("|");
    if (attemptIds.has(attempt.id)
      || attemptLeaseIds.has(attempt.leaseId)
      || !run
      || !shard
      || !job
      || !lease
      || !checkpoint
      || attempt.teamId !== run.teamId
      || attempt.ownerId !== run.ownerId
      || attempt.runId !== lease.runId
      || attempt.shardId !== lease.shardId
      || attempt.jobId !== lease.jobId
      || attempt.providerCode !== shard.providerCode
      || attempt.checkpointNo < 1
      || attempt.checkpointNo > checkpoint.checkpointNo
      || attempt.checkpointCallNo < 0
      || attempt.checkpointCallNo > 3
      || attempt.providerAttemptNo < 0
      || attempt.version < 1
      || (attempt.requestHash && !hashPattern.test(attempt.requestHash))
      || (attempt.responseHash && !hashPattern.test(attempt.responseHash))
      || (attempt.retryAfterAt && !attempt.retryable)
      || (attempt.costAmount !== null && attempt.costAmount < 0)
      || (attempt.costKind === "unknown"
        ? attempt.costAmount !== null || Boolean(attempt.currency)
        : attempt.costAmount === null || !/^[A-Z]{3}$/.test(attempt.currency))
      || (attempt.checkpointCallNo > 0
        && (!attempt.requestHash || !attempt.startedAt))
      || (attempt.status === "claimed"
        && (attempt.checkpointCallNo !== 0
          || attempt.startedAt
          || attempt.finishedAt))
      || (attempt.status === "request_started"
        && (!attempt.startedAt || attempt.finishedAt))
      || (!["claimed", "request_started"].includes(attempt.status)
        && !attempt.finishedAt)) {
      throw new Error("搜索执行尝试引用、调用次数、成本或状态无效");
    }
    if (attempt.checkpointCallNo > 0) {
      if (sentCallScopes.has(sentCallScope)) {
        throw new Error("同一 checkpoint 调用序号被重复使用");
      }
      sentCallScopes.add(sentCallScope);
    }
    if (attempt.usageJson) {
      try {
        const usage = JSON.parse(attempt.usageJson);
        if (!usage
          || Array.isArray(usage)
          || typeof usage !== "object"
          || hasForbiddenExecutionFactKey(usage)) {
          throw new Error("invalid usage");
        }
      } catch {
        throw new Error("搜索执行尝试 usage 事实不安全或不是有效 JSON");
      }
    }
    attemptIds.add(attempt.id);
    attemptLeaseIds.add(attempt.leaseId);
    attemptsById.set(attempt.id, attempt);
    const grouped = attemptsByShard.get(attempt.shardId) || [];
    grouped.push(attempt);
    attemptsByShard.set(attempt.shardId, grouped);
  }
  if (store.prospectExecutionLeases.some(
    (lease) => !attemptLeaseIds.has(lease.id)
  )) {
    throw new Error("搜索执行租约缺少唯一的尝试事实");
  }

  const pageIds = new Set<string>();
  const pageAttemptIds = new Set<string>();
  const pagesByShard = new Map<string, ProspectExecutionPage[]>();
  for (const page of store.prospectExecutionPages) {
    const run = runs.get(page.runId);
    const shard = shards.get(page.shardId);
    const job = jobs.get(page.jobId);
    const attempt = attemptsById.get(page.attemptId);
    if (pageIds.has(page.id)
      || pageAttemptIds.has(page.attemptId)
      || !run
      || !shard
      || !job
      || !attempt
      || page.teamId !== run.teamId
      || page.ownerId !== run.ownerId
      || page.runId !== attempt.runId
      || page.shardId !== attempt.shardId
      || page.jobId !== attempt.jobId
      || page.providerCode !== attempt.providerCode
      || page.checkpointNo !== attempt.checkpointNo
      || page.payloadHash !== attempt.responseHash
      || attempt.status !== "succeeded"
      || !hashPattern.test(page.payloadHash)
      || page.pageSequence < 1
      || page.acceptedCount < 0
      || page.rawCount < 0
      || page.invalidCount < 0
      || page.duplicateCount < 0
      || page.acceptedCount + page.invalidCount + page.duplicateCount
        > page.rawCount) {
      throw new Error("搜索执行页摘要引用、哈希或计数无效");
    }
    pageIds.add(page.id);
    pageAttemptIds.add(page.attemptId);
    const grouped = pagesByShard.get(page.shardId) || [];
    grouped.push(page);
    pagesByShard.set(page.shardId, grouped);
  }

  const sourcePositionIds = new Set<string>();
  const sourcePositionScopes = new Set<string>();
  for (const position of store.prospectStrategySourcePositions) {
    prospectStrategySourcePositionPersistenceSchema.parse(position);
    const run = runs.get(position.sourceRunId);
    const shard = shards.get(position.sourceShardId);
    const page = store.prospectExecutionPages.find(
      (item) => item.id === position.sourcePageId
    );
    const attempt = page ? attemptsById.get(page.attemptId) : null;
    const ledger = attempt
      ? store.prospectProviderRequestLedgers.find(
          (item) => item.originAttemptId === attempt.id
        )
      : null;
    const timeWindow = run?.executionSnapshot.resolvedQuery.timeWindow;
    const allowedConnectionIds = new Set([
      `fake:${position.providerCode}`,
      `builtin:${position.providerCode}`,
      ...store.providerConnections
        .filter((item) =>
          item.providerId === position.providerCode
          && item.teamId === position.teamId
          && item.ownerId === position.ownerId
          && item.scope === "personal"
        )
        .map((item) => item.id)
    ]);
    const scope = [
      position.teamId,
      position.ownerId,
      position.identityHash
    ].join("|");
    if (sourcePositionIds.has(position.id)
      || sourcePositionScopes.has(scope)
      || position.identityHash
        !== prospectStrategySourcePositionIdentityHash(position)
      || !run
      || !shard
      || !page
      || !attempt
      || position.teamId !== run.teamId
      || position.ownerId !== run.ownerId
      || position.campaignId !== run.campaignId
      || position.campaignVersion !== run.campaignVersion
      || position.strategyId !== run.strategyId
      || position.queryFingerprint !== run.queryFingerprint
      || position.providerCode !== shard.providerCode
      || position.adapterVersion !== shard.adapterVersion
      || position.contractVersion !== shard.contractVersion
      || position.catalogVersion !== shard.catalogVersion
      || position.endpointCode !== "company-search"
      || position.timeWindowMode !== timeWindow?.mode
      || position.timeWindowFrom !== timeWindow?.from
      || position.timeWindowTo !== timeWindow?.to
      || shard.teamId !== run.teamId
      || shard.runId !== run.id
      || page.teamId !== run.teamId
      || page.ownerId !== run.ownerId
      || page.runId !== run.id
      || page.shardId !== shard.id
      || page.providerCode !== shard.providerCode
      || position.sourceCheckpointNo !== page.checkpointNo
      || position.sourcePageSequence !== page.pageSequence
      || position.updatedAt !== page.createdAt
      || position.updatedAt < position.createdAt
      || (ledger
        ? ledger.connectionId !== position.connectionId
          || ledger.endpointCode !== position.endpointCode
          || ledger.providerCode !== position.providerCode
          || ledger.runId !== run.id
          || ledger.shardId !== shard.id
        : !allowedConnectionIds.has(position.connectionId))) {
      throw new Error("获客数据源续搜位置身份、来源或团队作用域无效");
    }
    sourcePositionIds.add(position.id);
    sourcePositionScopes.add(scope);
  }

  for (const checkpoint of store.prospectExecutionCheckpoints) {
    const attempts = attemptsByShard.get(checkpoint.shardId) || [];
    const sentAttempts = attempts.filter(
      (item) => item.checkpointCallNo > 0
    );
    const currentCalls = sentAttempts
      .filter((item) => item.checkpointNo === checkpoint.checkpointNo)
      .sort((left, right) =>
        left.checkpointCallNo - right.checkpointCallNo
      );
    const pages = (pagesByShard.get(checkpoint.shardId) || [])
      .sort((left, right) => left.pageSequence - right.pageSequence);
    const totals = pages.reduce(
      (sum, page) => ({
        accepted: sum.accepted + page.acceptedCount,
        raw: sum.raw + page.rawCount,
        invalid: sum.invalid + page.invalidCount,
        duplicate: sum.duplicate + page.duplicateCount
      }),
      { accepted: 0, raw: 0, invalid: 0, duplicate: 0 }
    );
    if (checkpoint.totalCallCount !== sentAttempts.length
      || checkpoint.checkpointCallCount !== currentCalls.length
      || currentCalls.some(
        (attempt, index) => attempt.checkpointCallNo !== index + 1
      )
      || checkpoint.pageSequence !== pages.length
      || pages.some((page, index) => page.pageSequence !== index + 1)
      || checkpoint.acceptedCount !== totals.accepted
      || checkpoint.rawCount !== totals.raw
      || checkpoint.invalidCount !== totals.invalid
      || checkpoint.duplicateCount !== totals.duplicate) {
      throw new Error("搜索执行 checkpoint 与调用或页摘要聚合不一致");
    }
  }

  const executionEventIds = new Set<string>();
  for (const event of store.prospectExecutionEvents) {
    const run = runs.get(event.runId);
    const shard = event.shardId ? shards.get(event.shardId) : null;
    const job = event.jobId ? jobs.get(event.jobId) : null;
    const parentBinding = parentBindingsByRun.get(event.runId);
    const childBinding = event.shardId
      ? childBindingsByShard.get(event.shardId)
      : null;
    if (executionEventIds.has(event.id)
      || !kernelState
      || !run
      || event.teamId !== run.teamId
      || event.ownerId !== run.ownerId
      || event.kernelEpoch < 1
      || event.kernelEpoch > kernelState.kernelEpoch
      || event.runEpoch < 1
      || event.runEpoch > run.executionEpoch
      || event.fenceToken < 0
      || !hashPattern.test(event.detailHash)
      || (event.shardId
        ? !shard
          || !job
          || !childBinding
          || shard.runId !== run.id
          || shard.teamId !== run.teamId
          || childBinding.jobId !== event.jobId
          || childBinding.runId !== run.id
        : event.jobId
          && (!job
            || !parentBinding
            || parentBinding.jobId !== event.jobId))) {
      throw new Error("搜索执行事件引用、epoch 或摘要无效");
    }
    executionEventIds.add(event.id);
  }

  const throttleIds = new Set<string>();
  const throttleScopes = new Set<string>();
  for (const throttle of store.prospectExecutionThrottleBuckets) {
    const expectedId = createHash("sha256").update([
      throttle.teamId,
      throttle.providerCode,
      throttle.connectionId
    ].join("\u001f")).digest("hex");
    const scope = [
      throttle.teamId,
      throttle.providerCode,
      throttle.connectionId
    ].join("|");
    if (throttleIds.has(throttle.id)
      || throttleScopes.has(scope)
      || throttle.id !== expectedId
      || !throttle.teamId
      || !throttle.providerCode
      || !throttle.connectionId
      || throttle.version < 1) {
      throw new Error("搜索执行限流桶作用域、版本或摘要无效");
    }
    throttleIds.add(throttle.id);
    throttleScopes.add(scope);
  }
  validateProspectProviderRequestPersistence(store);
}

function validateProspectProviderRequestPersistence(store: CrmStore) {
  const hashPattern = /^[a-f0-9]{64}$/;
  const evidenceRefPattern = /^sha256:[a-f0-9]{64}$/;
  const encryptedResponsePattern =
    /^provider-response-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const runs = new Map(
    store.prospectSearchRuns.map((item) => [item.id, item])
  );
  const shards = new Map(
    store.prospectRunShards.map((item) => [item.id, item])
  );
  const jobs = new Map(store.agentJobs.map((item) => [item.id, item]));
  const attempts = new Map(
    store.prospectExecutionAttempts.map((item) => [item.id, item])
  );
  const leases = new Map(
    store.prospectExecutionLeases.map((item) => [item.id, item])
  );
  const ledgersById = new Map<string, ProspectProviderRequestLedger>();
  const idempotencyScopes = new Set<string>();
  const logicalScopes = new Set<string>();
  const externalScopes = new Set<string>();

  for (const ledger of store.prospectProviderRequestLedgers) {
    const run = runs.get(ledger.runId);
    const shard = shards.get(ledger.shardId);
    const job = jobs.get(ledger.jobId);
    const attempt = attempts.get(ledger.originAttemptId);
    const lease = leases.get(ledger.leaseIdAtPrepare);
    const idempotencyScope = [
      ledger.teamId,
      ledger.ownerId,
      ledger.connectionId,
      ledger.endpointCode,
      ledger.idempotencyKey
    ].join("|");
    const logicalScope = [
      ledger.teamId,
      ledger.runId,
      ledger.shardId,
      ledger.checkpointNo,
      ledger.logicalRequestNo
    ].join("|");
    const externalScope = ledger.externalRequestId
      ? [
          ledger.teamId,
          ledger.providerCode,
          ledger.connectionId,
          ledger.endpointCode,
          ledger.externalRequestId
        ].join("|")
      : "";
    const responseHashes = [
      ledger.responseHash,
      ledger.rawResponseHash,
      ledger.normalizedResultHash,
      ledger.responseAccountingEvidenceHash
    ];
    const hasAllResponseHashes = responseHashes.every((item) =>
      hashPattern.test(item)
    );
    const hasAnyResponseHash = responseHashes.some(Boolean);
    const hasAnyResponseFact = Boolean(
      hasAnyResponseHash
      || ledger.encryptedResponseEnvelope
      || ledger.responseEvidenceRef
      || ledger.httpStatus !== null
      || ledger.providerOutcomeCode
      || ledger.responseReceivedAt
    );
    const hasAllResponseEvidence = Boolean(
      hasAllResponseHashes
      && ledger.externalRequestId
      && encryptedResponsePattern.test(ledger.encryptedResponseEnvelope)
      && evidenceRefPattern.test(ledger.responseEvidenceRef)
      && ledger.httpStatus !== null
      && ledger.providerOutcomeCode
      && ledger.responseReceivedAt
    );
    const expectedResponseHash = hasAllResponseHashes
      && ledger.externalRequestId
      && ledger.httpStatus !== null
      ? prospectProviderResponseHash({
          contractVersion: ledger.contractVersion,
          requestHash: ledger.requestHash,
          idempotencyKey: ledger.idempotencyKey,
          providerCode: ledger.providerCode,
          connectionId: ledger.connectionId,
          endpointCode: ledger.endpointCode,
          externalRequestId: ledger.externalRequestId,
          httpStatus: ledger.httpStatus,
          rawResponseHash: ledger.rawResponseHash,
          normalizedResultHash: ledger.normalizedResultHash,
          accountingEvidenceHash:
            ledger.responseAccountingEvidenceHash
        })
      : "";
    const hasDispatchConfirmation = Boolean(
      ledger.externalRequestId || ledger.dispatchConfirmationRef
    );
    const responseLeaseFactsValid =
      ledger.status !== "response_received"
      || (attempt?.status === "request_started"
        && ["released", "expired"].includes(lease?.status || "")
        && lease?.releaseReason === "RESPONSE_RECEIVED_PENDING_SETTLEMENT"
        && Boolean(lease?.releasedAt)
        && lease!.releasedAt >= ledger.responseReceivedAt)
      || (attempt?.status === "request_outcome_unknown"
        && ["released", "expired"].includes(lease?.status || "")
        && [
          "REQUEST_OUTCOME_UNKNOWN",
          "CANCELLED_REQUEST_OUTCOME_UNKNOWN"
        ].includes(lease?.releaseReason || "")
        && Boolean(lease?.releasedAt)
        && lease!.releasedAt <= ledger.responseReceivedAt);
    const invalidStatusFacts =
      ledger.status === "prepared"
        ? ledger.dispatchStartedAt
          || ledger.dispatchConfirmedAt
          || hasDispatchConfirmation
          || ledger.responseReceivedAt
          || ledger.unknownAt
          || ledger.unknownReason
          || ledger.settledAt
          || ledger.cancelledLateAt
          || ledger.settlementKind
          || ledger.settlementHash
          || hasAnyResponseFact
        : ledger.status === "dispatch_started"
          ? !ledger.dispatchStartedAt
            || ledger.dispatchConfirmedAt
            || hasDispatchConfirmation
            || ledger.responseReceivedAt
            || ledger.unknownAt
            || ledger.unknownReason
            || ledger.settledAt
            || ledger.cancelledLateAt
            || ledger.settlementKind
            || ledger.settlementHash
            || hasAnyResponseFact
          : ledger.status === "dispatch_confirmed"
            ? !ledger.dispatchStartedAt
              || !ledger.dispatchConfirmedAt
              || !hasDispatchConfirmation
              || ledger.responseReceivedAt
              || ledger.unknownAt
              || ledger.unknownReason
              || ledger.settledAt
              || ledger.cancelledLateAt
              || ledger.settlementKind
              || ledger.settlementHash
              || hasAnyResponseFact
            : ledger.status === "response_received"
              ? !ledger.dispatchStartedAt
                || !ledger.dispatchConfirmedAt
                || !hasDispatchConfirmation
                || !ledger.responseReceivedAt
                || !hasAllResponseEvidence
                || ledger.settledAt
                || ledger.cancelledLateAt
                || ledger.settlementKind
                || ledger.settlementHash
              : ledger.status === "outcome_unknown"
                ? !ledger.dispatchStartedAt
                  || !ledger.unknownAt
                  || !ledger.unknownReason
                  || ledger.responseReceivedAt
                  || ledger.settledAt
                  || ledger.cancelledLateAt
                  || ledger.settlementKind
                  || ledger.settlementHash
                  || hasAnyResponseFact
                : ledger.status === "settled"
                  ? !ledger.settledAt
                    || !ledger.settlementKind
                    || !ledger.settlementHash
                    || ![
                      "success",
                      "failure",
                      "cancelled_before_dispatch"
                    ].includes(ledger.settlementKind)
                    || ledger.cancelledLateAt
                    || (ledger.settlementKind === "cancelled_before_dispatch"
                      ? Boolean(ledger.dispatchStartedAt)
                        || hasAnyResponseFact
                      : !ledger.responseReceivedAt
                        || !hasAllResponseEvidence)
                  : !ledger.dispatchStartedAt
                    || !ledger.cancelledLateAt
                    || ledger.settlementKind !== "cancelled_late"
                    || !ledger.settlementHash
                    || ledger.settledAt
                    || !hasAllResponseEvidence;
    if (ledgersById.has(ledger.id)
      || idempotencyScopes.has(idempotencyScope)
      || logicalScopes.has(logicalScope)
      || (externalScope && externalScopes.has(externalScope))
      || !run
      || !shard
      || !job
      || !attempt
      || !lease
      || ledger.teamId !== run.teamId
      || ledger.ownerId !== run.ownerId
      || shard.teamId !== ledger.teamId
      || shard.runId !== ledger.runId
      || shard.providerCode !== ledger.providerCode
      || job.teamId !== ledger.teamId
      || job.ownerId !== ledger.ownerId
      || attempt.teamId !== ledger.teamId
      || attempt.ownerId !== ledger.ownerId
      || attempt.runId !== ledger.runId
      || attempt.shardId !== ledger.shardId
      || attempt.jobId !== ledger.jobId
      || attempt.providerCode !== ledger.providerCode
      || attempt.checkpointNo !== ledger.checkpointNo
      || lease.teamId !== ledger.teamId
      || lease.ownerId !== ledger.ownerId
      || lease.runId !== ledger.runId
      || lease.shardId !== ledger.shardId
      || lease.jobId !== ledger.jobId
      || ledger.checkpointNo < 1
      || ledger.logicalRequestNo < 1
      || !ledger.providerCode
      || !ledger.connectionId
      || !ledger.connectionRevision
      || !ledger.endpointCode
      || !ledger.adapterVersion
      || !ledger.contractVersion
      || !ledger.requestSchemaVersion
      || !hashPattern.test(ledger.connectionConfigHash)
      || !hashPattern.test(ledger.idempotencyKey)
      || !hashPattern.test(ledger.requestHash)
      || (ledger.dispatchConfirmationRef
        && !evidenceRefPattern.test(ledger.dispatchConfirmationRef))
      || (ledger.settlementHash
        && !hashPattern.test(ledger.settlementHash))
      || (hasAnyResponseHash && !hasAllResponseHashes)
      || (hasAnyResponseFact
        && (!hasAllResponseEvidence
          || ledger.responseHash !== expectedResponseHash))
      || (ledger.httpStatus !== null
        && (!Number.isInteger(ledger.httpStatus)
          || ledger.httpStatus < 100
          || ledger.httpStatus > 599))
      || ledger.kernelEpochAtPrepare < 1
      || ledger.runEpochAtPrepare < 1
      || ledger.fenceTokenAtPrepare < 1
      || ledger.kernelEpochAtPrepare !== lease.kernelEpoch
      || ledger.runEpochAtPrepare !== lease.runEpoch
      || ledger.fenceTokenAtPrepare !== lease.fenceToken
      || !responseLeaseFactsValid
      || ledger.version < 1
      || !ledger.preparedAt
      || ledger.updatedAt < ledger.preparedAt
      || (ledger.dispatchStartedAt
        && ledger.dispatchStartedAt < ledger.preparedAt)
      || (ledger.dispatchConfirmedAt
        && (!ledger.dispatchStartedAt
          || ledger.dispatchConfirmedAt < ledger.dispatchStartedAt))
      || (ledger.responseReceivedAt
        && (!ledger.dispatchStartedAt
          || ledger.responseReceivedAt < ledger.dispatchStartedAt))
      || (ledger.unknownAt
        && (!ledger.dispatchStartedAt
          || ledger.unknownAt < ledger.dispatchStartedAt))
      || (ledger.settledAt && ledger.settledAt < ledger.preparedAt)
      || (ledger.cancelledLateAt
        && ledger.cancelledLateAt < ledger.dispatchStartedAt)
      || invalidStatusFacts) {
      throw new Error("Provider 请求账本身份、哈希、时间或状态无效");
    }
    ledgersById.set(ledger.id, ledger);
    idempotencyScopes.add(idempotencyScope);
    logicalScopes.add(logicalScope);
    if (externalScope) externalScopes.add(externalScope);
  }

  const bindingsByLedger =
    new Map<string, ProspectProviderRequestAttemptBinding[]>();
  const bindingIds = new Set<string>();
  const bindingScopes = new Set<string>();
  for (const binding of store.prospectProviderRequestAttemptBindings) {
    const ledger = ledgersById.get(binding.ledgerId);
    const attempt = attempts.get(binding.attemptId);
    const scope = [
      binding.teamId,
      binding.ledgerId,
      binding.attemptId
    ].join("|");
    if (bindingIds.has(binding.id)
      || bindingScopes.has(scope)
      || !ledger
      || !attempt
      || binding.teamId !== ledger.teamId
      || binding.ownerId !== ledger.ownerId
      || attempt.teamId !== ledger.teamId
      || attempt.ownerId !== ledger.ownerId
      || attempt.runId !== ledger.runId
      || attempt.shardId !== ledger.shardId
      || attempt.jobId !== ledger.jobId
      || attempt.providerCode !== ledger.providerCode
      || binding.bindingNo < 1) {
      throw new Error("Provider 请求尝试绑定引用或序号无效");
    }
    bindingIds.add(binding.id);
    bindingScopes.add(scope);
    const grouped = bindingsByLedger.get(binding.ledgerId) || [];
    grouped.push(binding);
    bindingsByLedger.set(binding.ledgerId, grouped);
  }
  for (const ledger of store.prospectProviderRequestLedgers) {
    const bindings = (bindingsByLedger.get(ledger.id) || [])
      .sort((left, right) => left.bindingNo - right.bindingNo);
    if (!bindings.length
      || bindings[0]?.attemptId !== ledger.originAttemptId
      || bindings.some((item, index) => item.bindingNo !== index + 1)) {
      throw new Error("Provider 请求账本缺少连续的执行尝试绑定");
    }
  }

  const dispatchesById =
    new Map<string, ProspectProviderRequestDispatch>();
  const dispatchesByLedger =
    new Map<string, ProspectProviderRequestDispatch[]>();
  const dispatchScopes = new Set<string>();
  for (const dispatch of store.prospectProviderRequestDispatches) {
    const ledger = ledgersById.get(dispatch.ledgerId);
    const attempt = attempts.get(dispatch.attemptId);
    const bindingScope = [
      dispatch.teamId,
      dispatch.ledgerId,
      dispatch.attemptId
    ].join("|");
    const dispatchScope = [
      dispatch.teamId,
      dispatch.ledgerId,
      dispatch.dispatchNo
    ].join("|");
    if (dispatchesById.has(dispatch.id)
      || dispatchScopes.has(dispatchScope)
      || !ledger
      || !attempt
      || !bindingScopes.has(bindingScope)
      || dispatch.teamId !== ledger.teamId
      || dispatch.ownerId !== ledger.ownerId
      || dispatch.runId !== ledger.runId
      || dispatch.shardId !== ledger.shardId
      || attempt.teamId !== ledger.teamId
      || dispatch.dispatchNo < 1
      || dispatch.idempotencyKey !== ledger.idempotencyKey
      || dispatch.requestHash !== ledger.requestHash
      || (dispatch.operation !== "dispatch"
        && dispatch.providerExecuted)
      || (dispatch.responseHash
        && !hashPattern.test(dispatch.responseHash))
      || !dispatch.startedAt
      || (dispatch.confirmedAt
        && dispatch.confirmedAt < dispatch.startedAt)
      || (dispatch.finishedAt
        && dispatch.finishedAt < dispatch.startedAt)
      || dispatch.version < 1
      || !hasValidProspectProviderDispatchStatusFacts(dispatch)) {
      throw new Error("Provider 请求派发记录引用、状态或证据无效");
    }
    dispatchesById.set(dispatch.id, dispatch);
    dispatchScopes.add(dispatchScope);
    const grouped = dispatchesByLedger.get(dispatch.ledgerId) || [];
    grouped.push(dispatch);
    dispatchesByLedger.set(dispatch.ledgerId, grouped);
  }
  for (const dispatches of dispatchesByLedger.values()) {
    dispatches.sort((left, right) => left.dispatchNo - right.dispatchNo);
    if (dispatches.some(
      (item, index) => item.dispatchNo !== index + 1
    )) {
      throw new Error("Provider 请求派发序号不连续");
    }
  }
  for (const ledger of store.prospectProviderRequestLedgers) {
    const dispatches = dispatchesByLedger.get(ledger.id) || [];
    const responseDispatch = dispatches.find(
      (item) => item.status === "response_received"
    );
    const responsePersisted = [
      "response_received",
      "settled",
      "cancelled_late"
    ].includes(ledger.status)
      && ledger.settlementKind !== "cancelled_before_dispatch";
    if (responsePersisted) {
      if (!responseDispatch
        || dispatches.filter(
          (item) => item.status === "response_received"
        ).length !== 1
        || responseDispatch.externalRequestId
          !== ledger.externalRequestId
        || responseDispatch.responseHash !== ledger.responseHash
        || responseDispatch.confirmedAt !== ledger.dispatchConfirmedAt
        || responseDispatch.finishedAt !== ledger.responseReceivedAt
        || ledger.dispatchConfirmationRef
          !== prospectProviderDispatchConfirmationRef({
            ledgerId: ledger.id,
            dispatchId: responseDispatch.id,
            externalRequestId: ledger.externalRequestId,
            responseHash: ledger.responseHash
          })
        || ledger.responseEvidenceRef
          !== prospectProviderResponseEvidenceRef({
            ledgerId: ledger.id,
            dispatchId: responseDispatch.id,
            requestHash: ledger.requestHash,
            idempotencyKey: ledger.idempotencyKey,
            externalRequestId: ledger.externalRequestId,
            responseHash: ledger.responseHash
          })) {
        throw new Error("Provider 响应账本与派发证据不一致");
      }
    } else if (responseDispatch) {
      throw new Error("Provider 派发响应状态缺少对应账本事实");
    }
  }

  const eventsByLedger = new Map<string, ProspectProviderRequestEvent[]>();
  const eventIds = new Set<string>();
  for (const event of store.prospectProviderRequestEvents) {
    const ledger = ledgersById.get(event.ledgerId);
    const attempt = attempts.get(event.attemptId);
    const dispatch = event.dispatchId
      ? dispatchesById.get(event.dispatchId)
      : null;
    if (eventIds.has(event.id)
      || !ledger
      || !attempt
      || event.teamId !== ledger.teamId
      || event.ownerId !== ledger.ownerId
      || attempt.teamId !== ledger.teamId
      || attempt.ownerId !== ledger.ownerId
      || attempt.runId !== ledger.runId
      || attempt.shardId !== ledger.shardId
      || (event.dispatchId
        && (!dispatch
          || dispatch.ledgerId !== ledger.id
          || dispatch.attemptId !== event.attemptId))
      || event.sequence < 1
      || event.eventType !== event.toStatus
      || !hashPattern.test(event.detailHash)) {
      throw new Error("Provider 请求状态事件引用或摘要无效");
    }
    if (event.eventType === "dispatch_confirmed") {
      if (!dispatch
        || event.createdAt !== ledger.dispatchConfirmedAt
        || event.detailHash !== sha256CanonicalJson({
          contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          requestHash: ledger.requestHash,
          externalRequestId: ledger.externalRequestId,
          confirmationRef: ledger.dispatchConfirmationRef,
          replayed: dispatch.replayed,
          status: "dispatch_confirmed"
        })) {
        throw new Error("Provider 派发确认事件摘要无效");
      }
    }
    if (event.eventType === "response_received") {
      if (!dispatch
        || event.createdAt !== ledger.responseReceivedAt
        || event.detailHash !== sha256CanonicalJson({
          contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
          ledgerId: ledger.id,
          dispatchId: dispatch.id,
          requestHash: ledger.requestHash,
          externalRequestId: ledger.externalRequestId,
          responseEvidenceRef: ledger.responseEvidenceRef,
          responseHash: ledger.responseHash,
          rawResponseHash: ledger.rawResponseHash,
          normalizedResultHash: ledger.normalizedResultHash,
          accountingEvidenceHash:
            ledger.responseAccountingEvidenceHash,
          httpStatus: ledger.httpStatus,
          providerOutcomeCode: ledger.providerOutcomeCode,
          status: "response_received"
        })) {
        throw new Error("Provider 响应接收事件摘要无效");
      }
    }
    eventIds.add(event.id);
    const grouped = eventsByLedger.get(event.ledgerId) || [];
    grouped.push(event);
    eventsByLedger.set(event.ledgerId, grouped);
  }
  for (const ledger of store.prospectProviderRequestLedgers) {
    const events = (eventsByLedger.get(ledger.id) || [])
      .sort((left, right) => left.sequence - right.sequence);
    if (events.length !== ledger.version
      || events[0]?.sequence !== 1
      || events[0]?.fromStatus !== ""
      || events[0]?.toStatus !== "prepared"
      || events[0]?.eventType !== "prepared"
      || events[0]?.attemptId !== ledger.originAttemptId
      || events.some((event, index) =>
        event.sequence !== index + 1
        || (index > 0
          && (event.fromStatus !== events[index - 1]?.toStatus
            || !isProspectProviderRequestTransitionAllowed(
              event.fromStatus as ProspectProviderRequestLedger["status"],
              event.toStatus
            )))
      )
      || events.at(-1)?.toStatus !== ledger.status
      || events.at(-1)?.createdAt !== ledger.updatedAt) {
      throw new Error("Provider 请求账本版本与状态事件链不一致");
    }
  }

  const accountingByLedger =
    new Map<string, ProspectProviderRequestAccountingEvidence[]>();
  const accountingIds = new Set<string>();
  for (const evidence of store.prospectProviderRequestAccountingEvidence) {
    const ledger = ledgersById.get(evidence.ledgerId);
    if (accountingIds.has(evidence.id)
      || !ledger
      || evidence.teamId !== ledger.teamId
      || evidence.ownerId !== ledger.ownerId
      || evidence.sequence < 1
      || !evidenceRefPattern.test(evidence.evidenceRef)
      || !hashPattern.test(evidence.evidenceHash)
      || !evidence.createdAt
      || (evidence.costAmount !== null
        && (!Number.isFinite(evidence.costAmount)
          || evidence.costAmount < 0
          || !/^[A-Z]{3}$/.test(evidence.currency)))
      || (evidence.costAmount === null && evidence.currency)
      || (evidence.provenance === "unknown"
        && evidence.costAmount !== null)
      || (evidence.provenance === "estimated"
        ? !evidence.estimationMethodVersion
        : Boolean(evidence.estimationMethodVersion))) {
      throw new Error("Provider 请求用量或成本证据无效");
    }
    if (evidence.usageJson) {
      try {
        const usage = JSON.parse(evidence.usageJson);
        if (!usage
          || Array.isArray(usage)
          || typeof usage !== "object"
          || hasForbiddenExecutionFactKey(usage)) {
          throw new Error("invalid usage");
        }
      } catch {
        throw new Error("Provider 请求用量证据不是安全 JSON");
      }
    }
    accountingIds.add(evidence.id);
    const grouped = accountingByLedger.get(evidence.ledgerId) || [];
    grouped.push(evidence);
    accountingByLedger.set(evidence.ledgerId, grouped);
  }
  for (const evidence of accountingByLedger.values()) {
    evidence.sort((left, right) => left.sequence - right.sequence);
    if (evidence.some((item, index) => item.sequence !== index + 1)) {
      throw new Error("Provider 请求成本证据序号不连续");
    }
  }
  for (const ledger of store.prospectProviderRequestLedgers) {
    const accounting =
      accountingByLedger.get(ledger.id) || [];
    const responseDispatches =
      (dispatchesByLedger.get(ledger.id) || []).filter(
        (item) => item.status === "response_received"
      );
    const responseDispatch = responseDispatches[0];
    const responseAttempt = responseDispatch
      ? attempts.get(responseDispatch.attemptId)
      : null;
    const responsePages = responseAttempt
      ? store.prospectExecutionPages.filter((item) =>
          item.attemptId === responseAttempt.id
          && item.teamId === ledger.teamId
          && item.ownerId === ledger.ownerId
          && item.runId === ledger.runId
          && item.shardId === ledger.shardId
          && item.jobId === ledger.jobId
        )
      : [];
    const events = eventsByLedger.get(ledger.id) || [];
    const settlementEvent = events.at(-1);

    if (ledger.settlementKind === "cancelled_before_dispatch") {
      const expectedSettlementHash = sha256CanonicalJson({
        contract: PROSPECT_PROVIDER_REQUEST_LEDGER_CONTRACT,
        ledgerId: ledger.id,
        requestHash: ledger.requestHash,
        settlementKind: "cancelled_before_dispatch",
        settledAt: ledger.settledAt
      });
      if (ledger.status !== "settled"
        || accounting.length
        || responseDispatches.length
        || ledger.settlementHash !== expectedSettlementHash
        || settlementEvent?.eventType !== "settled"
        || settlementEvent.fromStatus !== "prepared"
        || settlementEvent.dispatchId
        || settlementEvent.detailHash !== expectedSettlementHash
        || settlementEvent.createdAt !== ledger.settledAt) {
        throw new Error("Provider 请求发出前取消结算事实无效");
      }
      continue;
    }

    const hasResponseSettlement =
      (ledger.status === "settled"
        && (ledger.settlementKind === "success"
          || ledger.settlementKind === "failure"))
      || (ledger.status === "cancelled_late"
        && ledger.settlementKind === "cancelled_late");
    if (!hasResponseSettlement) {
      if (accounting.length) {
        throw new Error("Provider 响应结算前不允许写入成本证据");
      }
      if (ledger.status === "response_received") {
        if (responseDispatches.length !== 1
          || !responseAttempt
          || !["request_started", "request_outcome_unknown"].includes(
            responseAttempt.status
          )
          || responseAttempt.responseHash
          || responseAttempt.usageJson
          || responseAttempt.costKind !== "unknown"
          || responseAttempt.costAmount !== null
          || responseAttempt.currency
          || responsePages.length) {
          throw new Error("Provider 待结算响应已混入最终执行事实");
        }
      }
      continue;
    }
    if (ledger.settlementKind !== "success"
      && ledger.settlementKind !== "failure"
      && ledger.settlementKind !== "cancelled_late") {
      throw new Error("Provider 响应结算类型无效");
    }
    const settlementKind = ledger.settlementKind;

    const evidence = accounting[0];
    const page = responsePages[0];
    const settlementAt = ledger.status === "cancelled_late"
      ? ledger.cancelledLateAt
      : ledger.settledAt;
    const expectedAttemptStatus = settlementKind === "success"
      ? "succeeded"
      : settlementKind === "failure"
        ? "failed"
        : "cancelled_late";
    const expectedPageCount =
      settlementKind === "success" ? 1 : 0;
    if (responseDispatches.length !== 1
      || !responseDispatch
      || !responseAttempt
      || accounting.length !== 1
      || !evidence
      || responsePages.length !== expectedPageCount
      || responseAttempt.status !== expectedAttemptStatus
      || responseAttempt.responseHash !== ledger.responseHash
      || responseAttempt.finishedAt !== settlementAt
      || !responseAttempt.usageJson
      || evidence.sequence !== 1
      || evidence.createdAt !== settlementAt
      || evidence.usageJson !== responseAttempt.usageJson
      || evidence.costAmount !== responseAttempt.costAmount
      || evidence.currency !== responseAttempt.currency
      || (settlementKind === "success"
        && (responseAttempt.errorCode
          || responseAttempt.errorMessage
          || responseAttempt.retryable
          || responseAttempt.retryAfterAt))
      || (settlementKind === "failure"
        && (!responseAttempt.errorCode || !responseAttempt.errorMessage))
      || (settlementKind === "cancelled_late"
        && (!responseAttempt.errorCode
          || !responseAttempt.errorMessage
          || responseAttempt.retryable
          || responseAttempt.retryAfterAt))) {
      throw new Error("Provider 响应结算与 Attempt、成本或 Page 不一致");
    }

    let usage: unknown;
    try {
      usage = JSON.parse(evidence.usageJson);
    } catch {
      throw new Error("Provider 响应结算成本用量不是有效 JSON");
    }
    const expectedProvenance = responseAttempt.costKind === "actual"
      ? "provider_reported"
      : responseAttempt.costKind;
    const expectedEstimationVersion =
      responseAttempt.costKind === "estimated"
        ? "fake-provider-estimate-v1"
        : "";
    const expectedEvidenceHash = prospectProviderAccountingEvidenceHash({
      usage,
      cost: {
        kind: responseAttempt.costKind,
        amount: responseAttempt.costAmount,
        currency: responseAttempt.currency
      }
    });
    const expectedEvidenceRef = prospectProviderAccountingEvidenceRef({
      ledgerId: ledger.id,
      responseHash: ledger.responseHash,
      accountingEvidenceHash: expectedEvidenceHash
    });
    if (canonicalJsonStringify(usage) !== evidence.usageJson
      || evidence.provenance !== expectedProvenance
      || evidence.estimationMethodVersion !== expectedEstimationVersion
      || evidence.evidenceHash !== expectedEvidenceHash
      || evidence.evidenceHash
        !== ledger.responseAccountingEvidenceHash
      || evidence.evidenceRef !== expectedEvidenceRef) {
      throw new Error("Provider 响应结算成本证据来源、摘要或引用无效");
    }

    const expectedSettlementHash = prospectProviderSettlementHash({
      contractVersion: ledger.contractVersion,
      teamId: ledger.teamId,
      ownerId: ledger.ownerId,
      runId: ledger.runId,
      ledgerId: ledger.id,
      requestHash: ledger.requestHash,
      idempotencyKey: ledger.idempotencyKey,
      externalRequestId: ledger.externalRequestId,
      responseHash: ledger.responseHash,
      dispatchId: responseDispatch.id,
      attemptId: responseAttempt.id,
      settlementKind,
      settlementAt,
      attempt: responseAttempt,
      accountingEvidence: evidence,
      page: page || null
    });
    if (ledger.settlementHash !== expectedSettlementHash
      || settlementEvent?.eventType !== ledger.status
      || settlementEvent.fromStatus !== "response_received"
      || settlementEvent.dispatchId !== responseDispatch.id
      || settlementEvent.attemptId !== responseAttempt.id
      || settlementEvent.detailHash !== expectedSettlementHash
      || settlementEvent.createdAt !== settlementAt) {
      throw new Error("Provider 响应结算事件或不可变摘要无效");
    }
  }
}

function hasForbiddenExecutionFactKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const forbidden =
    /(authorization|credential|api.?key|secret|header|cookie|candidate|customer|lead|opportunit|raw.?response|raw.?payload)/i;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      forbidden.test(key)
      || (typeof nested === "object"
        && hasForbiddenExecutionFactKey(nested))
  );
}

function validateFormalCampaignNamespace(store: CrmStore) {
  const ambiguous = store.agentJobs.some((item) =>
    item.aggregateType === "prospect_campaign_ref_compat_v1"
    && item.aggregateId.startsWith("pc_")
  ) || store.marketTradeObservations.some((item) =>
    item.campaignId.startsWith("pc_")
  ) || store.marketOpportunityBatches.some((item) =>
    item.campaignId.startsWith("pc_")
  ) || store.marketOpportunitySnapshots.some((item) =>
    item.campaignId.startsWith("pc_")
  ) || store.marketOpportunityCalculationEvents.some((item) =>
    item.campaignId.startsWith("pc_")
  );
  if (ambiguous) {
    throw new Error("检测到 pc_ 正式命名空间中的旧兼容市场数据，请先完成人工迁移");
  }
}

function parseMarketOpportunityPersistence<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label}持久化校验失败`, { cause: parsed.error });
  }
  return parsed.data;
}

async function loadMarketOpportunityBatches(
  pool: MysqlQuerySource
): Promise<MarketOpportunityBatch[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM market_opportunity_batches ORDER BY created_at DESC"
  )).map((row) => parseMarketOpportunityPersistence(
    marketOpportunityBatchPersistenceSchema,
    {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    providerId: row.provider_id,
    datasetFingerprint: row.dataset_fingerprint,
    policyVersion: row.policy_version,
    status: row.status,
    emptyReason: row.empty_reason || "",
    candidateCount: Number(row.candidate_count),
    readyCount: Number(row.ready_count),
    comparisonPeriods: mysqlJson(row.comparison_periods_json),
    firstTriggerJobId: row.first_trigger_job_id,
    observationCutoffAt: row.observation_cutoff_at
      ? mysqlIsoDate(row.observation_cutoff_at)
      : null,
      createdAt: mysqlIsoDate(row.created_at)
    },
    "市场机会事实批次"
  ));
}

async function loadMarketOpportunitySnapshots(
  pool: MysqlQuerySource
): Promise<MarketOpportunitySnapshot[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM market_opportunity_snapshots ORDER BY created_at DESC, id DESC"
  )).map((row) => parseMarketOpportunityPersistence(
    marketOpportunitySnapshotPersistenceSchema,
    {
    id: row.id,
    batchId: row.batch_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    providerId: row.provider_id,
    reporterCountry: row.reporter_country,
    reporterCode: row.reporter_code || "",
    classification: row.classification,
    commodityCode: row.commodity_code,
    commodityDescription: row.commodity_description || "",
    comparisonPeriod: row.comparison_period || "",
    snapshotStatus: row.snapshot_status,
    insufficiencyReasons: mysqlJson(row.insufficiency_reasons_json),
    metrics: mysqlJson(row.metrics_json),
    marketScore: row.market_score === null ? null : Number(row.market_score),
    growthScore: row.growth_score === null ? null : Number(row.growth_score),
    chinaSupplyScore: row.china_supply_score === null ? null : Number(row.china_supply_score),
      createdAt: mysqlIsoDate(row.created_at)
    },
    "市场机会事实快照"
  ));
}

async function loadMarketOpportunityCalculationEvents(
  pool: MysqlQuerySource
): Promise<MarketOpportunityCalculationEvent[]> {
  return (await rows<Record<string, any>>(
    pool,
    "SELECT * FROM market_opportunity_calculation_events ORDER BY sequence_no DESC"
  )).map((row) => parseMarketOpportunityPersistence(
    marketOpportunityCalculationPersistenceSchema,
    {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    triggerJobId: row.trigger_job_id,
    batchId: row.batch_id,
    datasetFingerprint: row.dataset_fingerprint,
    policyVersion: row.policy_version,
    outcome: row.outcome,
    reusedBatch: Boolean(row.reused_batch),
    sequence: Number(row.sequence_no),
      calculatedAt: mysqlIsoDate(row.calculated_at)
    },
    "市场机会计算事件"
  ));
}

function validateMarketOpportunityPersistence(store: CrmStore) {
  for (const batch of store.marketOpportunityBatches) {
    marketOpportunityBatchPersistenceSchema.parse(batch);
  }
  for (const snapshot of store.marketOpportunitySnapshots) {
    marketOpportunitySnapshotPersistenceSchema.parse(snapshot);
  }
  for (const event of store.marketOpportunityCalculationEvents) {
    marketOpportunityCalculationPersistenceSchema.parse(event);
  }

  const batches = new Map(store.marketOpportunityBatches.map((item) => [item.id, item]));
  const jobs = new Map(store.agentJobs.map((item) => [item.id, item]));
  const snapshotsByBatch = new Map<string, MarketOpportunitySnapshot[]>();
  const eventsByBatch = new Map<string, MarketOpportunityCalculationEvent[]>();
  const eventSequences = new Set<number>();

  for (const snapshot of store.marketOpportunitySnapshots) {
    const batch = batches.get(snapshot.batchId);
    if (!batch
      || batch.teamId !== snapshot.teamId
      || batch.ownerId !== snapshot.ownerId
      || batch.campaignId !== snapshot.campaignId
      || batch.providerId !== snapshot.providerId
      || snapshot.marketScore !== null
      || snapshot.growthScore !== null
      || snapshot.chinaSupplyScore !== null) {
      throw new Error("市场机会事实快照持久化校验失败");
    }
    const series = snapshot.metrics.reportedImportValueSeries;
    const periods = series.map((item) => Number(item.period));
    const validReadySeries = series.length === 3
      && snapshot.metrics.yoyChanges.length === 2
      && periods.every(Number.isInteger)
      && periods[1] === periods[0]! + 1
      && periods[2] === periods[1]! + 1
      && String(periods[2]) === snapshot.comparisonPeriod
      && series.every((point) =>
        point.evidence.providerId === snapshot.providerId
        && point.evidence.reporterCode === snapshot.reporterCode
        && point.evidence.partnerCode === "0"
        && point.evidence.classification === snapshot.classification
        && point.evidence.commodityCode === snapshot.commodityCode
      );
    if ((snapshot.snapshotStatus === "metrics_ready"
      && (!validReadySeries || snapshot.insufficiencyReasons.length))
      || (snapshot.snapshotStatus === "insufficient_data" && validReadySeries)) {
      throw new Error("市场机会事实快照指标结构校验失败");
    }
    if (snapshot.metrics.chinaMainlandEvidence
      && (snapshot.metrics.chinaMainlandEvidence.reporterCode !== snapshot.reporterCode
        || snapshot.metrics.chinaMainlandEvidence.partnerCode !== "156"
        || snapshot.metrics.chinaMainlandEvidence.classification !== snapshot.classification
        || snapshot.metrics.chinaMainlandEvidence.commodityCode !== snapshot.commodityCode)) {
      throw new Error("市场机会中国大陆份额证据校验失败");
    }
    const grouped = snapshotsByBatch.get(snapshot.batchId) || [];
    grouped.push(snapshot);
    snapshotsByBatch.set(snapshot.batchId, grouped);
  }

  for (const event of store.marketOpportunityCalculationEvents) {
    const batch = batches.get(event.batchId);
    const job = jobs.get(event.triggerJobId);
    if (!batch
      || !job
      || job.teamId !== event.teamId
      || job.ownerId !== event.ownerId
      || job.jobType !== "prospect.market_analysis"
      || job.aggregateId !== event.campaignId
      || batch.teamId !== event.teamId
      || batch.ownerId !== event.ownerId
      || batch.campaignId !== event.campaignId
      || batch.datasetFingerprint !== event.datasetFingerprint
      || batch.policyVersion !== event.policyVersion
      || batch.status !== event.outcome
      || eventSequences.has(event.sequence)) {
      throw new Error("市场机会计算事件持久化校验失败");
    }
    eventSequences.add(event.sequence);
    const grouped = eventsByBatch.get(event.batchId) || [];
    grouped.push(event);
    eventsByBatch.set(event.batchId, grouped);
  }

  for (const batch of store.marketOpportunityBatches) {
    const snapshots = snapshotsByBatch.get(batch.id) || [];
    const events = eventsByBatch.get(batch.id) || [];
    const firstJob = jobs.get(batch.firstTriggerJobId);
    const readyCount = snapshots.filter(
      (item) => item.snapshotStatus === "metrics_ready"
    ).length;
    const expectedStatus = snapshots.length > 0 && readyCount === snapshots.length
      ? "metrics_ready"
      : readyCount > 0
        ? "partial"
        : "insufficient_data";
    if (!firstJob
      || firstJob.teamId !== batch.teamId
      || firstJob.ownerId !== batch.ownerId
      || firstJob.jobType !== "prospect.market_analysis"
      || firstJob.aggregateId !== batch.campaignId
      || !events.some((event) => event.triggerJobId === batch.firstTriggerJobId)
      || snapshots.length !== batch.candidateCount
      || readyCount !== batch.readyCount
      || expectedStatus !== batch.status
      || (batch.candidateCount === 0 && batch.emptyReason !== "no_eligible_observations")
      || (batch.candidateCount > 0 && !batch.observationCutoffAt)) {
      throw new Error("市场机会事实批次持久化校验失败");
    }
  }
}

async function loadAgentJobs(pool: MysqlQuerySource): Promise<AgentJob[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM agent_jobs ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    jobType: row.job_type,
    aggregateType: row.aggregate_type || "",
    aggregateId: row.aggregate_id || "",
    parentJobId: row.parent_job_id || "",
    status: row.status,
    priority: Number(row.priority || 0),
    idempotencyKey: row.idempotency_key,
    policyVersion: row.policy_version || "v1",
    inputJsonEncrypted: row.input_json_encrypted,
    outputJsonEncrypted: row.output_json_encrypted || "",
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 3),
    nextAttemptAt: row.next_attempt_at instanceof Date ? row.next_attempt_at.toISOString() : row.next_attempt_at || "",
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    traceId: row.trace_id,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at || "",
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadAgentJobIdempotencyAliases(
  pool: MysqlQuerySource
): Promise<AgentJobIdempotencyAlias[]> {
  return (await rows<Record<string, any>>(
    pool,
    `SELECT alias.*
     FROM agent_job_idempotency_aliases alias
     INNER JOIN agent_jobs job ON job.id = alias.job_id
     ORDER BY alias.created_at DESC`
  )).map((row) => ({
    id: row.id,
    jobId: row.job_id,
    teamId: row.team_id,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadProblems(pool: mysql.Pool): Promise<ProblemItem[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM problems ORDER BY status = 'resolved' ASC, created_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    severity: row.severity,
    status: row.status,
    ownerId: row.owner_id,
    teamId: row.team_id,
    relatedCustomer: row.related_customer,
    rootCause: row.root_cause,
    solution: row.solution,
    nextAction: row.next_action,
    dueAt: row.due_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadMemos(pool: mysql.Pool): Promise<Memo[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM memos ORDER BY pinned DESC, archived ASC, updated_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags,
    customerId: row.customer_id || "",
    dealId: row.deal_id || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadCompetitors(pool: mysql.Pool): Promise<Competitor[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM competitors ORDER BY threat_level = 'high' DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    company: row.company,
    country: row.country,
    segment: row.segment,
    threatLevel: row.threat_level,
    website: row.website,
    strengths: row.strengths,
    weaknesses: row.weaknesses,
    competingProducts: row.competing_products,
    ourStrategy: row.our_strategy,
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadCaseStudies(pool: mysql.Pool): Promise<CaseStudy[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM case_studies ORDER BY status = 'published' DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    customer: row.customer,
    country: row.country,
    product: row.product,
    industry: row.industry,
    result: row.result_text,
    story: row.story,
    reusablePoints: row.reusable_points,
    status: row.status,
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadCommissionProducts(pool: mysql.Pool): Promise<CommissionProduct[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_products ORDER BY status = 'active' DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category || "",
    model: row.model || "",
    currency: row.currency || "USD",
    defaultPrice: Number(row.default_price || 0),
    costPrice: Number(row.cost_price || 0),
    status: row.status || "active",
    remark: row.remark || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || new Date().toISOString()
  }));
}

async function loadCommissionRules(pool: mysql.Pool): Promise<CommissionRule[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_rules ORDER BY enabled DESC, created_at DESC")).map((row) => ({
    id: row.id,
    productId: row.product_id,
    ruleType: row.rule_type || "none",
    rate: Number(row.rate || 0),
    fixedAmount: Number(row.fixed_amount || 0),
    tierJson: row.tier_json || "",
    grossProfitRate: Number(row.gross_profit_rate || 0),
    effectiveFrom: row.effective_from || "",
    effectiveTo: row.effective_to || "",
    enabled: row.enabled === undefined || row.enabled === null ? true : Boolean(row.enabled),
    remark: row.remark || "",
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadMonthlySalesRecords(pool: mysql.Pool): Promise<MonthlySalesRecord[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM monthly_sales_records ORDER BY month_value DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    month: row.month_value,
    ownerId: row.owner_id,
    teamId: row.team_id,
    customerId: row.customer_id || "",
    customerName: row.customer_name || "",
    dealId: row.deal_id || "",
    productId: row.product_id || "",
    productName: row.product_name || "",
    quantity: Number(row.quantity || 0),
    unitPrice: Number(row.unit_price || 0),
    salesAmount: Number(row.sales_amount || 0),
    currency: row.currency || "USD",
    exchangeRate: Number(row.exchange_rate || 1),
    exchangeRateDate: row.exchange_rate_date || "",
    exchangeRateSource: row.exchange_rate_source || "pending",
    settlementCurrency: row.settlement_currency || "CNY",
    settlementAmount: Number(row.settlement_amount || 0),
    basisType: row.basis_type || "deal_amount",
    basisDate: row.basis_date || "",
    dealArchivedAt: row.deal_archived_at || "",
    sourceType: row.source_type || "manual",
    status: row.status || "draft",
    edited: Boolean(row.edited),
    editNote: row.edit_note || "",
    lastEditedBy: row.last_edited_by || "",
    lastEditedAt: row.last_edited_at instanceof Date ? row.last_edited_at.toISOString() : row.last_edited_at || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || new Date().toISOString()
  }));
}

async function loadSalesRecordAudits(pool: mysql.Pool): Promise<SalesRecordAudit[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM sales_record_audits ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    recordId: row.record_id,
    fieldName: row.field_name,
    oldValue: row.old_value || "",
    newValue: row.new_value || "",
    reason: row.reason || "",
    operatorId: row.operator_id,
    operatorName: row.operator_name || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadCommissionCalculations(pool: mysql.Pool): Promise<CommissionCalculation[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_calculations ORDER BY month_value DESC, calculated_at DESC")).map((row) => ({
    id: row.id,
    month: row.month_value,
    ownerId: row.owner_id,
    teamId: row.team_id,
    salesAmount: Number(row.sales_amount || 0),
    autoCommission: Number(row.auto_commission || 0),
    manualAdjustment: Number(row.manual_adjustment || 0),
    finalCommission: Number(row.final_commission || 0),
    status: row.status || "pending",
    version: Number(row.version_no || 1),
    isCurrent: row.is_current === undefined || row.is_current === null ? true : Boolean(row.is_current),
    calculatedAt: row.calculated_at instanceof Date ? row.calculated_at.toISOString() : row.calculated_at || "",
    reviewedBy: row.reviewed_by || "",
    reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at || "",
    lockedBy: row.locked_by || "",
    lockedAt: row.locked_at instanceof Date ? row.locked_at.toISOString() : row.locked_at || "",
    unlockReason: row.unlock_reason || ""
  }));
}

async function loadCommissionItems(pool: mysql.Pool): Promise<CommissionItem[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_items ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    calculationId: row.calculation_id,
    recordId: row.record_id || "",
    productId: row.product_id || "",
    itemType: row.item_type || "auto",
    sourceType: row.source_type || "auto",
    ruleSnapshotJson: row.rule_snapshot_json || "",
    salesAmount: Number(row.sales_amount || 0),
    autoAmount: Number(row.auto_amount || 0),
    manualAmount: Number(row.manual_amount || 0),
    finalAmount: Number(row.final_amount || 0),
    remark: row.remark || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadCommissionExports(pool: mysql.Pool): Promise<CommissionExport[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_exports ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    month: row.month_value,
    scopeType: row.scope_type || "self",
    scopeOwnerId: row.scope_owner_id || "",
    fileType: row.file_type || "xlsx",
    rows: Number(row.rows_count || 0),
    exportedBy: row.exported_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadWhatsAppBindings(pool: mysql.Pool): Promise<WhatsAppBinding[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM whatsapp_bindings ORDER BY last_message_at DESC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    phoneNumber: row.phone_number,
    waProfileName: row.wa_profile_name || "",
    lastMessageAt: row.last_message_at instanceof Date ? row.last_message_at.toISOString() : row.last_message_at || "",
    unreadCount: Number(row.unread_count || 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString(),
    bindingMode: row.binding_mode || "manual",
    userId: row.user_id || "",
    sessionData: row.session_data || "",
    twilioPhoneNumber: row.twilio_phone_number || "",
    connectionStatus: row.connection_status || "disconnected",
    lastConnectedAt: row.last_connected_at instanceof Date ? row.last_connected_at.toISOString() : row.last_connected_at || ""
  }));
}

async function loadWhatsAppMessages(pool: mysql.Pool): Promise<WhatsAppMessage[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM whatsapp_messages ORDER BY created_at ASC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    direction: row.direction as "inbound" | "outbound",
    content: row.content || "",
    contentTranslated: row.content_translated || "",
    mediaUrl: row.media_url || "",
    status: row.status || "",
    waMessageId: row.wa_message_id || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadDailyReports(pool: mysql.Pool): Promise<DailyReport[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM daily_reports ORDER BY report_date DESC, submitted_at DESC")).map((row) => ({
    id: row.id,
    reportDate: row.report_date,
    completedWork: row.completed_work || "",
    customerProgress: row.customer_progress || "",
    results: row.results_text || "",
    risks: row.risks_text || "",
    nextPlan: row.next_plan || "",
    supportNeeded: row.support_needed || "",
    status: "submitted",
    ownerId: row.owner_id,
    teamId: row.team_id,
    submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || ""
  }));
}

async function loadDailyReportComments(pool: mysql.Pool): Promise<DailyReportComment[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM daily_report_comments ORDER BY created_at ASC")).map((row) => ({
    id: row.id,
    reportId: row.report_id,
    parentId: row.parent_id || "",
    content: row.content || "",
    authorId: row.author_id,
    teamId: row.team_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || ""
  }));
}

async function loadInternalMessages(pool: mysql.Pool): Promise<InternalMessage[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM internal_messages ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    teamId: row.team_id,
    type: row.message_type === "system" ? "system" : "manual",
    subject: row.subject || "",
    content: row.content || "",
    relatedType: row.related_type || "",
    relatedId: row.related_id || "",
    readAt: row.read_at instanceof Date ? row.read_at.toISOString() : row.read_at || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || ""
  }));
}

async function persistAll(pool: mysql.Pool, store: CrmStore) {
  validateProspectCampaignPersistence(store);
  validateProspectRunPersistence(store);
  validateFormalCampaignNamespace(store);
  validateMarketOpportunityPersistence(store);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await replaceRows(connection, "users", store.users, (item) => [item.id, item.name, item.email, item.password, item.role, item.teamId, item.avatar, item.status, item.authVersion || 1, item.outboundEmail || "", item.emailSenderName ?? "", item.emailSignature || "", item.smtpHost || "", item.smtpPort || 465, item.smtpSecure ?? true, item.smtpUser || "", item.smtpPassword || "", item.lastDevelopmentEmailAt ? mysqlDate(item.lastDevelopmentEmailAt) : null, item.lastDevelopmentEmailTo || "", item.lastDevelopmentEmailSubject || "", item.reportNote || ""], "(id,name,email,password_hash,role,team_id,avatar,status,auth_version,outbound_email,email_sender_name,email_signature,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_password,last_development_email_at,last_development_email_to,last_development_email_subject,report_note)");
    await replaceRows(connection, "daily_reports", store.dailyReports, (item) => [item.id, item.reportDate, item.completedWork, item.customerProgress, item.results, item.risks, item.nextPlan, item.supportNeeded, item.status, item.ownerId, item.teamId, mysqlDate(item.submittedAt), mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,report_date,completed_work,customer_progress,results_text,risks_text,next_plan,support_needed,report_status,owner_id,team_id,submitted_at,created_at,updated_at)");
    await replaceRows(connection, "daily_report_comments", store.dailyReportComments, (item) => [item.id, item.reportId, item.parentId || "", item.content, item.authorId, item.teamId, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,report_id,parent_id,content,author_id,team_id,created_at,updated_at)");
    await replaceRows(connection, "internal_messages", store.internalMessages, (item) => [item.id, item.threadId, item.senderId, item.recipientId, item.teamId, item.type, item.subject, item.content, item.relatedType, item.relatedId, item.readAt ? mysqlDate(item.readAt) : null, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,thread_id,sender_id,recipient_id,team_id,message_type,subject,content,related_type,related_id,read_at,created_at,updated_at)");
    await replaceRows(connection, "customers", store.customers, (item) => [item.id, item.company, item.country, item.contact, item.ownerId, item.teamId, item.stage, item.amount, item.health, item.grade || "C", item.nextReminder, item.wecomBound, item.billingName || "", item.billingAddress || "", item.documentContact || "", item.defaultPortDischarge || "", item.defaultIncoterm || "", item.defaultPaymentTerm || "", item.poolStatus || "owned", item.previousOwnerId || "", item.releasedBy || "", item.releasedAt ? mysqlDate(item.releasedAt) : null, item.releaseReason || "", item.claimedAt ? mysqlDate(item.claimedAt) : null, item.ownershipVersion || 0], "(id,company,country,contact,owner_id,team_id,stage,amount,health,customer_grade,next_reminder,wecom_bound,billing_name,billing_address,document_contact,default_port_discharge,default_incoterm,default_payment_term,pool_status,previous_owner_id,released_by,released_at,release_reason,claimed_at,ownership_version)");
    await replaceRows(connection, "customer_activities", store.customerActivities, (item) => [item.id, item.customerId, item.type || "note", item.content || "", item.operatorId || "", item.nextReminder || "", mysqlDate(item.createdAt)], "(id,customer_id,type,content,operator_id,next_reminder,created_at)");
    await replaceRows(connection, "customer_intelligence_suggestions", store.customerIntelligenceSuggestions, (item) => [item.id, item.teamId, item.ownerId, item.customerId, item.prospectCandidateId, item.tenantProspectId || "", item.organizationId || "", item.leadId || "", item.sourceEventId || "", item.sourceLabel || "", item.sourceUrl || "", JSON.stringify(item.suggestedFields || []), item.website || "", item.business || "", item.contactInfo || "", item.evidenceSummary || "", JSON.stringify(item.evidenceRefs || []), item.payloadHash, item.status, JSON.stringify(item.acceptedFields || []), item.reviewedBy || "", item.reviewedAt ? mysqlDate(item.reviewedAt) : null, item.reviewNote || "", mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,team_id,owner_id,customer_id,prospect_candidate_id,tenant_prospect_id,organization_id,lead_id,source_event_id,source_label,source_url,suggested_fields_json,website,business,contact_info,evidence_summary,evidence_refs_json,payload_hash,suggestion_status,accepted_fields_json,reviewed_by,reviewed_at,review_note,created_at,updated_at)");
    await replaceRows(connection, "leads", store.leads, (item) => [item.id, item.company, item.contact || "", item.country || "", item.email || "", item.phone || "", item.wechat || "", item.source || "", item.sourceType || "outbound", item.sourceChannel || "manual", item.sourceCampaign || "", item.externalId || "", item.sourceUrl || "", item.intent || "中", item.stage || "新线索", item.status || "new", item.ownerId, item.teamId, item.estimatedAmount || 0, item.nextFollowAt || "", item.lastActivityAt || "", item.remark || "", item.convertedCustomerId || "", item.convertedDealId || "", item.deletedAt ? mysqlDate(item.deletedAt) : null, item.deletedReason || "", item.deletedBy || "", item.purgeAt ? mysqlDate(item.purgeAt) : null, item.statusBeforeDelete || "", mysqlDate(item.createdAt)], "(id,company,contact,country,email,phone,wechat,source,source_type,source_channel,source_campaign,external_id,source_url,intent,stage,status,owner_id,team_id,estimated_amount,next_follow_at,last_activity_at,remark,converted_customer_id,converted_deal_id,deleted_at,deleted_reason,deleted_by,purge_at,status_before_delete,created_at)");
    await replaceRows(connection, "lead_activities", store.leadActivities, (item) => [item.id, item.leadId, item.type || "note", item.content || "", item.operatorId || "", item.nextFollowAt || "", mysqlDate(item.createdAt)], "(id,lead_id,type,content,operator_id,next_follow_at,created_at)");
    await replaceRows(connection, "lead_source_events", store.leadSourceEvents, (item) => [item.id, item.leadId, item.sourceType, item.channel, item.campaign || "", item.externalId || "", item.sourceUrl || "", mysqlDate(item.occurredAt), mysqlDate(item.receivedAt), item.rawPayload || "{}", item.ownerId, item.teamId], "(id,lead_id,source_type,channel,campaign,external_id,source_url,occurred_at,received_at,raw_payload,owner_id,team_id)");
    await replaceRows(connection, "deals", store.deals, (item) => [item.id, item.customerId, item.title, item.stage, item.product || "", item.quantity || 0, item.unitPrice || 0, item.amount, item.currency || "USD", item.amountType || "estimate", item.ownerId, item.teamId, item.nextAction, item.nextActionAt || "", item.expectedCloseAt || "", mysqlDate(item.stageChangedAt), item.closedAt ? mysqlDate(item.closedAt) : null, item.wonReason || "", item.lostReason || "", item.lostReasonCategory || "", item.revisitAt || "", item.archivedAt ? mysqlDate(item.archivedAt) : null], "(id,customer_id,title,stage,product,quantity,unit_price,amount,currency,amount_type,owner_id,team_id,next_action,next_action_at,expected_close_at,stage_changed_at,closed_at,won_reason,lost_reason,lost_reason_category,revisit_at,archived_at)");
    await replaceRows(connection, "deal_events", store.dealEvents, (item) => [item.id, item.dealId, item.type, item.content || "", item.operatorId, item.fromStage || "", item.toStage || "", item.nextAction || "", item.nextActionAt || "", item.relatedDocumentId || "", mysqlDate(item.createdAt)], "(id,deal_id,event_type,content,operator_id,from_stage,to_stage,next_action,next_action_at,related_document_id,created_at)");
    await replaceRows(connection, "todos", (store.todos as Todo[]), (item) => [item.id, item.title, item.type, item.priority, item.dueAt, item.ownerId, item.teamId, item.related, item.done, item.status || "pending", item.pinState || "", item.sortOrder || 0, item.impactAmount ?? null, mysqlDate(item.createdAt), item.historyAt ? mysqlDate(item.historyAt) : null, item.customerId || "", item.dealId || "", item.reminderRuleId || "", item.triggerKey || "", item.snoozedFrom || "", item.snoozeReason || "", item.snoozeCount || 0, item.snoozedBy || "", item.completedAt ? mysqlDate(item.completedAt) : null, item.completedBy || "", item.completionResult || "", item.leadId || "", item.prospectCandidateId || "", item.tenantProspectId || "", item.outreachChannel || "", item.touchpointId || "", item.cancelledAt ? mysqlDate(item.cancelledAt) : null, item.cancellationReason || ""], "(id,title,type,priority,due_at,owner_id,team_id,related,done,status,pin_state,sort_order,impact_amount,created_at,history_at,customer_id,deal_id,reminder_rule_id,trigger_key,snoozed_from,snooze_reason,snooze_count,snoozed_by,completed_at,completed_by,completion_result,lead_id,prospect_candidate_id,tenant_prospect_id,outreach_channel,touchpoint_id,cancelled_at,cancellation_reason)");
    await replaceRows(connection, "plan_tasks", store.planTasks, (item) => [item.id, item.title, item.phase, item.category, item.priority, item.status, item.dueAt, item.target, item.description, item.customerId || "", item.leadId || "", item.dealId || "", item.completionResult || "", item.completedAt ? mysqlDate(item.completedAt) : null, item.cancellationReason || "", item.cancelledAt ? mysqlDate(item.cancelledAt) : null, item.rescheduledFrom || "", item.rescheduledAt ? mysqlDate(item.rescheduledAt) : null, item.rescheduleReason || "", item.ownerId, item.teamId, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,title,phase,category,priority,status,due_at,target,description,customer_id,lead_id,deal_id,completion_result,completed_at,cancellation_reason,cancelled_at,rescheduled_from,rescheduled_at,reschedule_reason,owner_id,team_id,created_at,updated_at)");
    await replaceRows(connection, "plan_templates", store.planTemplates, (item) => [item.id, item.section, item.title, item.summary, item.output, item.badge, item.badgeTone, item.phase, item.category, item.priority, item.target, item.description, item.sortOrder, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,section_name,title,summary,output_text,badge,badge_tone,phase,category,priority,target,description,sort_order,owner_id,team_id,updated_at)");
    await replaceRows(connection, "reminders", store.reminders, (item) => [item.id, item.title, item.rule, item.dueAt, item.ownerId, item.teamId, "站内", item.enabled === false ? "disabled" : "enabled", item.ruleType || null, item.targetStage || null, item.days ?? 3, item.priority || "normal", item.enabled ?? true, item.generatedCount || 0, item.targetOwnerId || item.ownerId, item.lastRunBy || "", item.lastRunAt ? mysqlDate(item.lastRunAt) : null, item.lastMatchedCount || 0, item.lastCreatedCount || 0, item.lastSkippedCount || 0, item.lastFailedCount || 0, item.lastError || ""], "(id,title,rule_text,due_at,owner_id,team_id,channel,status,rule_type,target_stage,days_count,priority,enabled,generated_count,target_owner_id,last_run_by,last_run_at,last_matched_count,last_created_count,last_skipped_count,last_failed_count,last_error)");
    await replaceRows(connection, "knowledge_assets", store.knowledgeAssets, (item) => [item.id, item.title, item.category, item.status, item.ownerId, item.teamId || "all", item.version], "(id,title,category,status,owner_id,team_id,version)");
    await replaceRows(connection, "exams", store.exams, (item) => [item.id, item.title, item.category, item.status, item.passRate, item.questionCount, item.durationMinutes || 20, item.passScore || 80, item.targetRole || "sales", item.ownerId || "", item.teamId || "all", mysqlDate(item.updatedAt)], "(id,title,category,status,pass_rate,question_count,duration_minutes,pass_score,target_role,owner_id,team_id,updated_at)");
    await replaceRows(connection, "exam_questions", store.examQuestions, (item) => [item.id, item.examId || "bank", item.category, item.stem, JSON.stringify(item.options), item.answerIndex, JSON.stringify(item.answerIndexes?.length ? item.answerIndexes : [item.answerIndex]), item.questionType || ((item.answerIndexes?.length || 0) > 1 ? "multiple" : "single"), JSON.stringify(item.tags || []), item.explanation, item.difficulty, item.ownerId || "", item.teamId || "all", mysqlDate(item.updatedAt)], "(id,exam_id,category,stem,options_json,answer_index,answer_indexes_json,question_type,tags_json,explanation,difficulty,owner_id,team_id,updated_at)");
    await replaceRows(connection, "exam_question_links", store.examQuestionLinks, (item) => [item.examId, item.questionId, item.sortOrder], "(exam_id,question_id,sort_order)");
    await replaceRows(connection, "exam_attempts", store.examAttempts, (item) => [item.id, item.examId, item.userId, item.score, item.passed, JSON.stringify(item.answers), item.correctCount, item.totalQuestions, mysqlDate(item.submittedAt)], "(id,exam_id,user_id,score,passed,answers_json,correct_count,total_questions,submitted_at)");
    await replaceRows(connection, "import_export_jobs", store.importExportJobs, (item) => [item.id, item.name, item.type, item.rows, item.status, item.operatorId, item.createdAt], "(id,name,type,rows_count,status,operator_id,created_at)");
    await replaceRows(connection, "trade_documents", store.tradeDocuments, (item) => [item.id, item.customerId || "", item.dealId || "", item.revision || 1, item.type, item.title, item.number, item.issueDate, item.buyer, item.buyerAddress, item.buyerContact, item.seller, item.sellerAddress, item.currency, item.incoterm, item.paymentTerm, item.shippingMethod, item.portLoading, item.portDischarge, item.validityDate, item.bankInfo, item.notes, item.templateStyle, item.status, item.approvalNote || "", item.approvedAt || null, item.approvedBy || "", JSON.stringify(item.audits || []), JSON.stringify(item.sendRecords || []), item.ownerId, item.teamId, JSON.stringify(item.items), mysqlDate(item.updatedAt)], "(id,customer_id,deal_id,revision,doc_type,title,doc_number,issue_date,buyer,buyer_address,buyer_contact,seller,seller_address,currency,incoterm,payment_term,shipping_method,port_loading,port_discharge,validity_date,bank_info,notes,template_style,status,approval_note,approved_at,approved_by,audits_json,send_records_json,owner_id,team_id,items_json,updated_at)");
	    await replaceRows(connection, "wecom_messages", store.wecomMessages, (item) => [item.id, item.customerId, item.summary, item.ownerId, item.teamId, item.status], "(id,customer_id,summary,owner_id,team_id,status)");
	    await replaceRows(connection, "ocr_jobs", store.ocrJobs, (item) => [item.id, item.status, item.confidence, JSON.stringify(item.fields), item.ownerId, item.ownerId, item.teamId], "(id,status,confidence,fields_json,created_by,owner_id,team_id)");
	    await replaceRows(connection, "prospect_touchpoints", store.prospectTouchpoints, (item) => [item.id, item.teamId, item.ownerId, item.prospectCandidateId, item.tenantProspectId || "", item.organizationId || "", item.leadId || "", item.channel, item.direction, item.contactValue || "", item.subject || "", item.content || "", item.replyClassification || "", item.requestId, mysqlDate(item.occurredAt), mysqlDate(item.createdAt)], "(id,team_id,owner_id,prospect_candidate_id,tenant_prospect_id,organization_id,lead_id,channel,direction,contact_value,subject,content,reply_classification,request_id,occurred_at,created_at)");
	    await replaceRows(connection, "procurement_signals", store.procurementSignals, (item) => [item.id, item.teamId, item.ownerId, item.prospectCandidateId, item.tenantProspectId || "", item.organizationId || "", item.leadId || "", item.customerId || "", item.sourceTouchpointId, item.sourceType, JSON.stringify(item.evidenceTypes || []), item.evidenceSummary || "", item.product || "", item.specification || "", item.quantity || 0, item.quantityType || "unknown", item.targetPrice || 0, item.currency || "USD", item.priceBasis || "", item.deliveryRequirement || "", item.certificationRequirement || "", item.purchaseTimeline || "", item.projectName || "", item.buyerRole || "", item.nextAction || "", item.confidence || 0, item.status, mysqlDate(item.observedAt), mysqlDate(item.validUntil), item.dismissedReason || "", mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,team_id,owner_id,prospect_candidate_id,tenant_prospect_id,organization_id,lead_id,customer_id,source_touchpoint_id,source_type,evidence_types_json,evidence_summary,product,specification,quantity,quantity_type,target_price,currency,price_basis,delivery_requirement,certification_requirement,purchase_timeline,project_name,buyer_role,next_action,confidence,signal_status,observed_at,valid_until,dismissed_reason,created_at,updated_at)");
	    await replaceRows(connection, "deal_recommendations", store.dealRecommendations, (item) => [item.id, item.signalId, item.teamId, item.ownerId, item.prospectCandidateId, item.tenantProspectId || "", item.organizationId || "", item.leadId || "", item.customerId || "", item.suggestedTitle, item.suggestedProduct, item.suggestedQuantity || 0, item.suggestedUnitPrice || 0, item.suggestedAmount || 0, item.currency || "USD", item.initialStage || "询盘", item.nextAction || "", item.nextActionAt || "", item.expectedCloseAt || "", JSON.stringify(item.reasonCodes || []), JSON.stringify(item.missingFields || []), JSON.stringify(item.evidenceRefs || []), item.recommendationScore || 0, JSON.stringify(item.duplicateDealIds || []), item.status, item.reviewedBy || "", item.reviewedAt ? mysqlDate(item.reviewedAt) : null, item.reviewReason || "", item.linkedDealId || "", mysqlDate(item.expiresAt), mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,signal_id,team_id,owner_id,prospect_candidate_id,tenant_prospect_id,organization_id,lead_id,customer_id,suggested_title,suggested_product,suggested_quantity,suggested_unit_price,suggested_amount,currency,initial_stage,next_action,next_action_at,expected_close_at,reason_codes_json,missing_fields_json,evidence_refs_json,recommendation_score,duplicate_deal_ids_json,recommendation_status,reviewed_by,reviewed_at,review_reason,linked_deal_id,expires_at,created_at,updated_at)");
      await replaceRows(connection, "acquisition_outcome_feedback", store.acquisitionOutcomeFeedback, (item) => [item.id, item.teamId, item.ownerId, item.dealId, item.customerId, item.leadId || "", item.prospectCandidateId || "", item.tenantProspectId || "", item.organizationId || "", item.campaignId || "", item.campaignVersion || 0, item.strategyId || "", item.runId || "", JSON.stringify(item.providerCodes || []), item.icpAssessmentId || "", item.icpPolicyId || "", item.outcome, item.amount || 0, item.currency || "USD", item.reasonCategory || "", item.reason || "", mysqlDate(item.closedAt), item.attributionConfidence || 0, JSON.stringify(item.attributionReasonCodes || []), item.payloadHash, mysqlDate(item.createdAt)], "(id,team_id,owner_id,deal_id,customer_id,lead_id,prospect_candidate_id,tenant_prospect_id,organization_id,campaign_id,campaign_version,strategy_id,run_id,provider_codes_json,icp_assessment_id,icp_policy_id,outcome,amount,currency,reason_category,reason_text,closed_at,attribution_confidence,attribution_reason_codes_json,payload_hash,created_at)");
      await replaceRows(connection, "prospect_strategy_suggestions", store.prospectStrategySuggestions, (item) => [item.id, item.teamId, item.ownerId, item.campaignId, item.campaignVersion || 0, item.strategyId, item.suggestionType, JSON.stringify(item.sampleMetrics || {}), JSON.stringify(item.proposedAdjustments || {}), item.rationale || "", JSON.stringify(item.reasonCodes || []), item.sampleFrom ? mysqlDate(item.sampleFrom) : null, item.sampleTo ? mysqlDate(item.sampleTo) : null, item.payloadHash, item.status, item.reviewedBy || "", item.reviewedAt ? mysqlDate(item.reviewedAt) : null, item.reviewNote || "", mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,team_id,owner_id,campaign_id,campaign_version,strategy_id,suggestion_type,sample_metrics_json,proposed_adjustments_json,rationale,reason_codes_json,sample_from,sample_to,payload_hash,suggestion_status,reviewed_by,reviewed_at,review_note,created_at,updated_at)");
	    await replaceRows(connection, "ai_model_configs", store.aiModelConfigs, (item) => [item.id, item.provider, item.protocol || "openai-compatible", item.name, item.baseUrl, item.model, encryptAiModelApiKey(item, item.apiKey), item.enabled, item.temperature ?? 0.1, item.useLeadFinder ?? true, item.useWebsiteParse ?? true, item.useScoring ?? true, item.useEmailDraft ?? true, item.useExam ?? false, item.lastTestAt ? mysqlDate(item.lastTestAt) : null, item.lastTestStatus || "untested", item.lastTestMessage || "", item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,provider,protocol,name,base_url,model,api_key,enabled,temperature,use_lead_finder,use_website_parse,use_scoring,use_email_draft,use_exam,last_test_at,last_test_status,last_test_message,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "provider_catalog", store.providerCatalog, (item) => [item.id, item.code, item.name, item.category, item.sourceLevel, item.accessMode, item.baseUrl || "", item.officialDocsUrl || "", JSON.stringify(item.capabilities), JSON.stringify(item.allowedFields), JSON.stringify(item.licensePolicy), JSON.stringify(item.defaultRatePolicy), JSON.stringify(item.retentionPolicy), item.status, item.version, item.reviewedAt ? mysqlDate(item.reviewedAt) : null, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,code,name,category,source_level,access_mode,base_url,official_docs_url,capability_json,allowed_fields_json,license_policy_json,default_rate_policy_json,retention_policy_json,status,version,reviewed_at,created_at,updated_at)");
	    await replaceRows(connection, "provider_connections", store.providerConnections, (item) => [item.id, item.providerId, item.scope, item.credentialRef, item.configurationEncrypted, item.status, JSON.stringify(item.quotaPolicy), JSON.stringify(item.budgetPolicy), item.lastHealthAt ? mysqlDate(item.lastHealthAt) : null, item.lastHealthStatus, item.lastErrorCode || "", item.lastHealthMessage || "", item.usage || "", item.ownerId, item.teamId, item.createdBy, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,provider_id,scope,credential_ref,configuration_encrypted,status,quota_policy_json,budget_policy_json,last_health_at,last_health_status,last_error_code,last_health_message,usage_text,owner_id,team_id,created_by,created_at,updated_at)");
		    await appendProviderRequestLogRows(connection, store.providerRequestLogs);
		    await replaceRows(connection, "provider_response_cache", store.providerResponseCache, (item) => [item.id, item.providerId, item.providerVersion, item.requestFingerprint, item.payloadEncrypted, item.payloadHash, mysqlDate(item.fetchedAt), mysqlDate(item.expiresAt), item.licenseScope, item.status], "(id,provider_id,provider_version,request_fingerprint,payload_encrypted,payload_hash,fetched_at,expires_at,license_scope,status)");
      await syncProspectCampaignRows(connection, store.prospectCampaigns);
      await appendProspectCampaignHistoryRows(connection, store);
      await syncProspectStrategyRows(connection, store.prospectStrategies);
      await appendProspectStrategyHistoryRows(connection, store);
      await syncProspectScheduleRows(connection, store.prospectSchedules);
		    await replaceRows(connection, "market_trade_observations", store.marketTradeObservations, (item) => [item.id, item.teamId, item.ownerId, item.campaignId, item.providerId, item.reporterCountry, item.partnerCountry, item.reporterCode || "", item.partnerCode || "", item.tradeFlow, item.classification, item.commodityCode, item.commodityDescription || "", item.period, item.tradeValueUsd, item.netWeightKg, item.quantity, item.quantityUnit || "", item.isAggregate, item.suppressed, JSON.stringify(item.statusFlags || []), item.rawRecordId, item.payloadHash, item.adapterVersion, item.sourceRevision || "", mysqlDate(item.observedAt), mysqlDate(item.createdAt)], "(id,team_id,owner_id,campaign_id,provider_id,reporter_country,partner_country,reporter_code,partner_code,trade_flow,classification,commodity_code,commodity_description,period_value,trade_value_usd,net_weight_kg,quantity_value,quantity_unit,is_aggregate,suppressed,status_flags_json,raw_record_id,payload_hash,adapter_version,source_revision,observed_at,created_at)");
      await appendMarketOpportunityRows(connection, store);
      await syncAgentJobRows(
        connection,
        store.agentJobs,
        (item) => !isProspectRunBridgeJob(item)
      );
      await syncAgentJobIdempotencyAliasRows(
        connection,
        store.agentJobIdempotencyAliases,
        (item) => !isProspectRunBridgeJob(item)
      );
	    await replaceRows(connection, "lead_source_configs", store.leadSourceConfigs, (item) => [item.id, item.provider, item.scope || "personal", item.apiKey, item.baseUrl || "", item.enabled, item.lastTestAt ? mysqlDate(item.lastTestAt) : null, item.lastTestStatus || "untested", item.lastTestMessage || "", item.usageJson || "", item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,provider,scope,api_key,base_url,enabled,last_test_at,last_test_status,last_test_message,usage_json,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "problems", store.problems, (item) => [item.id, item.title, item.category, item.severity, item.status, item.ownerId, item.teamId, item.relatedCustomer, item.rootCause, item.solution, item.nextAction, item.dueAt, mysqlDate(item.createdAt)], "(id,title,category,severity,status,owner_id,team_id,related_customer,root_cause,solution,next_action,due_at,created_at)");
	    await replaceRows(connection, "memos", store.memos, (item) => [item.id, item.title, item.content, item.category, item.tags, item.customerId || "", item.dealId || "", item.ownerId, item.teamId, item.pinned, item.archived, item.deletedAt ? mysqlDate(item.deletedAt) : null, mysqlDate(item.updatedAt)], "(id,title,content,category,tags,customer_id,deal_id,owner_id,team_id,pinned,archived,deleted_at,updated_at)");
	    await replaceRows(connection, "competitors", store.competitors, (item) => [item.id, item.company, item.country, item.segment, item.threatLevel, item.website, item.strengths, item.weaknesses, item.competingProducts, item.ourStrategy, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,company,country,segment,threat_level,website,strengths,weaknesses,competing_products,our_strategy,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "case_studies", store.caseStudies, (item) => [item.id, item.title, item.customer, item.country, item.product, item.industry, item.result, item.story, item.reusablePoints, item.status, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,title,customer,country,product,industry,result_text,story,reusable_points,status,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "commission_products", store.commissionProducts, (item) => [item.id, item.name, item.category, item.model, item.currency, item.defaultPrice, item.costPrice, item.status, item.remark, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,name,category,model,currency,default_price,cost_price,status,remark,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "commission_rules", store.commissionRules, (item) => [item.id, item.productId, item.ruleType, item.rate, item.fixedAmount, item.tierJson, item.grossProfitRate, item.effectiveFrom, item.effectiveTo, item.enabled, item.remark, item.createdBy, mysqlDate(item.createdAt)], "(id,product_id,rule_type,rate,fixed_amount,tier_json,gross_profit_rate,effective_from,effective_to,enabled,remark,created_by,created_at)");
	    await replaceRows(connection, "monthly_sales_records", store.monthlySalesRecords, (item) => [item.id, item.month, item.ownerId, item.teamId, item.customerId, item.customerName, item.dealId, item.productId, item.productName, item.quantity, item.unitPrice, item.salesAmount, item.currency, item.exchangeRate, item.exchangeRateDate, item.exchangeRateSource, item.settlementCurrency, item.settlementAmount, item.basisType, item.basisDate, item.dealArchivedAt, item.sourceType, item.status, item.edited, item.editNote, item.lastEditedBy, item.lastEditedAt ? mysqlDate(item.lastEditedAt) : null, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,month_value,owner_id,team_id,customer_id,customer_name,deal_id,product_id,product_name,quantity,unit_price,sales_amount,currency,exchange_rate,exchange_rate_date,exchange_rate_source,settlement_currency,settlement_amount,basis_type,basis_date,deal_archived_at,source_type,status,edited,edit_note,last_edited_by,last_edited_at,created_at,updated_at)");
	    await replaceRows(connection, "sales_record_audits", store.salesRecordAudits, (item) => [item.id, item.recordId, item.fieldName, item.oldValue, item.newValue, item.reason, item.operatorId, item.operatorName, mysqlDate(item.createdAt)], "(id,record_id,field_name,old_value,new_value,reason,operator_id,operator_name,created_at)");
	    await replaceRows(connection, "commission_calculations", store.commissionCalculations, (item) => [item.id, item.month, item.ownerId, item.teamId, item.salesAmount, item.autoCommission, item.manualAdjustment, item.finalCommission, item.status, item.version, item.isCurrent, item.calculatedAt ? mysqlDate(item.calculatedAt) : null, item.reviewedBy, item.reviewedAt ? mysqlDate(item.reviewedAt) : null, item.lockedBy, item.lockedAt ? mysqlDate(item.lockedAt) : null, item.unlockReason], "(id,month_value,owner_id,team_id,sales_amount,auto_commission,manual_adjustment,final_commission,status,version_no,is_current,calculated_at,reviewed_by,reviewed_at,locked_by,locked_at,unlock_reason)");
	    await replaceRows(connection, "commission_items", store.commissionItems, (item) => [item.id, item.calculationId, item.recordId, item.productId, item.itemType, item.sourceType, item.ruleSnapshotJson, item.salesAmount, item.autoAmount, item.manualAmount, item.finalAmount, item.remark, item.createdBy, mysqlDate(item.createdAt)], "(id,calculation_id,record_id,product_id,item_type,source_type,rule_snapshot_json,sales_amount,auto_amount,manual_amount,final_amount,remark,created_by,created_at)");
	    await replaceRows(connection, "commission_exports", store.commissionExports, (item) => [item.id, item.month, item.scopeType, item.scopeOwnerId, item.fileType, item.rows, item.exportedBy, mysqlDate(item.createdAt)], "(id,month_value,scope_type,scope_owner_id,file_type,rows_count,exported_by,created_at)");
	    await replaceRows(connection, "whatsapp_bindings", store.whatsappBindings, (item) => [item.id, item.customerId, item.phoneNumber, item.waProfileName || "", item.lastMessageAt ? mysqlDate(item.lastMessageAt) : null, item.unreadCount || 0, mysqlDate(item.createdAt), item.bindingMode || "manual", item.userId || "", item.sessionData || "", item.twilioPhoneNumber || "", item.connectionStatus || "disconnected", item.lastConnectedAt ? mysqlDate(item.lastConnectedAt) : null], "(id,customer_id,phone_number,wa_profile_name,last_message_at,unread_count,created_at,binding_mode,user_id,session_data,twilio_phone_number,connection_status,last_connected_at)");
	    await replaceRows(connection, "whatsapp_messages", store.whatsappMessages, (item) => [item.id, item.customerId, item.direction, item.content || "", item.contentTranslated || "", item.mediaUrl || "", item.status || "", item.waMessageId || "", mysqlDate(item.createdAt)], "(id,customer_id,direction,content,content_translated,media_url,status,wa_message_id,created_at)");
	    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function replaceRows<T>(connection: mysql.PoolConnection, table: string, items: T[], values: (item: T) => unknown[], columns: string) {
  await connection.query(`DELETE FROM ${table}`);
  if (!items.length) return;
  const mapped = items.map(values);
  const placeholders = mapped.map((row) => `(${row.map(() => "?").join(",")})`).join(",");
  await connection.query(`INSERT INTO ${table} ${columns} VALUES ${placeholders}`, mapped.flat());
}

async function persistWebsiteOpportunityRows(
  connection: mysql.PoolConnection,
  items: WebsiteOpportunity[]
) {
  await replaceRows(
    connection,
    "website_opportunities",
    items,
    (item) => [
      item.id,
      item.company,
      item.business,
      item.country,
      item.website,
      item.contact,
      item.contactInfo,
      item.description,
      item.ownerId,
      item.teamId,
      item.status,
      item.customerId || null,
      item.dealId || null,
      item.leadId || null,
      item.parseMode || "rule",
      item.source || "",
      item.sourceLabel || "",
      JSON.stringify(item.sourceEvidence || []),
      item.verificationReport
        ? JSON.stringify(item.verificationReport)
        : null,
      item.confidence ?? null,
      item.lastDevelopmentEmailAt
        ? mysqlDate(item.lastDevelopmentEmailAt)
        : null,
      item.lastDevelopmentEmailSubject || "",
      item.lastDevelopmentEmailTo || "",
      item.verifiedAt ? mysqlDate(item.verifiedAt) : null,
      item.statusChangedAt ? mysqlDate(item.statusChangedAt) : null,
      item.excludedReason || "",
      item.tenantProspectId || null,
      item.organizationId || null,
      item.coverageClassification || null,
      item.coverageQueueState || null,
      item.coverageReasonCode || "",
      item.lastTouchpointAt ? mysqlDate(item.lastTouchpointAt) : null,
      item.lastTouchpointChannel || "",
      item.lastReplyClassification || "",
      item.nextFollowAt || "",
      item.outreachState || "uncontacted",
      JSON.stringify(item.invalidContactChannels || []),
      mysqlDate(item.createdAt)
    ],
    "(id,company,business,country,website,contact,contact_info,description,owner_id,team_id,status,customer_id,deal_id,lead_id,parse_mode,source,source_label,source_evidence_json,verification_report_json,confidence,last_development_email_at,last_development_email_subject,last_development_email_to,verified_at,status_changed_at,excluded_reason,tenant_prospect_id,organization_id,coverage_classification,coverage_queue_state,coverage_reason_code,last_touchpoint_at,last_touchpoint_channel,last_reply_classification,next_follow_at,outreach_state,invalid_contact_channels_json,created_at)"
  );
}

async function persistProspectCandidateProcessingStates(
  connection: mysql.PoolConnection,
  desired: ProspectCandidateProcessingState[]
) {
  const persisted = await loadProspectCandidateProcessingStates(connection);
  const desiredByHitId = new Map(
    desired.map((item) => [item.hitId, item])
  );
  if (desiredByHitId.size !== desired.length) {
    throw new Error("候选处理状态存在重复原始命中");
  }
  for (const existing of persisted) {
    const current = desiredByHitId.get(existing.hitId);
    if (!current || !isDeepStrictEqual(existing, current)) {
      throw new Error("候选处理终态不可删除或修改");
    }
  }
  const persistedHitIds = new Set(
    persisted.map((item) => item.hitId)
  );
  try {
    await insertRows(
      connection,
      "prospect_candidate_processing",
      desired.filter((item) => !persistedHitIds.has(item.hitId)),
      (item) => [
        item.hitId,
        item.teamId,
        item.ownerId,
        item.runId,
        item.ledgerId,
        item.status,
        item.failureCode || "",
        item.candidateId || null,
        mysqlDate(item.processedAt),
        mysqlDate(item.updatedAt)
      ],
      `(hit_id,team_id,owner_id,run_id,ledger_id,processing_status,
        failure_code,candidate_id,processed_at,updated_at)`
    );
  } catch (error) {
    if (isMysqlDuplicateKeyError(error)) {
      throw new Error("候选处理状态数据库唯一约束冲突");
    }
    throw error;
  }
}

function verifyImmutableRows<T extends { id: string }>(
  persisted: T[],
  desired: T[],
  label: string
) {
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error(`${label}存在重复主键`);
  }
  for (const existing of persisted) {
    const current = desiredById.get(existing.id);
    if (!current || !isDeepStrictEqual(existing, current)) {
      throw new Error(`${label}不可变历史被删除或修改`);
    }
  }
}

function isMysqlDuplicateKeyError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown };
  return value.code === "ER_DUP_ENTRY" || value.errno === 1062;
}

async function insertRows<T>(
  connection: mysql.PoolConnection,
  table: string,
  items: T[],
  values: (item: T) => unknown[],
  columns: string
) {
  if (!items.length) return;
  const mapped = items.map(values);
  const placeholders = mapped.map(
    (row) => `(${row.map(() => "?").join(",")})`
  ).join(",");
  await connection.query(
    `INSERT INTO ${table} ${columns} VALUES ${placeholders}`,
    mapped.flat()
  );
}

async function appendProviderRequestLogRows(
  connection: mysql.PoolConnection,
  desired: ProviderRequestLog[]
) {
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("数据源请求日志存在重复主键");
  }
  const persistedById = new Map(
    (await loadProviderRequestLogs(connection)).map((item) => [item.id, item])
  );
  for (const log of desired) {
    const existing = persistedById.get(log.id);
    if (existing && !isDeepStrictEqual(existing, log)) {
      throw new Error("数据源请求日志不可变事实被修改");
    }
  }
  await insertRows(
    connection,
    "provider_request_logs",
    desired.filter((item) => !persistedById.has(item.id)),
    (item) => [
      item.id,
      item.teamId,
      item.ownerId,
      item.providerId,
      item.connectionId || "",
      item.runId,
      item.runShardId,
      item.requestFingerprint,
      item.endpointCode,
      item.httpStatus,
      item.attempt,
      item.quotaUnits,
      item.costAmount,
      item.currency || "",
      item.durationMs,
      item.responseSize,
      item.errorCode || "",
      mysqlDate(item.requestedAt)
    ],
    `(id,team_id,owner_id,provider_id,connection_id,run_id,run_shard_id,
      request_fingerprint,endpoint_code,http_status,attempt,quota_units,
      cost_amount,currency,duration_ms,response_size,error_code,requested_at)`
  );
}

async function syncProspectCampaignRows(
  connection: mysql.PoolConnection,
  desired: ProspectCampaign[]
) {
  const persisted = await loadProspectCampaigns(connection);
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("获客项目存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("获客项目不允许通过普通持久化删除");
    }
  }

  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  for (const campaign of desired) {
    const existing = persistedById.get(campaign.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_campaigns",
        [campaign],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.name,
          item.status,
          item.currentVersion,
          item.revision,
          item.createdBy,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt),
          item.archivedAt ? mysqlDate(item.archivedAt) : null
        ],
        "(id,team_id,owner_id,name,status,current_version,revision_no,created_by,created_at,updated_at,archived_at)"
      );
      continue;
    }
    if (isDeepStrictEqual(existing, campaign)) continue;
    if (campaign.teamId !== existing.teamId
      || campaign.createdBy !== existing.createdBy
      || campaign.createdAt !== existing.createdAt
      || campaign.revision !== existing.revision + 1) {
      throw new Error("获客项目并发版本冲突或不可变字段被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_campaigns
       SET owner_id = ?, name = ?, status = ?, current_version = ?,
           revision_no = ?, updated_at = ?, archived_at = ?
       WHERE id = ? AND team_id = ? AND revision_no = ?`,
      [
        campaign.ownerId,
        campaign.name,
        campaign.status,
        campaign.currentVersion,
        campaign.revision,
        mysqlDate(campaign.updatedAt),
        campaign.archivedAt ? mysqlDate(campaign.archivedAt) : null,
        campaign.id,
        campaign.teamId,
        existing.revision
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("获客项目数据库并发更新失败");
    }
  }
}

async function appendProspectCampaignHistoryRows(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persistedVersions = await loadProspectCampaignVersions(connection);
  const persistedEvents = await loadProspectCampaignEvents(connection);
  verifyImmutableRows(
    persistedVersions,
    store.prospectCampaignVersions,
    "获客项目版本"
  );
  verifyImmutableRows(
    persistedEvents,
    store.prospectCampaignEvents,
    "获客项目审计事件"
  );

  const persistedVersionIds = new Set(persistedVersions.map((item) => item.id));
  const persistedEventIds = new Set(persistedEvents.map((item) => item.id));
  await insertRows(
    connection,
    "prospect_campaign_versions",
    store.prospectCampaignVersions.filter(
      (item) => !persistedVersionIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.teamId,
      item.campaignId,
      item.version,
      JSON.stringify(item.snapshot),
      item.contentHash,
      item.changeSummary,
      item.createdBy,
      mysqlDate(item.createdAt)
    ],
    "(id,team_id,campaign_id,version_no,snapshot_json,content_hash,change_summary,created_by,created_at)"
  );
  await insertRows(
    connection,
    "prospect_campaign_events",
    store.prospectCampaignEvents.filter(
      (item) => !persistedEventIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.teamId,
      item.campaignId,
      item.eventType,
      item.actorId,
      item.requestId,
      item.fromStatus,
      item.toStatus,
      item.fromOwnerId,
      item.toOwnerId,
      item.fromVersion,
      item.toVersion,
      item.revision,
      item.reason,
      mysqlDate(item.createdAt)
    ],
    "(id,team_id,campaign_id,event_type,actor_id,request_id,from_status,to_status,from_owner_id,to_owner_id,from_version,to_version,revision_no,reason,created_at)"
  );
}

async function syncProspectStrategyRows(
  connection: mysql.PoolConnection,
  desired: ProspectStrategy[]
) {
  const persisted = await loadProspectStrategies(connection);
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("获客搜索策略存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("获客搜索策略不允许通过普通持久化删除");
    }
  }

  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  for (const strategy of desired) {
    const existing = persistedById.get(strategy.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_strategies",
        [strategy],
        (item) => [
          item.id,
          item.teamId,
          item.campaignId,
          item.campaignVersion,
          item.ownerId,
          item.name,
          item.status,
          item.revision,
          JSON.stringify(item.query),
          JSON.stringify(item.providerPlan),
          item.queryFingerprint,
          item.fingerprintVersion,
          item.createdBy,
          item.approvedBy,
          item.approvedAt ? mysqlDate(item.approvedAt) : null,
          item.disabledBy,
          item.disabledAt ? mysqlDate(item.disabledAt) : null,
          item.disableReason,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt)
        ],
        `(id,team_id,campaign_id,campaign_version,owner_id,name,status,
          revision_no,query_json,provider_plan_json,query_fingerprint,
          fingerprint_version,created_by,approved_by,approved_at,disabled_by,
          disabled_at,disable_reason,created_at,updated_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, strategy)) continue;
    if (strategy.teamId !== existing.teamId
      || strategy.campaignId !== existing.campaignId
      || strategy.campaignVersion !== existing.campaignVersion
      || strategy.createdBy !== existing.createdBy
      || strategy.createdAt !== existing.createdAt
      || strategy.fingerprintVersion !== existing.fingerprintVersion
      || strategy.revision !== existing.revision + 1) {
      throw new Error("获客搜索策略并发版本冲突或不可变字段被修改");
    }
    const ownerOnlyUpdate = strategy.ownerId !== existing.ownerId
      && strategy.name === existing.name
      && strategy.status === existing.status
      && isDeepStrictEqual(strategy.query, existing.query)
      && isDeepStrictEqual(strategy.providerPlan, existing.providerPlan)
      && strategy.queryFingerprint === existing.queryFingerprint
      && strategy.approvedBy === existing.approvedBy
      && strategy.approvedAt === existing.approvedAt
      && strategy.disabledBy === existing.disabledBy
      && strategy.disabledAt === existing.disabledAt
      && strategy.disableReason === existing.disableReason;
    if (strategy.ownerId !== existing.ownerId && !ownerOnlyUpdate) {
      throw new Error("获客搜索策略负责人转交混入了其他字段修改");
    }
    if (strategy.ownerId === existing.ownerId) {
      const validTransition = existing.status === "draft"
        ? strategy.status === "draft"
          || strategy.status === "approved"
          || strategy.status === "disabled"
        : existing.status === "approved"
          ? strategy.status === "disabled"
          : false;
      if (!validTransition) {
        throw new Error("获客搜索策略状态转换无效");
      }
      if (existing.status !== "draft"
        && (strategy.name !== existing.name
          || !isDeepStrictEqual(strategy.query, existing.query)
          || !isDeepStrictEqual(strategy.providerPlan, existing.providerPlan)
          || strategy.queryFingerprint !== existing.queryFingerprint)) {
        throw new Error("已审批或已禁用搜索策略的业务内容不可修改");
      }
    }
    const [result] = await connection.query(
      `UPDATE prospect_strategies
       SET owner_id = ?, name = ?, status = ?, revision_no = ?,
           query_json = ?, provider_plan_json = ?, query_fingerprint = ?,
           approved_by = ?, approved_at = ?, disabled_by = ?,
           disabled_at = ?, disable_reason = ?, updated_at = ?
       WHERE id = ? AND team_id = ? AND revision_no = ?`,
      [
        strategy.ownerId,
        strategy.name,
        strategy.status,
        strategy.revision,
        JSON.stringify(strategy.query),
        JSON.stringify(strategy.providerPlan),
        strategy.queryFingerprint,
        strategy.approvedBy,
        strategy.approvedAt ? mysqlDate(strategy.approvedAt) : null,
        strategy.disabledBy,
        strategy.disabledAt ? mysqlDate(strategy.disabledAt) : null,
        strategy.disableReason,
        mysqlDate(strategy.updatedAt),
        strategy.id,
        strategy.teamId,
        existing.revision
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("获客搜索策略数据库并发更新失败");
    }
  }
}

async function appendProspectStrategyHistoryRows(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persistedEvents = await loadProspectStrategyEvents(connection);
  verifyImmutableRows(
    persistedEvents,
    store.prospectStrategyEvents,
    "获客搜索策略审计事件"
  );
  const persistedIds = new Set(persistedEvents.map((item) => item.id));
  await insertRows(
    connection,
    "prospect_strategy_events",
    store.prospectStrategyEvents.filter((item) => !persistedIds.has(item.id)),
    (item) => [
      item.id,
      item.teamId,
      item.campaignId,
      item.strategyId,
      item.eventType,
      item.actorId,
      item.requestId,
      item.fromStatus,
      item.toStatus,
      item.fromRevision,
      item.toRevision,
      item.reason,
      mysqlDate(item.createdAt)
    ],
    `(id,team_id,campaign_id,strategy_id,event_type,actor_id,request_id,
      from_status,to_status,from_revision,to_revision,reason,created_at)`
  );
}

async function syncProspectScheduleRows(
  connection: mysql.PoolConnection,
  desired: ProspectSchedule[]
) {
  const persisted = await loadProspectSchedules(connection);
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("定时获客计划存在重复主键");
  }
  for (const existing of persisted) {
    if (desiredById.has(existing.id)) continue;
    const [result] = await connection.query(
      `DELETE FROM prospect_schedules
       WHERE id = ? AND team_id = ? AND revision_no = ?`,
      [existing.id, existing.teamId, existing.revision]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("定时获客计划数据库并发删除失败");
    }
  }

  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  for (const schedule of desired) {
    const existing = persistedById.get(schedule.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_schedules",
        [schedule],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.campaignId,
          item.campaignVersion,
          item.strategyId,
          item.frequency,
          item.status,
          item.timezone,
          mysqlDate(item.nextRunAt),
          item.lastRunAt ? mysqlDate(item.lastRunAt) : null,
          item.lastRunId,
          item.lastPlannedAt ? mysqlDate(item.lastPlannedAt) : null,
          item.lastFailureCode,
          item.lastFailureReason,
          item.recurringCostApproved,
          item.revision,
          item.createdBy,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt)
        ],
        `(id,team_id,owner_id,campaign_id,campaign_version,strategy_id,
          frequency,status,timezone,next_run_at,last_run_at,last_run_id,
          last_planned_at,last_failure_code,last_failure_reason,
          recurring_cost_approved,revision_no,created_by,created_at,updated_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, schedule)) continue;
    if (schedule.teamId !== existing.teamId
      || schedule.ownerId !== existing.ownerId
      || schedule.campaignId !== existing.campaignId
      || schedule.campaignVersion !== existing.campaignVersion
      || schedule.strategyId !== existing.strategyId
      || schedule.frequency !== existing.frequency
      || schedule.timezone !== existing.timezone
      || schedule.recurringCostApproved !== existing.recurringCostApproved
      || schedule.createdBy !== existing.createdBy
      || schedule.createdAt !== existing.createdAt
      || schedule.revision !== existing.revision + 1) {
      throw new Error("定时获客计划并发版本冲突或不可变字段被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_schedules
       SET status = ?, next_run_at = ?, last_run_at = ?, last_run_id = ?,
           last_planned_at = ?, last_failure_code = ?,
           last_failure_reason = ?, revision_no = ?, updated_at = ?
       WHERE id = ? AND team_id = ? AND revision_no = ?`,
      [
        schedule.status,
        mysqlDate(schedule.nextRunAt),
        schedule.lastRunAt ? mysqlDate(schedule.lastRunAt) : null,
        schedule.lastRunId,
        schedule.lastPlannedAt ? mysqlDate(schedule.lastPlannedAt) : null,
        schedule.lastFailureCode,
        schedule.lastFailureReason,
        schedule.revision,
        mysqlDate(schedule.updatedAt),
        schedule.id,
        schedule.teamId,
        existing.revision
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("定时获客计划数据库并发更新失败");
    }
  }
}

function validAgentJobTransition(existing: AgentJob, desired: AgentJob) {
  if (existing.status === desired.status) return true;
  if (isProspectRunBridgeJob(existing)) {
    const transitions: Record<
      AgentJob["status"],
      ReadonlySet<AgentJob["status"]>
    > = {
      queued: new Set(["running", "cancelled", "succeeded", "failed"]),
      running: new Set([
        "queued",
        "retry_scheduled",
        "succeeded",
        "failed",
        "cancelled",
        "dead_letter"
      ]),
      retry_scheduled: new Set([
        "queued",
        "running",
        "failed",
        "cancelled",
        "dead_letter"
      ]),
      succeeded: new Set(["cancelled"]),
      failed: new Set(["queued", "cancelled"]),
      cancelled: new Set(),
      dead_letter: new Set(["queued", "cancelled"])
    };
    return transitions[existing.status].has(desired.status);
  }
  const transitions: Record<
    AgentJob["status"],
    ReadonlySet<AgentJob["status"]>
  > = {
    queued: new Set(["running", "cancelled"]),
    running: new Set([
      "retry_scheduled",
      "succeeded",
      "failed",
      "cancelled",
      "dead_letter"
    ]),
    retry_scheduled: new Set(["running", "cancelled"]),
    succeeded: new Set(),
    failed: new Set(["queued"]),
    cancelled: new Set(),
    dead_letter: new Set(["queued"])
  };
  return transitions[existing.status].has(desired.status);
}

async function syncAgentJobRows(
  connection: mysql.PoolConnection,
  desired: AgentJob[],
  owns: (item: Pick<AgentJob, "jobType">) => boolean = () => true
) {
  const persisted = await loadAgentJobs(connection);
  const ownedDesired = desired.filter(owns);
  const desiredById = new Map(ownedDesired.map((item) => [item.id, item]));
  if (desiredById.size !== ownedDesired.length) {
    throw new Error("智能获客任务存在重复主键");
  }
  for (const existing of persisted.filter(owns)) {
    if (!desiredById.has(existing.id)) {
      throw new Error("智能获客任务不允许通过普通持久化删除");
    }
  }
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  for (const job of ownedDesired) {
    const existing = persistedById.get(job.id);
    if (!existing) {
      await insertRows(
        connection,
        "agent_jobs",
        [job],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.jobType,
          item.aggregateType,
          item.aggregateId,
          item.parentJobId,
          item.status,
          item.priority,
          item.idempotencyKey,
          item.policyVersion,
          item.inputJsonEncrypted,
          item.outputJsonEncrypted,
          item.attemptCount,
          item.maxAttempts,
          item.nextAttemptAt ? mysqlDate(item.nextAttemptAt) : null,
          item.errorCode,
          item.errorMessage,
          item.traceId,
          item.startedAt ? mysqlDate(item.startedAt) : null,
          item.finishedAt ? mysqlDate(item.finishedAt) : null,
          mysqlDate(item.createdAt)
        ],
        `(id,team_id,owner_id,job_type,aggregate_type,aggregate_id,
          parent_job_id,status,priority,idempotency_key,policy_version,
          input_json_encrypted,output_json_encrypted,attempt_count,
          max_attempts,next_attempt_at,error_code,error_message,trace_id,
          started_at,finished_at,created_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, job)) continue;
    const immutableFieldsMatch = existing.teamId === job.teamId
      && existing.ownerId === job.ownerId
      && existing.jobType === job.jobType
      && existing.aggregateType === job.aggregateType
      && existing.aggregateId === job.aggregateId
      && existing.parentJobId === job.parentJobId
      && existing.priority === job.priority
      && existing.idempotencyKey === job.idempotencyKey
      && existing.policyVersion === job.policyVersion
      && existing.inputJsonEncrypted === job.inputJsonEncrypted
      && existing.maxAttempts === job.maxAttempts
      && existing.traceId === job.traceId
      && existing.createdAt === job.createdAt;
    if (!immutableFieldsMatch
      || job.attemptCount < existing.attemptCount
      || job.attemptCount > existing.attemptCount + 1
      || !validAgentJobTransition(existing, job)) {
      throw new Error("智能获客任务并发状态冲突或不可变字段被修改");
    }
    const [result] = await connection.query(
      `UPDATE agent_jobs
       SET status = ?, output_json_encrypted = ?, attempt_count = ?,
           next_attempt_at = ?, error_code = ?, error_message = ?,
           started_at = ?, finished_at = ?
       WHERE id = ? AND team_id = ? AND owner_id = ?
         AND status = ? AND attempt_count = ?`,
      [
        job.status,
        job.outputJsonEncrypted,
        job.attemptCount,
        job.nextAttemptAt ? mysqlDate(job.nextAttemptAt) : null,
        job.errorCode,
        job.errorMessage,
        job.startedAt ? mysqlDate(job.startedAt) : null,
        job.finishedAt ? mysqlDate(job.finishedAt) : null,
        job.id,
        job.teamId,
        job.ownerId,
        existing.status,
        existing.attemptCount
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("智能获客任务数据库 CAS 更新失败");
    }
  }
}

async function syncAgentJobIdempotencyAliasRows(
  connection: mysql.PoolConnection,
  desired: AgentJobIdempotencyAlias[],
  owns: (item: Pick<AgentJob, "jobType">) => boolean = () => true
) {
  const persisted = (await loadAgentJobIdempotencyAliases(connection))
    .filter(owns);
  const ownedDesired = desired.filter(owns);
  verifyImmutableRows(
    persisted,
    ownedDesired,
    "智能任务幂等别名"
  );
  const persistedIds = new Set(persisted.map((item) => item.id));
  await insertRows(
    connection,
    "agent_job_idempotency_aliases",
    ownedDesired.filter((item) => !persistedIds.has(item.id)),
    (item) => [
      item.id,
      item.jobId,
      item.teamId,
      item.jobType,
      item.idempotencyKey,
      mysqlDate(item.createdAt)
    ],
    "(id,job_id,team_id,job_type,idempotency_key,created_at)"
  );
}

async function appendProspectRunQueueBindingRows(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persistedParents = await loadProspectRunQueueParentBindings(connection);
  const persistedChildren = await loadProspectRunQueueChildBindings(connection);
  verifyImmutableRows(
    persistedParents,
    store.prospectRunQueueParentBindings,
    "搜索运行父桥接绑定"
  );
  verifyImmutableRows(
    persistedChildren,
    store.prospectRunQueueChildBindings,
    "搜索运行子桥接绑定"
  );
  const parentIds = new Set(persistedParents.map((item) => item.id));
  const childIds = new Set(persistedChildren.map((item) => item.id));
  await insertRows(
    connection,
    "prospect_run_queue_parent_bindings",
    store.prospectRunQueueParentBindings.filter(
      (item) => !parentIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.teamId,
      item.runId,
      item.ownerId,
      item.jobId,
      item.jobType,
      item.parentJobId,
      item.bridgeVersion,
      item.executionSnapshotHash,
      item.bindingHash,
      mysqlDate(item.createdAt)
    ],
    `(id,team_id,run_id,owner_id,job_id,job_type,parent_job_id,
      bridge_version,execution_snapshot_hash,binding_hash,created_at)`
  );
  await insertRows(
    connection,
    "prospect_run_queue_child_bindings",
    store.prospectRunQueueChildBindings.filter(
      (item) => !childIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.teamId,
      item.runId,
      item.shardId,
      item.ownerId,
      item.jobId,
      item.jobType,
      item.parentJobId,
      item.bridgeVersion,
      item.executionSnapshotHash,
      item.bindingHash,
      mysqlDate(item.createdAt)
    ],
    `(id,team_id,run_id,shard_id,owner_id,job_id,job_type,parent_job_id,
      bridge_version,execution_snapshot_hash,binding_hash,created_at)`
  );
}

async function syncProspectExecutionKernelState(
  connection: mysql.PoolConnection,
  desired: ProspectExecutionKernelState[]
) {
  if (desired.length > 1) {
    throw new Error("搜索执行内核状态只能存在一行");
  }
  const persisted = (await loadProspectExecutionState(connection)).kernelStates;
  if (!desired.length) {
    if (persisted.length) throw new Error("搜索执行内核状态不允许删除");
    return;
  }
  const state = desired[0];
  const existing = persisted[0];
  if (!existing) {
    await insertRows(
      connection,
      "search_execution_kernel_state",
      [state],
      (item) => [
        item.id,
        item.kernelEpoch,
        item.instanceId,
        mysqlDate(item.startedAt),
        mysqlDate(item.updatedAt)
      ],
      "(id,kernel_epoch,instance_id,started_at,updated_at)"
    );
    return;
  }
  if (isDeepStrictEqual(existing, state)) return;
  if (state.id !== existing.id
    || state.kernelEpoch !== existing.kernelEpoch + 1) {
    throw new Error("搜索执行内核 epoch CAS 冲突");
  }
  const [result] = await connection.query(
    `UPDATE search_execution_kernel_state
     SET kernel_epoch = ?, instance_id = ?, started_at = ?, updated_at = ?
     WHERE id = ? AND kernel_epoch = ?`,
    [
      state.kernelEpoch,
      state.instanceId,
      mysqlDate(state.startedAt),
      mysqlDate(state.updatedAt),
      state.id,
      existing.kernelEpoch
    ]
  );
  if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
    throw new Error("搜索执行内核 epoch 数据库 CAS 更新失败");
  }
}

function executionTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("搜索执行事实包含无效时间");
  }
  return timestamp;
}

function validateProspectCheckpointMutation(
  existing: ProspectExecutionCheckpoint,
  checkpoint: ProspectExecutionCheckpoint
) {
  const epochAdvanced = checkpoint.runEpoch === existing.runEpoch + 1;
  const checkpointAdvanced =
    checkpoint.checkpointNo === existing.checkpointNo + 1;
  const pageAdvanced =
    checkpoint.pageSequence === existing.pageSequence + 1;
  const callAdvanced =
    checkpoint.totalCallCount === existing.totalCallCount + 1;
  const aggregatesUnchanged =
    checkpoint.acceptedCount === existing.acceptedCount
    && checkpoint.rawCount === existing.rawCount
    && checkpoint.invalidCount === existing.invalidCount
    && checkpoint.duplicateCount === existing.duplicateCount;

  if (existing.completionReason
    || (checkpoint.runEpoch !== existing.runEpoch && !epochAdvanced)
    || (checkpoint.checkpointNo !== existing.checkpointNo
      && !checkpointAdvanced)
    || (checkpoint.pageSequence !== existing.pageSequence && !pageAdvanced)
    || (checkpoint.totalCallCount !== existing.totalCallCount && !callAdvanced)
    || checkpoint.acceptedCount < existing.acceptedCount
    || checkpoint.rawCount < existing.rawCount
    || checkpoint.invalidCount < existing.invalidCount
    || checkpoint.duplicateCount < existing.duplicateCount
    || (existing.partial && !checkpoint.partial)
    || executionTimestamp(checkpoint.updatedAt)
      < executionTimestamp(existing.updatedAt)) {
    throw new Error("搜索执行 checkpoint 发生回退或终态被修改");
  }

  if (epochAdvanced) {
    if (checkpointAdvanced
      || pageAdvanced
      || callAdvanced
      || checkpoint.checkpointCallCount !== existing.checkpointCallCount
      || !aggregatesUnchanged
      || checkpoint.cursorHash !== existing.cursorHash
      || checkpoint.completionReason !== existing.completionReason) {
      throw new Error("搜索执行 checkpoint 跨 epoch 恢复字段无效");
    }
    return;
  }

  if (checkpointAdvanced) {
    if (!pageAdvanced
      || callAdvanced
      || checkpoint.checkpointCallCount !== 0
      || checkpoint.completionReason) {
      throw new Error("搜索执行 checkpoint 续页推进字段无效");
    }
    return;
  }

  if (checkpoint.checkpointCallCount < existing.checkpointCallCount
    || checkpoint.checkpointCallCount > existing.checkpointCallCount + 1
    || callAdvanced !== (
      checkpoint.checkpointCallCount === existing.checkpointCallCount + 1
    )) {
    throw new Error("搜索执行 checkpoint 调用计数推进无效");
  }

  if (pageAdvanced) {
    if (callAdvanced || !checkpoint.completionReason) {
      throw new Error("搜索执行 checkpoint 终页结算字段无效");
    }
  } else if (!aggregatesUnchanged) {
    throw new Error("搜索执行 checkpoint 聚合计数缺少对应页事实");
  }
}

async function syncProspectExecutionCheckpoints(
  connection: mysql.PoolConnection,
  desired: ProspectExecutionCheckpoint[]
) {
  const persisted = (await loadProspectExecutionState(connection)).checkpoints;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("搜索执行 checkpoint 存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("搜索执行 checkpoint 不允许删除");
    }
  }
  for (const checkpoint of desired) {
    const existing = persistedById.get(checkpoint.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_execution_checkpoints",
        [checkpoint],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.runId,
          item.shardId,
          item.jobId,
          item.providerCode,
          item.runEpoch,
          item.checkpointNo,
          item.encryptedCursor,
          item.cursorHash,
          item.pageSequence,
          item.totalCallCount,
          item.checkpointCallCount,
          item.acceptedCount,
          item.rawCount,
          item.invalidCount,
          item.duplicateCount,
          item.retryAfterAt ? mysqlDate(item.retryAfterAt) : null,
          item.lastErrorCode,
          item.lastErrorMessage,
          item.partial,
          item.completionReason,
          item.version,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt)
        ],
        `(id,team_id,owner_id,run_id,shard_id,job_id,provider_code,
          run_epoch,checkpoint_no,encrypted_cursor,cursor_hash,page_sequence,
          total_call_count,checkpoint_call_count,accepted_count,raw_count,
          invalid_count,duplicate_count,retry_after_at,last_error_code,
          last_error_message,partial,completion_reason,version_no,created_at,
          updated_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, checkpoint)) continue;
    const immutableFieldsMatch = checkpoint.teamId === existing.teamId
      && checkpoint.ownerId === existing.ownerId
      && checkpoint.runId === existing.runId
      && checkpoint.shardId === existing.shardId
      && checkpoint.jobId === existing.jobId
      && checkpoint.providerCode === existing.providerCode
      && checkpoint.createdAt === existing.createdAt;
    if (!immutableFieldsMatch
      || checkpoint.version !== existing.version + 1) {
      throw new Error("搜索执行 checkpoint CAS 冲突或作用域被修改");
    }
    validateProspectCheckpointMutation(existing, checkpoint);
    const [result] = await connection.query(
      `UPDATE prospect_execution_checkpoints
       SET run_epoch = ?, checkpoint_no = ?, encrypted_cursor = ?,
           cursor_hash = ?, page_sequence = ?, total_call_count = ?,
           checkpoint_call_count = ?, accepted_count = ?, raw_count = ?,
           invalid_count = ?, duplicate_count = ?, retry_after_at = ?,
           last_error_code = ?, last_error_message = ?, partial = ?,
           completion_reason = ?, version_no = ?, updated_at = ?
       WHERE id = ? AND team_id = ? AND owner_id = ? AND version_no = ?`,
      [
        checkpoint.runEpoch,
        checkpoint.checkpointNo,
        checkpoint.encryptedCursor,
        checkpoint.cursorHash,
        checkpoint.pageSequence,
        checkpoint.totalCallCount,
        checkpoint.checkpointCallCount,
        checkpoint.acceptedCount,
        checkpoint.rawCount,
        checkpoint.invalidCount,
        checkpoint.duplicateCount,
        checkpoint.retryAfterAt ? mysqlDate(checkpoint.retryAfterAt) : null,
        checkpoint.lastErrorCode,
        checkpoint.lastErrorMessage,
        checkpoint.partial,
        checkpoint.completionReason,
        checkpoint.version,
        mysqlDate(checkpoint.updatedAt),
        checkpoint.id,
        checkpoint.teamId,
        checkpoint.ownerId,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("搜索执行 checkpoint 数据库 CAS 更新失败");
    }
  }
}

function validateProspectLeaseMutation(
  existing: ProspectExecutionLease,
  lease: ProspectExecutionLease
) {
  if (existing.status !== "active") {
    throw new Error("搜索执行租约终态不允许修改");
  }
  if (lease.status !== "active"
    && lease.status !== "released"
    && lease.status !== "expired") {
    throw new Error("搜索执行租约状态迁移无效");
  }
  if (executionTimestamp(lease.heartbeatAt)
      < executionTimestamp(existing.heartbeatAt)
    || executionTimestamp(lease.expiresAt)
      < executionTimestamp(existing.expiresAt)
    || (existing.requestStartedAt
      && lease.requestStartedAt !== existing.requestStartedAt)
    || (!existing.requestStartedAt
      && lease.requestStartedAt
      && executionTimestamp(lease.requestStartedAt)
        < executionTimestamp(lease.claimedAt))) {
    throw new Error("搜索执行租约心跳或请求时间发生回退");
  }
  if (lease.status === "active") {
    if (lease.releasedAt || lease.releaseReason) {
      throw new Error("活动搜索执行租约不能包含释放事实");
    }
    return;
  }
  if (!lease.releasedAt
    || !lease.releaseReason
    || executionTimestamp(lease.releasedAt)
      < executionTimestamp(lease.claimedAt)
    || (lease.requestStartedAt
      && executionTimestamp(lease.releasedAt)
        < executionTimestamp(lease.requestStartedAt))) {
    throw new Error("搜索执行租约终态缺少有效释放事实");
  }
}

async function syncProspectExecutionLeases(
  connection: mysql.PoolConnection,
  desired: ProspectExecutionLease[]
) {
  const persisted = (await loadProspectExecutionState(connection)).leases;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("搜索执行租约存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("搜索执行租约历史不允许删除");
    }
  }
  for (const lease of desired) {
    const existing = persistedById.get(lease.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_execution_leases",
        [lease],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.runId,
          item.shardId,
          item.jobId,
          item.kernelEpoch,
          item.runEpoch,
          item.fenceToken,
          item.claimTokenHmac,
          item.workerId,
          item.status,
          mysqlDate(item.claimedAt),
          mysqlDate(item.heartbeatAt),
          mysqlDate(item.expiresAt),
          mysqlDate(item.deadlineAt),
          item.requestStartedAt ? mysqlDate(item.requestStartedAt) : null,
          item.releasedAt ? mysqlDate(item.releasedAt) : null,
          item.releaseReason,
          item.version
        ],
        `(id,team_id,owner_id,run_id,shard_id,job_id,kernel_epoch,
          run_epoch,fence_token,claim_token_hmac,worker_id,status,claimed_at,
          heartbeat_at,expires_at,deadline_at,request_started_at,released_at,
          release_reason,version_no)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, lease)) continue;
    const immutableFieldsMatch = lease.teamId === existing.teamId
      && lease.ownerId === existing.ownerId
      && lease.runId === existing.runId
      && lease.shardId === existing.shardId
      && lease.jobId === existing.jobId
      && lease.kernelEpoch === existing.kernelEpoch
      && lease.runEpoch === existing.runEpoch
      && lease.fenceToken === existing.fenceToken
      && lease.claimTokenHmac === existing.claimTokenHmac
      && lease.workerId === existing.workerId
      && lease.claimedAt === existing.claimedAt
      && lease.deadlineAt === existing.deadlineAt;
    if (!immutableFieldsMatch || lease.version !== existing.version + 1) {
      throw new Error("搜索执行租约 CAS 冲突或 fence 身份被修改");
    }
    validateProspectLeaseMutation(existing, lease);
    const [result] = await connection.query(
      `UPDATE prospect_execution_leases
       SET status = ?, heartbeat_at = ?, expires_at = ?,
           request_started_at = ?, released_at = ?, release_reason = ?,
           version_no = ?
       WHERE id = ? AND team_id = ? AND owner_id = ?
         AND status = ? AND version_no = ?`,
      [
        lease.status,
        mysqlDate(lease.heartbeatAt),
        mysqlDate(lease.expiresAt),
        lease.requestStartedAt ? mysqlDate(lease.requestStartedAt) : null,
        lease.releasedAt ? mysqlDate(lease.releasedAt) : null,
        lease.releaseReason,
        lease.version,
        lease.id,
        lease.teamId,
        lease.ownerId,
        existing.status,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("搜索执行租约数据库 CAS 更新失败");
    }
  }
}

function validateProspectAttemptMutation(
  existing: ProspectExecutionAttempt,
  attempt: ProspectExecutionAttempt
) {
  const terminalStatuses = new Set<ProspectExecutionAttempt["status"]>([
    "succeeded",
    "failed",
    "request_outcome_unknown",
    "cancelled_late"
  ]);
  const transitions: Record<
    "claimed" | "request_started" | "request_outcome_unknown",
    ReadonlySet<ProspectExecutionAttempt["status"]>
  > = {
    claimed: new Set(["request_started", "failed"]),
    request_started: terminalStatuses,
    request_outcome_unknown: new Set(["cancelled_late"])
  };
  if (existing.status !== "claimed"
    && existing.status !== "request_started"
    && existing.status !== "request_outcome_unknown") {
    throw new Error("搜索执行尝试状态迁移无效或终态被修改");
  }
  if (!transitions[existing.status].has(attempt.status)) {
    throw new Error("搜索执行尝试状态迁移无效或终态被修改");
  }
  if (attempt.checkpointNo !== existing.checkpointNo) {
    throw new Error("搜索执行尝试 checkpoint 身份不允许修改");
  }

  if (existing.status === "request_outcome_unknown") {
    if (attempt.status !== "cancelled_late"
      || existing.responseHash
      || existing.usageJson
      || existing.costKind !== "unknown"
      || existing.costAmount !== null
      || existing.currency
      || attempt.checkpointCallNo !== existing.checkpointCallNo
      || attempt.providerAttemptNo !== existing.providerAttemptNo
      || attempt.requestHash !== existing.requestHash
      || attempt.startedAt !== existing.startedAt
      || !attempt.responseHash
      || !attempt.usageJson
      || !attempt.finishedAt
      || attempt.finishedAt < existing.finishedAt
      || !attempt.errorCode
      || !attempt.errorMessage
      || attempt.retryable
      || attempt.retryAfterAt) {
      throw new Error("未知结果尝试只能以完整迟到响应事实结算");
    }
    return;
  }

  if (existing.status === "claimed" && attempt.status === "request_started") {
    if (attempt.checkpointCallNo < 1
      || attempt.checkpointCallNo > 3
      || attempt.providerAttemptNo < 1
      || !attempt.requestHash
      || !attempt.startedAt
      || attempt.responseHash
      || attempt.finishedAt
      || attempt.usageJson
      || attempt.costKind !== "unknown"
      || attempt.costAmount !== null
      || attempt.currency
      || attempt.errorCode
      || attempt.errorMessage
      || attempt.retryable
      || attempt.retryAfterAt) {
      throw new Error("搜索执行尝试发请求前后的字段状态无效");
    }
    return;
  }

  if (existing.status === "claimed") {
    if (attempt.checkpointCallNo !== 0
      || attempt.providerAttemptNo !== 0
      || attempt.requestHash
      || attempt.responseHash
      || attempt.startedAt
      || !attempt.finishedAt
      || attempt.usageJson
      || attempt.costKind !== "unknown"
      || attempt.costAmount !== null
      || attempt.currency) {
      throw new Error("搜索执行尝试发出请求前的失败结算字段无效");
    }
    return;
  }

  if (attempt.checkpointCallNo !== existing.checkpointCallNo
    || attempt.providerAttemptNo !== existing.providerAttemptNo
    || attempt.requestHash !== existing.requestHash
    || attempt.startedAt !== existing.startedAt
    || !attempt.finishedAt) {
    throw new Error("搜索执行尝试结算时修改了请求身份");
  }
}

async function syncProspectExecutionAttempts(
  connection: mysql.PoolConnection,
  desired: ProspectExecutionAttempt[]
) {
  const persisted = (await loadProspectExecutionState(connection)).attempts;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("搜索执行尝试存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("搜索执行尝试历史不允许删除");
    }
  }
  for (const attempt of desired) {
    const existing = persistedById.get(attempt.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_execution_attempts",
        [attempt],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.runId,
          item.shardId,
          item.jobId,
          item.leaseId,
          item.providerCode,
          item.checkpointNo,
          item.checkpointCallNo,
          item.providerAttemptNo,
          item.status,
          item.requestHash,
          item.responseHash,
          item.errorCode,
          item.errorMessage,
          item.retryable,
          item.retryAfterAt ? mysqlDate(item.retryAfterAt) : null,
          item.usageJson || null,
          item.costKind,
          item.costAmount,
          item.currency,
          item.startedAt ? mysqlDate(item.startedAt) : null,
          item.finishedAt ? mysqlDate(item.finishedAt) : null,
          mysqlDate(item.createdAt),
          item.version
        ],
        `(id,team_id,owner_id,run_id,shard_id,job_id,lease_id,
          provider_code,checkpoint_no,checkpoint_call_no,provider_attempt_no,
          status,request_hash,response_hash,error_code,error_message,retryable,
          retry_after_at,usage_json,cost_kind,cost_amount,currency,started_at,
          finished_at,created_at,version_no)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, attempt)) continue;
    const immutableFieldsMatch = attempt.teamId === existing.teamId
      && attempt.ownerId === existing.ownerId
      && attempt.runId === existing.runId
      && attempt.shardId === existing.shardId
      && attempt.jobId === existing.jobId
      && attempt.leaseId === existing.leaseId
      && attempt.providerCode === existing.providerCode
      && attempt.createdAt === existing.createdAt;
    if (!immutableFieldsMatch || attempt.version !== existing.version + 1) {
      const changedFields = Object.keys(attempt).filter((field) =>
        !isDeepStrictEqual(
          (existing as unknown as Record<string, unknown>)[field],
          (attempt as unknown as Record<string, unknown>)[field]
        )
      );
      throw new Error(
        `搜索执行尝试 CAS 冲突或作用域被修改`
        + `（字段：${changedFields.join(",") || "无"}；`
        + `版本：${existing.version}->${attempt.version}）`
      );
    }
    validateProspectAttemptMutation(existing, attempt);
    const [result] = await connection.query(
      `UPDATE prospect_execution_attempts
       SET checkpoint_no = ?, checkpoint_call_no = ?,
           provider_attempt_no = ?, status = ?, request_hash = ?,
           response_hash = ?, error_code = ?, error_message = ?,
           retryable = ?, retry_after_at = ?, usage_json = ?,
           cost_kind = ?, cost_amount = ?, currency = ?, started_at = ?,
           finished_at = ?, version_no = ?
       WHERE id = ? AND team_id = ? AND owner_id = ?
         AND status = ? AND version_no = ?`,
      [
        attempt.checkpointNo,
        attempt.checkpointCallNo,
        attempt.providerAttemptNo,
        attempt.status,
        attempt.requestHash,
        attempt.responseHash,
        attempt.errorCode,
        attempt.errorMessage,
        attempt.retryable,
        attempt.retryAfterAt ? mysqlDate(attempt.retryAfterAt) : null,
        attempt.usageJson || null,
        attempt.costKind,
        attempt.costAmount,
        attempt.currency,
        attempt.startedAt ? mysqlDate(attempt.startedAt) : null,
        attempt.finishedAt ? mysqlDate(attempt.finishedAt) : null,
        attempt.version,
        attempt.id,
        attempt.teamId,
        attempt.ownerId,
        existing.status,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("搜索执行尝试数据库 CAS 更新失败");
    }
  }
}

function providerRequestLedgerImmutableFieldsMatch(
  existing: ProspectProviderRequestLedger,
  ledger: ProspectProviderRequestLedger
) {
  return ledger.teamId === existing.teamId
    && ledger.ownerId === existing.ownerId
    && ledger.runId === existing.runId
    && ledger.shardId === existing.shardId
    && ledger.jobId === existing.jobId
    && ledger.originAttemptId === existing.originAttemptId
    && ledger.checkpointNo === existing.checkpointNo
    && ledger.logicalRequestNo === existing.logicalRequestNo
    && ledger.providerCode === existing.providerCode
    && ledger.connectionId === existing.connectionId
    && ledger.connectionRevision === existing.connectionRevision
    && ledger.connectionConfigHash === existing.connectionConfigHash
    && ledger.endpointCode === existing.endpointCode
    && ledger.adapterVersion === existing.adapterVersion
    && ledger.contractVersion === existing.contractVersion
    && ledger.requestSchemaVersion === existing.requestSchemaVersion
    && ledger.idempotencyKey === existing.idempotencyKey
    && ledger.requestHash === existing.requestHash
    && ledger.encryptedRequestEnvelope === existing.encryptedRequestEnvelope
    && ledger.requestEvidenceRef === existing.requestEvidenceRef
    && ledger.kernelEpochAtPrepare === existing.kernelEpochAtPrepare
    && ledger.runEpochAtPrepare === existing.runEpochAtPrepare
    && ledger.fenceTokenAtPrepare === existing.fenceTokenAtPrepare
    && ledger.leaseIdAtPrepare === existing.leaseIdAtPrepare
    && ledger.preparedAt === existing.preparedAt;
}

function providerRequestLedgerOneTimeFieldsPreserved(
  existing: ProspectProviderRequestLedger,
  ledger: ProspectProviderRequestLedger
) {
  const stringFields: Array<keyof ProspectProviderRequestLedger> = [
    "externalRequestId",
    "dispatchConfirmationRef",
    "encryptedResponseEnvelope",
    "responseEvidenceRef",
    "responseHash",
    "rawResponseHash",
    "normalizedResultHash",
    "responseAccountingEvidenceHash",
    "providerOutcomeCode",
    "settlementKind",
    "settlementHash",
    "unknownReason",
    "dispatchStartedAt",
    "dispatchConfirmedAt",
    "responseReceivedAt",
    "unknownAt",
    "settledAt",
    "cancelledLateAt"
  ];
  if (stringFields.some((field) =>
    Boolean(existing[field]) && ledger[field] !== existing[field]
  )) {
    return false;
  }
  const clearsUnknownOutcomeError =
    existing.status === "outcome_unknown"
    && ledger.status === "response_received"
    && existing.errorCode === "REQUEST_OUTCOME_UNKNOWN"
    && ledger.errorCode === "";
  return (!existing.errorCode
      || ledger.errorCode === existing.errorCode
      || clearsUnknownOutcomeError)
    && (existing.httpStatus === null
      || ledger.httpStatus === existing.httpStatus);
}

async function syncProspectProviderRequestLedgers(
  connection: mysql.PoolConnection,
  desired: ProspectProviderRequestLedger[]
) {
  const persisted =
    (await loadProspectExecutionState(connection)).providerRequestLedgers;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("Provider 请求账本存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("Provider 请求账本不允许删除");
    }
  }
  for (const ledger of desired) {
    const existing = persistedById.get(ledger.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_provider_request_ledgers",
        [ledger],
        (item) => [
          item.id,
          item.teamId,
          item.ownerId,
          item.runId,
          item.shardId,
          item.jobId,
          item.originAttemptId,
          item.checkpointNo,
          item.logicalRequestNo,
          item.providerCode,
          item.connectionId,
          item.connectionRevision,
          item.connectionConfigHash,
          item.endpointCode,
          item.adapterVersion,
          item.contractVersion,
          item.requestSchemaVersion,
          item.idempotencyKey,
          item.requestHash,
          item.encryptedRequestEnvelope || null,
          item.requestEvidenceRef,
          item.status,
          item.externalRequestId || null,
          item.dispatchConfirmationRef,
          item.encryptedResponseEnvelope || null,
          item.responseEvidenceRef,
          item.responseHash,
          item.rawResponseHash,
          item.normalizedResultHash,
          item.responseAccountingEvidenceHash,
          item.httpStatus,
          item.providerOutcomeCode,
          item.settlementKind,
          item.settlementHash,
          item.unknownReason,
          item.errorCode,
          item.kernelEpochAtPrepare,
          item.runEpochAtPrepare,
          item.fenceTokenAtPrepare,
          item.leaseIdAtPrepare,
          mysqlDate(item.preparedAt),
          item.dispatchStartedAt
            ? mysqlDate(item.dispatchStartedAt)
            : null,
          item.dispatchConfirmedAt
            ? mysqlDate(item.dispatchConfirmedAt)
            : null,
          item.responseReceivedAt
            ? mysqlDate(item.responseReceivedAt)
            : null,
          item.unknownAt ? mysqlDate(item.unknownAt) : null,
          item.settledAt ? mysqlDate(item.settledAt) : null,
          item.cancelledLateAt
            ? mysqlDate(item.cancelledLateAt)
            : null,
          mysqlDate(item.updatedAt),
          item.version
        ],
        `(id,team_id,owner_id,run_id,shard_id,job_id,origin_attempt_id,
          checkpoint_no,logical_request_no,provider_code,connection_id,
          connection_revision,connection_config_hash,endpoint_code,
          adapter_version,contract_version,request_schema_version,
          idempotency_key,request_hash,encrypted_request_envelope,
          request_evidence_ref,status,external_request_id,
          dispatch_confirmation_ref,encrypted_response_envelope,
          response_evidence_ref,response_hash,raw_response_hash,
          normalized_result_hash,response_accounting_evidence_hash,
          http_status,provider_outcome_code,settlement_kind,settlement_hash,
          unknown_reason,error_code,kernel_epoch_at_prepare,
          run_epoch_at_prepare,fence_token_at_prepare,lease_id_at_prepare,
          prepared_at,dispatch_started_at,dispatch_confirmed_at,
          response_received_at,unknown_at,settled_at,cancelled_late_at,
          updated_at,version_no)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, ledger)) continue;
    if (!providerRequestLedgerImmutableFieldsMatch(existing, ledger)
      || !providerRequestLedgerOneTimeFieldsPreserved(existing, ledger)
      || ledger.version <= existing.version
      || !isProspectProviderRequestTransitionAllowed(
        existing.status,
        ledger.status
      )) {
      throw new Error("Provider 请求账本 CAS 冲突或不可变证据被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_provider_request_ledgers
       SET status = ?, external_request_id = ?,
           dispatch_confirmation_ref = ?, encrypted_response_envelope = ?,
           response_evidence_ref = ?, response_hash = ?,
           raw_response_hash = ?, normalized_result_hash = ?,
           response_accounting_evidence_hash = ?, http_status = ?,
           provider_outcome_code = ?, settlement_kind = ?,
           settlement_hash = ?, unknown_reason = ?, error_code = ?,
           dispatch_started_at = ?, dispatch_confirmed_at = ?,
           response_received_at = ?, unknown_at = ?, settled_at = ?,
           cancelled_late_at = ?, updated_at = ?, version_no = ?
       WHERE id = ? AND team_id = ? AND owner_id = ?
         AND status = ? AND version_no = ?`,
      [
        ledger.status,
        ledger.externalRequestId || null,
        ledger.dispatchConfirmationRef,
        ledger.encryptedResponseEnvelope || null,
        ledger.responseEvidenceRef,
        ledger.responseHash,
        ledger.rawResponseHash,
        ledger.normalizedResultHash,
        ledger.responseAccountingEvidenceHash,
        ledger.httpStatus,
        ledger.providerOutcomeCode,
        ledger.settlementKind,
        ledger.settlementHash,
        ledger.unknownReason,
        ledger.errorCode,
        ledger.dispatchStartedAt
          ? mysqlDate(ledger.dispatchStartedAt)
          : null,
        ledger.dispatchConfirmedAt
          ? mysqlDate(ledger.dispatchConfirmedAt)
          : null,
        ledger.responseReceivedAt
          ? mysqlDate(ledger.responseReceivedAt)
          : null,
        ledger.unknownAt ? mysqlDate(ledger.unknownAt) : null,
        ledger.settledAt ? mysqlDate(ledger.settledAt) : null,
        ledger.cancelledLateAt
          ? mysqlDate(ledger.cancelledLateAt)
          : null,
        mysqlDate(ledger.updatedAt),
        ledger.version,
        ledger.id,
        ledger.teamId,
        ledger.ownerId,
        existing.status,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("Provider 请求账本数据库 CAS 更新失败");
    }
  }
}

function providerRequestDispatchImmutableFieldsMatch(
  existing: ProspectProviderRequestDispatch,
  dispatch: ProspectProviderRequestDispatch
) {
  return dispatch.ledgerId === existing.ledgerId
    && dispatch.teamId === existing.teamId
    && dispatch.ownerId === existing.ownerId
    && dispatch.runId === existing.runId
    && dispatch.shardId === existing.shardId
    && dispatch.attemptId === existing.attemptId
    && dispatch.dispatchNo === existing.dispatchNo
    && dispatch.operation === existing.operation
    && dispatch.idempotencyKey === existing.idempotencyKey
    && dispatch.requestHash === existing.requestHash
    && dispatch.startedAt === existing.startedAt;
}

async function syncProspectProviderRequestDispatches(
  connection: mysql.PoolConnection,
  desired: ProspectProviderRequestDispatch[]
) {
  const persisted =
    (await loadProspectExecutionState(connection)).providerRequestDispatches;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("Provider 请求派发记录存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("Provider 请求派发记录不允许删除");
    }
  }
  for (const dispatch of desired) {
    const existing = persistedById.get(dispatch.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_provider_request_dispatches",
        [dispatch],
        (item) => [
          item.id,
          item.ledgerId,
          item.teamId,
          item.ownerId,
          item.runId,
          item.shardId,
          item.attemptId,
          item.dispatchNo,
          item.operation,
          item.status,
          item.idempotencyKey,
          item.requestHash,
          item.replayed,
          item.providerExecuted,
          item.externalRequestId,
          item.responseHash,
          item.errorCode,
          mysqlDate(item.startedAt),
          item.confirmedAt ? mysqlDate(item.confirmedAt) : null,
          item.finishedAt ? mysqlDate(item.finishedAt) : null,
          item.version
        ],
        `(id,ledger_id,team_id,owner_id,run_id,shard_id,attempt_id,
          dispatch_no,operation,status,idempotency_key,request_hash,replayed,
          provider_executed,external_request_id,response_hash,error_code,
          started_at,confirmed_at,finished_at,version_no)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, dispatch)) continue;
    const recordsLateProviderResponse =
      existing.status === "outcome_unknown"
      && dispatch.status === "response_received";
    const oneTimeFieldsPreserved =
      (!existing.externalRequestId
        || dispatch.externalRequestId === existing.externalRequestId)
      && (!existing.responseHash
        || dispatch.responseHash === existing.responseHash)
      && (!existing.errorCode
        || dispatch.errorCode === existing.errorCode
        || (recordsLateProviderResponse
          && existing.errorCode === "REQUEST_OUTCOME_UNKNOWN"
          && dispatch.errorCode === ""))
      && (!existing.confirmedAt
        || dispatch.confirmedAt === existing.confirmedAt)
      && (!existing.finishedAt
        || dispatch.finishedAt === existing.finishedAt
        || (recordsLateProviderResponse
          && executionTimestamp(dispatch.finishedAt)
            > executionTimestamp(existing.finishedAt)));
    if (!providerRequestDispatchImmutableFieldsMatch(existing, dispatch)
      || !oneTimeFieldsPreserved
      || dispatch.version <= existing.version
      || !isProspectProviderDispatchTransitionAllowed(
        existing.status,
        dispatch.status
      )) {
      throw new Error("Provider 请求派发记录 CAS 冲突或证据被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_provider_request_dispatches
       SET status = ?, replayed = ?, provider_executed = ?,
           external_request_id = ?, response_hash = ?, error_code = ?,
           confirmed_at = ?, finished_at = ?, version_no = ?
       WHERE id = ? AND team_id = ? AND owner_id = ?
         AND status = ? AND version_no = ?`,
      [
        dispatch.status,
        dispatch.replayed,
        dispatch.providerExecuted,
        dispatch.externalRequestId,
        dispatch.responseHash,
        dispatch.errorCode,
        dispatch.confirmedAt ? mysqlDate(dispatch.confirmedAt) : null,
        dispatch.finishedAt ? mysqlDate(dispatch.finishedAt) : null,
        dispatch.version,
        dispatch.id,
        dispatch.teamId,
        dispatch.ownerId,
        existing.status,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("Provider 请求派发记录数据库 CAS 更新失败");
    }
  }
}

async function appendProspectProviderRequestFacts(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persisted = await loadProspectExecutionState(connection);
  verifyImmutableRows(
    persisted.providerRequestAttemptBindings,
    store.prospectProviderRequestAttemptBindings,
    "Provider 请求执行尝试绑定"
  );
  verifyImmutableRows(
    persisted.providerRequestEvents,
    store.prospectProviderRequestEvents,
    "Provider 请求状态事件"
  );
  verifyImmutableRows(
    persisted.providerRequestAccountingEvidence,
    store.prospectProviderRequestAccountingEvidence,
    "Provider 请求成本证据"
  );
  const bindingIds = new Set(
    persisted.providerRequestAttemptBindings.map((item) => item.id)
  );
  const eventIds = new Set(
    persisted.providerRequestEvents.map((item) => item.id)
  );
  const accountingIds = new Set(
    persisted.providerRequestAccountingEvidence.map((item) => item.id)
  );
  await insertRows(
    connection,
    "prospect_provider_request_attempt_bindings",
    store.prospectProviderRequestAttemptBindings.filter(
      (item) => !bindingIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.ledgerId,
      item.attemptId,
      item.teamId,
      item.ownerId,
      item.bindingNo,
      mysqlDate(item.createdAt)
    ],
    `(id,ledger_id,attempt_id,team_id,owner_id,binding_no,created_at)`
  );
  await insertRows(
    connection,
    "prospect_provider_request_events",
    store.prospectProviderRequestEvents.filter(
      (item) => !eventIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.ledgerId,
      item.dispatchId || null,
      item.attemptId,
      item.teamId,
      item.ownerId,
      item.sequence,
      item.eventType,
      item.fromStatus,
      item.toStatus,
      item.detailHash,
      mysqlDate(item.createdAt)
    ],
    `(id,ledger_id,dispatch_id,attempt_id,team_id,owner_id,sequence_no,
      event_type,from_status,to_status,detail_hash,created_at)`
  );
  await insertRows(
    connection,
    "prospect_provider_request_accounting_evidence",
    store.prospectProviderRequestAccountingEvidence.filter(
      (item) => !accountingIds.has(item.id)
    ),
    (item) => [
      item.id,
      item.ledgerId,
      item.teamId,
      item.ownerId,
      item.sequence,
      item.provenance,
      item.usageJson || null,
      item.costAmount,
      item.currency,
      item.evidenceRef,
      item.evidenceHash,
      item.estimationMethodVersion,
      mysqlDate(item.createdAt)
    ],
    `(id,ledger_id,team_id,owner_id,sequence_no,provenance,usage_json,
      cost_amount,currency,evidence_ref,evidence_hash,
      estimation_method_version,created_at)`
  );
}

async function appendProspectExecutionPagesAndEvents(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persisted = await loadProspectExecutionState(connection);
  verifyImmutableRows(
    persisted.pages,
    store.prospectExecutionPages,
    "搜索执行页摘要"
  );
  verifyImmutableRows(
    persisted.events,
    store.prospectExecutionEvents,
    "搜索执行事件"
  );
  const pageIds = new Set(persisted.pages.map((item) => item.id));
  const eventIds = new Set(persisted.events.map((item) => item.id));
  await insertRows(
    connection,
    "prospect_execution_pages",
    store.prospectExecutionPages.filter((item) => !pageIds.has(item.id)),
    (item) => [
      item.id,
      item.teamId,
      item.ownerId,
      item.runId,
      item.shardId,
      item.jobId,
      item.attemptId,
      item.providerCode,
      item.checkpointNo,
      item.pageSequence,
      item.payloadHash,
      item.acceptedCount,
      item.rawCount,
      item.invalidCount,
      item.duplicateCount,
      item.partial,
      mysqlDate(item.createdAt)
    ],
    `(id,team_id,owner_id,run_id,shard_id,job_id,attempt_id,
      provider_code,checkpoint_no,page_sequence,payload_hash,accepted_count,
      raw_count,invalid_count,duplicate_count,partial,created_at)`
  );
  await insertRows(
    connection,
    "prospect_execution_events",
    store.prospectExecutionEvents.filter((item) => !eventIds.has(item.id)),
    (item) => [
      item.id,
      item.teamId,
      item.ownerId,
      item.runId,
      item.shardId,
      item.jobId,
      item.eventType,
      item.kernelEpoch,
      item.runEpoch,
      item.fenceToken,
      item.detailHash,
      mysqlDate(item.createdAt)
    ],
    `(id,team_id,owner_id,run_id,shard_id,job_id,event_type,kernel_epoch,
      run_epoch,fence_token,detail_hash,created_at)`
  );
}

async function appendProspectSourceRawRows(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persisted = await loadProspectExecutionState(connection);
  const desiredGroups: Array<{
    label: string;
    items: Array<{ id: string }>;
  }> = [
    { label: "Provider 原始记录", items: store.prospectSourceRawRecords },
    { label: "Provider 原始批次", items: store.prospectSourceRawBatches },
    { label: "Provider 原始命中", items: store.prospectSourceRawHits }
  ];
  for (const group of desiredGroups) {
    if (new Set(group.items.map((item) => item.id)).size
      !== group.items.length) {
      throw new ProspectSourceRawError(
        "PROSPECT_SOURCE_RAW_CONFLICT",
        `${group.label}存在重复主键`
      );
    }
  }
  const recordIds = new Set(
    persisted.sourceRawRecords.map((item) => item.id)
  );
  const batchIds = new Set(
    persisted.sourceRawBatches.map((item) => item.id)
  );
  const hitIds = new Set(persisted.sourceRawHits.map((item) => item.id));
  try {
    await insertRows(
      connection,
      "prospect_source_raw_records",
      store.prospectSourceRawRecords.filter(
        (item) => !recordIds.has(item.id)
      ),
      (item) => [
        item.id,
        item.teamId,
        item.ownerId,
        item.providerCode,
        item.connectionId,
        item.endpointCode,
        item.sourceIdentityHash,
        item.artifactHash,
        item.envelopeVersion,
        item.encryptedEnvelope,
        item.envelopeHash,
        mysqlDate(item.firstObservedAt),
        item.recordHash,
        mysqlDate(item.createdAt)
      ],
      `(id,team_id,owner_id,provider_code,connection_id,endpoint_code,
        source_identity_hash,artifact_hash,envelope_version,
        encrypted_envelope,envelope_hash,first_observed_at,record_hash,
        created_at)`
    );
    await insertRows(
      connection,
      "prospect_source_raw_batches",
      store.prospectSourceRawBatches.filter(
        (item) => !batchIds.has(item.id)
      ),
      (item) => [
        item.id,
        item.teamId,
        item.ownerId,
        item.runId,
        item.shardId,
        item.jobId,
        item.attemptId,
        item.ledgerId,
        item.pageId,
        item.providerCode,
        item.connectionId,
        item.endpointCode,
        item.adapterVersion,
        item.responseSchemaVersion,
        item.responseHash,
        item.settlementHash,
        item.rawArtifactHash,
        item.recordCount,
        item.licensePolicy,
        item.retentionPolicy,
        item.retentionDays,
        mysqlDate(item.retentionUntil),
        item.batchHash,
        mysqlDate(item.createdAt)
      ],
      `(id,team_id,owner_id,run_id,shard_id,job_id,attempt_id,ledger_id,
        page_id,provider_code,connection_id,endpoint_code,adapter_version,
        response_schema_version,response_hash,settlement_hash,
        raw_artifact_hash,record_count,license_policy,retention_policy,
        retention_days,retention_until,batch_hash,created_at)`
    );
    await insertRows(
      connection,
      "prospect_source_raw_hits",
      store.prospectSourceRawHits.filter((item) => !hitIds.has(item.id)),
      (item) => [
        item.id,
        item.batchId,
        item.recordId,
        item.teamId,
        item.ownerId,
        item.runId,
        item.shardId,
        item.jobId,
        item.attemptId,
        item.ledgerId,
        item.pageId,
        item.ordinal,
        mysqlDate(item.fetchedAt),
        item.hitHash,
        mysqlDate(item.createdAt)
      ],
      `(id,batch_id,record_id,team_id,owner_id,run_id,shard_id,job_id,
        attempt_id,ledger_id,page_id,ordinal,fetched_at,hit_hash,created_at)`
    );
  } catch (error) {
    if (isMysqlDuplicateKeyError(error)) {
      throw new ProspectSourceRawError(
        "PROSPECT_SOURCE_RAW_CONFLICT",
        "Provider 原始事实数据库唯一约束或 CAS 冲突"
      );
    }
    throw error;
  }
}

async function syncProspectStrategySourcePositions(
  connection: mysql.PoolConnection,
  desired: ProspectStrategySourcePosition[]
) {
  const persisted =
    (await loadProspectExecutionState(connection)).sourcePositions;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("获客数据源续搜位置存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("获客数据源续搜位置不允许删除");
    }
  }
  for (const position of desired) {
    const existing = persistedById.get(position.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_strategy_source_positions",
        [position],
        (item) => [
          item.id,
          item.identityHash,
          item.teamId,
          item.ownerId,
          item.campaignId,
          item.campaignVersion,
          item.strategyId,
          item.providerCode,
          item.queryFingerprint,
          item.connectionId,
          item.endpointCode,
          item.adapterVersion,
          item.contractVersion,
          item.catalogVersion,
          item.timeWindowMode,
          item.timeWindowFrom,
          item.timeWindowTo,
          item.status,
          item.encryptedCursor,
          item.cursorHash,
          item.sourceRunId,
          item.sourceShardId,
          item.sourcePageId,
          item.sourceCheckpointNo,
          item.sourcePageSequence,
          item.version,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt)
        ],
        `(id,identity_hash,team_id,owner_id,campaign_id,campaign_version,
          strategy_id,provider_code,query_fingerprint,connection_id,
          endpoint_code,adapter_version,contract_version,catalog_version,
          time_window_mode,time_window_from,time_window_to,status,
          encrypted_cursor,cursor_hash,source_run_id,source_shard_id,
          source_page_id,source_checkpoint_no,source_page_sequence,
          version_no,created_at,updated_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, position)) continue;
    const immutableFieldsMatch =
      position.identityHash === existing.identityHash
      && position.teamId === existing.teamId
      && position.ownerId === existing.ownerId
      && position.campaignId === existing.campaignId
      && position.campaignVersion === existing.campaignVersion
      && position.strategyId === existing.strategyId
      && position.providerCode === existing.providerCode
      && position.queryFingerprint === existing.queryFingerprint
      && position.connectionId === existing.connectionId
      && position.endpointCode === existing.endpointCode
      && position.adapterVersion === existing.adapterVersion
      && position.contractVersion === existing.contractVersion
      && position.catalogVersion === existing.catalogVersion
      && position.timeWindowMode === existing.timeWindowMode
      && position.timeWindowFrom === existing.timeWindowFrom
      && position.timeWindowTo === existing.timeWindowTo
      && position.createdAt === existing.createdAt;
    if (!immutableFieldsMatch
      || existing.status === "exhausted"
      || position.version !== existing.version + 1
      || executionTimestamp(position.updatedAt)
        < executionTimestamp(existing.updatedAt)) {
      throw new Error("获客数据源续搜位置 CAS 冲突或身份被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_strategy_source_positions
       SET status = ?, encrypted_cursor = ?, cursor_hash = ?,
           source_run_id = ?, source_shard_id = ?, source_page_id = ?,
           source_checkpoint_no = ?, source_page_sequence = ?,
           version_no = ?, updated_at = ?
       WHERE id = ? AND team_id = ? AND owner_id = ?
         AND identity_hash = ? AND version_no = ?`,
      [
        position.status,
        position.encryptedCursor,
        position.cursorHash,
        position.sourceRunId,
        position.sourceShardId,
        position.sourcePageId,
        position.sourceCheckpointNo,
        position.sourcePageSequence,
        position.version,
        mysqlDate(position.updatedAt),
        position.id,
        position.teamId,
        position.ownerId,
        position.identityHash,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("获客数据源续搜位置数据库 CAS 更新失败");
    }
  }
}

async function syncProspectExecutionThrottles(
  connection: mysql.PoolConnection,
  desired: ProspectExecutionThrottleBucket[]
) {
  const persisted =
    (await loadProspectExecutionState(connection)).throttleBuckets;
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("搜索执行限流桶存在重复主键");
  }
  for (const existing of persisted) {
    if (!desiredById.has(existing.id)) {
      throw new Error("搜索执行限流桶不允许删除");
    }
  }
  for (const throttle of desired) {
    const existing = persistedById.get(throttle.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_execution_throttles",
        [throttle],
        (item) => [
          item.id,
          item.teamId,
          item.providerCode,
          item.connectionId,
          mysqlDate(item.availableAt),
          item.version,
          mysqlDate(item.updatedAt)
        ],
        `(id,team_id,provider_code,connection_id,available_at,version_no,
          updated_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, throttle)) continue;
    if (throttle.teamId !== existing.teamId
      || throttle.providerCode !== existing.providerCode
      || throttle.connectionId !== existing.connectionId
      || throttle.version !== existing.version + 1
      || executionTimestamp(throttle.availableAt)
        < executionTimestamp(existing.availableAt)
      || executionTimestamp(throttle.updatedAt)
        < executionTimestamp(existing.updatedAt)) {
      throw new Error("搜索执行限流桶 CAS 冲突或作用域被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_execution_throttles
       SET available_at = ?, version_no = ?, updated_at = ?
       WHERE id = ? AND team_id = ? AND version_no = ?`,
      [
        mysqlDate(throttle.availableAt),
        throttle.version,
        mysqlDate(throttle.updatedAt),
        throttle.id,
        throttle.teamId,
        existing.version
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("搜索执行限流桶数据库 CAS 更新失败");
    }
  }
}

async function syncProspectSearchRunRows(
  connection: mysql.PoolConnection,
  desired: ProspectSearchRun[]
) {
  const persisted = await loadProspectSearchRuns(connection);
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("获客搜索运行存在重复主键");
  }
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  for (const run of desired) {
    const existing = persistedById.get(run.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_search_runs",
        [run],
        (item) => [
          item.id,
          item.teamId,
          item.campaignId,
          item.campaignVersion,
          item.strategyId,
          item.ownerId,
          item.status,
          item.revision,
          item.executionEpoch,
          item.operationCode,
          item.idempotencyKeyHash,
          item.requestHash,
          item.queryFingerprint,
          JSON.stringify(item.executionSnapshot),
          item.executionSnapshotHash,
          item.queueBridgeVersion,
          item.parentRunId,
          item.createdBy,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt),
          item.pausedAt ? mysqlDate(item.pausedAt) : null,
          item.cancelledAt ? mysqlDate(item.cancelledAt) : null
        ],
        `(id,team_id,campaign_id,campaign_version,strategy_id,owner_id,
          status,revision_no,execution_epoch,operation_code,idempotency_key_hash,request_hash,
          query_fingerprint,execution_snapshot_json,execution_snapshot_hash,
          queue_bridge_version,parent_run_id,created_by,created_at,updated_at,
          paused_at,cancelled_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, run)) continue;
    const immutableFieldsMatch = run.teamId === existing.teamId
      && run.campaignId === existing.campaignId
      && run.campaignVersion === existing.campaignVersion
      && run.strategyId === existing.strategyId
      && run.ownerId === existing.ownerId
      && run.operationCode === existing.operationCode
      && run.idempotencyKeyHash === existing.idempotencyKeyHash
      && run.requestHash === existing.requestHash
      && run.queryFingerprint === existing.queryFingerprint
      && isDeepStrictEqual(
        run.executionSnapshot,
        existing.executionSnapshot
      )
      && run.executionSnapshotHash === existing.executionSnapshotHash
      && run.queueBridgeVersion === existing.queueBridgeVersion
      && run.parentRunId === existing.parentRunId
      && run.createdBy === existing.createdBy
      && run.createdAt === existing.createdAt;
    if (!immutableFieldsMatch
      || run.revision !== existing.revision + 1
      || run.executionEpoch < existing.executionEpoch
      || run.executionEpoch > existing.executionEpoch + 1
      || !isValidPersistedRunTransition(existing.status, run.status)) {
      throw new Error("获客搜索运行并发版本冲突或不可变字段被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_search_runs
       SET status = ?, revision_no = ?, execution_epoch = ?, updated_at = ?,
           paused_at = ?, cancelled_at = ?
       WHERE id = ? AND team_id = ? AND revision_no = ?`,
      [
        run.status,
        run.revision,
        run.executionEpoch,
        mysqlDate(run.updatedAt),
        run.pausedAt ? mysqlDate(run.pausedAt) : null,
        run.cancelledAt ? mysqlDate(run.cancelledAt) : null,
        run.id,
        run.teamId,
        existing.revision
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("获客搜索运行数据库并发更新失败");
    }
  }
}

async function syncProspectRunShardRows(
  connection: mysql.PoolConnection,
  desired: ProspectRunShard[]
) {
  const persisted = await loadProspectRunShards(connection);
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("获客搜索运行分片存在重复主键");
  }
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  for (const shard of desired) {
    const existing = persistedById.get(shard.id);
    if (!existing) {
      await insertRows(
        connection,
        "prospect_run_shards",
        [shard],
        (item) => [
          item.id,
          item.teamId,
          item.runId,
          item.providerCode,
          item.position,
          item.status,
          item.pageLimit,
          item.resultLimit,
          item.budgetLimit === null ? null : String(item.budgetLimit),
          item.currency,
          item.adapterVersion,
          item.contractVersion,
          item.catalogVersion,
          JSON.stringify(item.capabilities),
          item.accessMode,
          item.hasCursor,
          mysqlDate(item.createdAt),
          mysqlDate(item.updatedAt)
        ],
        `(id,team_id,run_id,provider_code,position_no,status,page_limit,
          result_limit,budget_limit,currency,adapter_version,contract_version,
          catalog_version,capabilities_json,access_mode,has_cursor,created_at,
          updated_at)`
      );
      continue;
    }
    if (isDeepStrictEqual(existing, shard)) continue;
    const immutableFieldsMatch = shard.teamId === existing.teamId
      && shard.runId === existing.runId
      && shard.providerCode === existing.providerCode
      && shard.position === existing.position
      && shard.pageLimit === existing.pageLimit
      && shard.resultLimit === existing.resultLimit
      && shard.budgetLimit === existing.budgetLimit
      && shard.currency === existing.currency
      && shard.adapterVersion === existing.adapterVersion
      && shard.contractVersion === existing.contractVersion
      && shard.catalogVersion === existing.catalogVersion
      && isDeepStrictEqual(shard.capabilities, existing.capabilities)
      && shard.accessMode === existing.accessMode
      && shard.hasCursor === existing.hasCursor
      && shard.createdAt === existing.createdAt;
    if (!immutableFieldsMatch
      || !isValidPersistedShardTransition(existing.status, shard.status)) {
      throw new Error("获客搜索运行分片状态冲突或不可变字段被修改");
    }
    const [result] = await connection.query(
      `UPDATE prospect_run_shards
       SET status = ?, updated_at = ?
       WHERE id = ? AND team_id = ? AND status = ? AND updated_at = ?`,
      [
        shard.status,
        mysqlDate(shard.updatedAt),
        shard.id,
        shard.teamId,
        existing.status,
        mysqlDate(existing.updatedAt)
      ]
    );
    if (Number((result as { affectedRows?: number }).affectedRows || 0) !== 1) {
      throw new Error("获客搜索运行分片数据库并发更新失败");
    }
  }
}

async function appendProspectRunEventRows(
  connection: mysql.PoolConnection,
  desired: ProspectRunEvent[]
) {
  const persisted = await loadProspectRunEvents(connection);
  const persistedById = new Map(persisted.map((item) => [item.id, item]));
  const desiredById = new Map(desired.map((item) => [item.id, item]));
  if (desiredById.size !== desired.length) {
    throw new Error("获客搜索运行审计事件存在重复主键");
  }
  for (const event of desired) {
    const existing = persistedById.get(event.id);
    if (existing && !isDeepStrictEqual(existing, event)) {
      throw new Error("获客搜索运行审计事件不可变历史被修改");
    }
  }
  try {
    await insertRows(
      connection,
      "prospect_run_events",
      desired.filter((item) => !persistedById.has(item.id)),
      (item) => [
        item.id,
        item.teamId,
        item.runId,
        item.sequence,
        item.eventType,
        item.actorId,
        item.requestId,
        item.fromStatus,
        item.toStatus,
        item.fromRevision,
        item.toRevision,
        item.reason,
        mysqlDate(item.createdAt)
      ],
      `(id,team_id,run_id,sequence_no,event_type,actor_id,request_id,
        from_status,to_status,from_revision,to_revision,reason,created_at)`
    );
  } catch (error) {
    if (isMysqlDuplicateKeyError(error)) {
      throw new Error("获客搜索运行审计事件数据库 CAS 冲突");
    }
    throw error;
  }
}

async function appendMarketOpportunityRows(
  connection: mysql.PoolConnection,
  store: CrmStore
) {
  const persistedBatches = await loadMarketOpportunityBatches(connection);
  const persistedSnapshots = await loadMarketOpportunitySnapshots(connection);
  const persistedEvents = await loadMarketOpportunityCalculationEvents(connection);
  verifyImmutableRows(
    persistedBatches,
    store.marketOpportunityBatches,
    "市场机会事实批次"
  );
  verifyImmutableRows(
    persistedSnapshots,
    store.marketOpportunitySnapshots,
    "市场机会事实快照"
  );
  verifyImmutableRows(
    persistedEvents,
    store.marketOpportunityCalculationEvents,
    "市场机会计算事件"
  );

  const persistedBatchIds = new Set(persistedBatches.map((item) => item.id));
  const persistedSnapshotIds = new Set(persistedSnapshots.map((item) => item.id));
  const persistedEventIds = new Set(persistedEvents.map((item) => item.id));
  await insertRows(
    connection,
    "market_opportunity_batches",
    store.marketOpportunityBatches.filter((item) => !persistedBatchIds.has(item.id)),
    (item) => [
      item.id,
      item.teamId,
      item.ownerId,
      item.campaignId,
      item.providerId,
      item.datasetFingerprint,
      item.policyVersion,
      item.status,
      item.emptyReason || "",
      item.candidateCount,
      item.readyCount,
      JSON.stringify(item.comparisonPeriods),
      item.firstTriggerJobId,
      item.observationCutoffAt ? mysqlDate(item.observationCutoffAt) : null,
      mysqlDate(item.createdAt)
    ],
    "(id,team_id,owner_id,campaign_id,provider_id,dataset_fingerprint,policy_version,status,empty_reason,candidate_count,ready_count,comparison_periods_json,first_trigger_job_id,observation_cutoff_at,created_at)"
  );
  await insertRows(
    connection,
    "market_opportunity_snapshots",
    store.marketOpportunitySnapshots.filter((item) => !persistedSnapshotIds.has(item.id)),
    (item) => [
      item.id,
      item.batchId,
      item.teamId,
      item.ownerId,
      item.campaignId,
      item.providerId,
      item.reporterCountry,
      item.reporterCode,
      item.classification,
      item.commodityCode,
      item.commodityDescription || "",
      item.comparisonPeriod || "",
      item.snapshotStatus,
      JSON.stringify(item.insufficiencyReasons),
      JSON.stringify(item.metrics),
      null,
      null,
      null,
      mysqlDate(item.createdAt)
    ],
    "(id,batch_id,team_id,owner_id,campaign_id,provider_id,reporter_country,reporter_code,classification,commodity_code,commodity_description,comparison_period,snapshot_status,insufficiency_reasons_json,metrics_json,market_score,growth_score,china_supply_score,created_at)"
  );
  await insertRows(
    connection,
    "market_opportunity_calculation_events",
    store.marketOpportunityCalculationEvents.filter((item) => !persistedEventIds.has(item.id)),
    (item) => [
      item.id,
      item.teamId,
      item.ownerId,
      item.campaignId,
      item.triggerJobId,
      item.batchId,
      item.datasetFingerprint,
      item.policyVersion,
      item.outcome,
      item.reusedBatch,
      item.sequence,
      mysqlDate(item.calculatedAt)
    ],
    "(id,team_id,owner_id,campaign_id,trigger_job_id,batch_id,dataset_fingerprint,policy_version,outcome,reused_batch,sequence_no,calculated_at)"
  );
}

function mysqlDate(value?: string) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function migrateLegacyLeadSourceConfigs(store: CrmStore) {
  let migrated = 0;
  for (const legacy of store.leadSourceConfigs) {
    const exists = store.providerConnections.some((item) =>
      item.providerId === legacy.provider
      && item.ownerId === legacy.ownerId
      && item.teamId === legacy.teamId
    );
    const hasLegacyConfiguration = Boolean(legacy.apiKey || legacy.baseUrl);
    if (!exists && hasLegacyConfiguration) {
      const now = legacy.updatedAt || new Date().toISOString();
      const id = legacy.id.startsWith("ls_") ? `pc_${legacy.id.slice(3)}` : `pc_${legacy.id}`;
      const context = {
        id,
        providerId: legacy.provider,
        ownerId: legacy.ownerId,
        teamId: legacy.teamId
      };
      store.providerConnections.unshift({
        ...context,
        scope: legacy.scope,
        credentialRef: createCredentialRef(),
        configurationEncrypted: encryptProviderConfiguration(context, {
          apiKey: legacy.apiKey,
          baseUrl: legacy.baseUrl || ""
        }),
        status: legacy.enabled ? "active" : "disabled",
        quotaPolicy: {},
        budgetPolicy: {},
        lastHealthAt: legacy.lastTestAt || "",
        lastHealthStatus: legacy.lastTestStatus || "untested",
        lastErrorCode: legacy.lastTestStatus === "failed" ? "legacy_connection_test_failed" : "",
        lastHealthMessage: legacy.lastTestMessage || "",
        usage: legacy.usageJson || "",
        createdBy: legacy.ownerId,
        createdAt: now,
        updatedAt: now
      });
    }
    if (!hasLegacyConfiguration) continue;
    legacy.apiKey = "";
    legacy.baseUrl = "";
    legacy.enabled = false;
    migrated += 1;
  }
  return migrated;
}
