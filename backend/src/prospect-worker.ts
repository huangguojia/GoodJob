import { createHmac, randomUUID } from "node:crypto";
import {
  ProspectExecutionKernel,
  type ProspectExecutionProviderDispatcher
} from "./prospect-execution-kernel.js";
import {
  ProspectCandidatePipeline,
  type ProspectCandidatePipelineFilter
} from "./prospect-candidate-pipeline.js";
import type { ProspectProviderRawPolicy } from "./prospect-source-raw.js";
import type { CrmStore } from "./store.js";

export interface ProspectWorkerOptions {
  store: CrmStore;
  dispatcher: ProspectExecutionProviderDispatcher;
  claimSecret: string;
  providerRawEnvelopeSecret?: string;
  organizationIdentitySecret?: string;
  prospectCoverageSecret?: string;
  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
  deadlineMs?: number;
  onStateChanged?: () => Promise<void> | void;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : fallback;
}

export function prospectProviderRawPolicies(
  store: CrmStore
): Record<string, ProspectProviderRawPolicy> {
  return Object.fromEntries(store.providerCatalog.map((catalog) => {
    const tier = typeof catalog.licensePolicy.tier === "string"
      ? catalog.licensePolicy.tier
      : "unknown";
    const mode = typeof catalog.retentionPolicy.mode === "string"
      ? catalog.retentionPolicy.mode
      : "provider_terms";
    return [catalog.code, {
      licensePolicy: `provider_terms:${tier}`,
      retentionPolicy: `provider_terms:${mode}`,
      retentionDays: Math.min(
        3_650,
        positiveInteger(catalog.retentionPolicy.retentionDays, 365)
      )
    }];
  }));
}

export class ProspectWorker {
  private readonly store: CrmStore;
  private readonly dispatcher: ProspectExecutionProviderDispatcher;
  private readonly kernel: ProspectExecutionKernel;
  private readonly candidatePipeline: ProspectCandidatePipeline;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly onStateChanged?: () => Promise<void> | void;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(options: ProspectWorkerOptions) {
    const leaseMs = positiveInteger(options.leaseMs, 30_000);
    const providerRawEnvelopeSecret =
      options.providerRawEnvelopeSecret
      || createHmac("sha256", options.claimSecret)
        .update("goodjob-provider-raw-envelope-v1")
        .digest("hex");
    this.store = options.store;
    this.dispatcher = options.dispatcher;
    this.pollMs = Math.max(100, positiveInteger(options.pollMs, 1_000));
    this.heartbeatMs = Math.max(500, Math.trunc(leaseMs / 3));
    this.onStateChanged = options.onStateChanged;
    this.kernel = new ProspectExecutionKernel({
      store: options.store,
      workerId: options.workerId?.trim()
        || `prospect-worker-${randomUUID()}`,
      allowPersistedRuns: true,
      claimSecret: options.claimSecret,
      providerRawEnvelopeSecret,
      leaseMs,
      deadlineMs: positiveInteger(options.deadlineMs, 120_000),
      providerRawPolicies: prospectProviderRawPolicies(options.store)
    });
    this.candidatePipeline = new ProspectCandidatePipeline({
      store: options.store,
      rawEnvelopeSecret: providerRawEnvelopeSecret,
      identitySecret: options.organizationIdentitySecret
        || createHmac("sha256", options.claimSecret)
          .update("goodjob-organization-identity-development-v1")
          .digest("hex"),
      coverageSecret: options.prospectCoverageSecret
        || createHmac("sha256", options.claimSecret)
          .update("goodjob-prospect-coverage-development-v1")
          .digest("hex")
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      await this.kernel.start();
      await this.settlePendingResponses();
      await this.processCandidates();
      await this.kernel.recoverExpiredLeases();
      this.loopPromise = this.runLoop();
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  wakeNow() {
    this.wake?.();
  }

  private async sleep() {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (this.wakeTimer) clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
        this.wake = null;
        resolve();
      };
      this.wake = wake;
      this.wakeTimer = setTimeout(wake, this.pollMs);
      if (!this.running) wake();
    });
  }

  private async settlePendingResponses() {
    const pending = this.store.prospectProviderRequestLedgers
      .filter((item) => item.status === "response_received")
      .sort((left, right) =>
        left.responseReceivedAt.localeCompare(right.responseReceivedAt)
      );
    let settled = 0;
    for (const ledger of pending) {
      let responseSettled = false;
      try {
        await this.kernel.settlePersistedProviderResponse({
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          runId: ledger.runId,
          ledgerId: ledger.id,
          expectedResponseHash: ledger.responseHash
        });
        settled += 1;
        responseSettled = true;
      } catch (error) {
        this.logFailure("settlement_recovery_failed", {
          runId: ledger.runId,
          shardId: ledger.shardId,
          ledgerId: ledger.id
        }, error);
      }
      if (responseSettled) {
        await this.processCandidates({
          teamId: ledger.teamId,
          ownerId: ledger.ownerId,
          runId: ledger.runId,
          ledgerId: ledger.id
        });
      }
    }
    return settled;
  }

  private async executeOne() {
    if (await this.settlePendingResponses()) return true;
    await this.kernel.recoverExpiredLeases();
    const claim = await this.kernel.claimNext();
    if (!claim) return false;
    try {
      const prepared = await this.kernel.prepareProviderRequest({
        leaseId: claim.lease.id,
        claimToken: claim.claimToken
      });
      const heartbeat = setInterval(() => {
        void this.kernel.heartbeat({
          leaseId: claim.lease.id,
          claimToken: claim.claimToken
        }).catch(() => undefined);
      }, this.heartbeatMs);
      let response;
      try {
        response = await this.kernel.dispatchPreparedProviderRequest(
          this.dispatcher,
          {
            leaseId: claim.lease.id,
            claimToken: claim.claimToken,
            ledgerId: prepared.ledger.id
          }
        );
      } finally {
        clearInterval(heartbeat);
      }
      if (response.kind === "throttled") return true;
      await this.kernel.settlePersistedProviderResponse({
        teamId: response.ledger.teamId,
        ownerId: response.ledger.ownerId,
        runId: response.ledger.runId,
        ledgerId: response.ledger.id,
        expectedResponseHash: response.ledger.responseHash
      });
      await this.processCandidates({
        teamId: response.ledger.teamId,
        ownerId: response.ledger.ownerId,
        runId: response.ledger.runId,
        ledgerId: response.ledger.id
      });
      return true;
    } catch (error) {
      this.logFailure("execution_failed", {
        runId: claim.run.id,
        shardId: claim.shard.id,
        leaseId: claim.lease.id
      }, error);
      return true;
    }
  }

  private async runLoop() {
    while (this.running) {
      let worked = false;
      try {
        worked = await this.executeOne();
      } catch (error) {
        this.logFailure("worker_cycle_failed", {}, error);
      }
      if (worked) await this.notifyStateChanged();
      if (!worked) await this.sleep();
    }
  }

  private async notifyStateChanged() {
    try {
      await this.onStateChanged?.();
    } catch (error) {
      this.logFailure("queue_coordination_sync_failed", {}, error);
    }
  }

  private logFailure(
    event: string,
    ids: Record<string, string>,
    error: unknown
  ) {
    const code = typeof error === "object"
      && error !== null
      && "code" in error
      ? String((error as { code?: unknown }).code || "UNCLASSIFIED")
      : "UNCLASSIFIED";
    console.error("[prospect-worker]", {
      event,
      ...ids,
      code
    });
  }

  private async processCandidates(
    filter: ProspectCandidatePipelineFilter = {}
  ) {
    try {
      const result = await this.candidatePipeline.processPending(filter);
      for (const failure of result.failures) {
        this.logFailure("candidate_pipeline_failed", {
          hitId: failure.hitId,
          runId: failure.runId,
          ledgerId: failure.ledgerId
        }, { code: failure.code });
      }
      return result;
    } catch (error) {
      this.logFailure("candidate_pipeline_cycle_failed", {
        runId: filter.runId || "",
        ledgerId: filter.ledgerId || ""
      }, error);
      return null;
    }
  }
}
