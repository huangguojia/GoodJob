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
import {
  queueWebsiteProbe,
  websiteProbeAutoEnrichmentEligible
} from "./website-probe.js";
import {
  discoverProspectWebsite,
  type ProspectWebsiteDiscoverySearch
} from "./prospect-website-discovery.js";
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
  concurrency?: number;
  websiteDiscoverySearch?: ProspectWebsiteDiscoverySearch;
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
  private readonly concurrency: number;
  private readonly contactEnrichmentScanMs: number;
  private readonly onStateChanged?: () => Promise<void> | void;
  private readonly websiteDiscoverySearch?: ProspectWebsiteDiscoverySearch;
  private running = false;
  private loopPromises: Promise<void>[] = [];
  private readonly sleepers = new Set<() => void>();
  private settlementRecovery: Promise<number> | null = null;
  private contactEnrichmentScan: Promise<number> | null = null;
  private nextContactEnrichmentScanAt = 0;

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
    this.concurrency = Math.max(1, Math.min(
      8,
      positiveInteger(options.concurrency, 3)
    ));
    this.contactEnrichmentScanMs = Math.max(5_000, Math.min(
      5 * 60_000,
      positiveInteger(process.env.WEBSITE_PROBE_AUTO_SCAN_MS, 30_000)
    ));
    this.heartbeatMs = Math.max(500, Math.trunc(leaseMs / 3));
    this.onStateChanged = options.onStateChanged;
    this.websiteDiscoverySearch = options.websiteDiscoverySearch;
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
      this.loopPromises = Array.from(
        { length: this.concurrency },
        () => this.runLoop()
      );
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.wakeNow();
    await Promise.all(this.loopPromises);
    this.loopPromises = [];
  }

  wakeNow() {
    for (const wake of [...this.sleepers]) wake();
  }

  private async sleep() {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const wake = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      this.sleepers.add(wake);
      timer = setTimeout(wake, this.pollMs);
      if (!this.running) wake();
    });
  }

  private settlePendingResponsesCoordinated() {
    if (this.settlementRecovery) return this.settlementRecovery;
    const recovery = this.settlePendingResponses().finally(() => {
      if (this.settlementRecovery === recovery) {
        this.settlementRecovery = null;
      }
    });
    this.settlementRecovery = recovery;
    return recovery;
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
    if (await this.settlePendingResponsesCoordinated()) return true;
    await this.kernel.recoverExpiredLeases();
    const claim = await this.kernel.claimNext();
    if (!claim) {
      if (await this.discoverMissingWebsites({})) return true;
      return (await this.queueMissingContactEnrichmentCoordinated({})) > 0;
    }
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
      try {
        await this.kernel.settlePersistedProviderResponse({
          teamId: response.ledger.teamId,
          ownerId: response.ledger.ownerId,
          runId: response.ledger.runId,
          ledgerId: response.ledger.id,
          expectedResponseHash: response.ledger.responseHash
        });
      } catch (error) {
        await this.settlePendingResponsesCoordinated();
        const settled = this.store.prospectProviderRequestLedgers.find((item) =>
          item.id === response.ledger.id
          && item.teamId === response.ledger.teamId
          && item.ownerId === response.ledger.ownerId
          && item.runId === response.ledger.runId
          && item.status === "settled"
          && item.responseHash === response.ledger.responseHash
        );
        if (!settled) throw error;
      }
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

  async processPendingCandidates(
    filter: ProspectCandidatePipelineFilter = {}
  ) {
    return this.processCandidates(filter);
  }

  pendingCandidates(filter: ProspectCandidatePipelineFilter = {}) {
    return this.candidatePipeline.pendingCandidates(filter);
  }

  async requestCancel(runId: string) {
    return await this.kernel.requestCancel(runId);
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
      await this.discoverMissingWebsites(filter);
      await this.queueMissingContactEnrichmentCoordinated(filter);
      return result;
    } catch (error) {
      this.logFailure("candidate_pipeline_cycle_failed", {
        runId: filter.runId || "",
        ledgerId: filter.ledgerId || ""
      }, error);
      return null;
    }
  }

  private async discoverMissingWebsites(
    filter: ProspectCandidatePipelineFilter
  ) {
    if (process.env.PROSPECT_WEBSITE_DISCOVERY === "false") return 0;
    const limit = Math.max(1, Math.min(20, positiveInteger(
      process.env.PROSPECT_WEBSITE_DISCOVERY_MAX_PER_CYCLE,
      12
    )));
    const pairs = (this.store.prospectCandidateProcessingStates || [])
      .filter((state) =>
        state.status === "completed"
        && Boolean(state.candidateId)
        && this.store.prospectSearchRuns.some((run) =>
          run.id === state.runId
          && run.teamId === state.teamId
          && (
            ["queued", "running", "paused", "cancel_requested"].includes(run.status)
            || Date.now() - new Date(run.updatedAt).getTime() < 6 * 60 * 60 * 1000
          )
        )
        && (!filter.runId || state.runId === filter.runId)
        && (!filter.teamId || state.teamId === filter.teamId)
        && (!filter.ownerId || state.ownerId === filter.ownerId)
      )
      .map((state) => ({ candidateId: state.candidateId!, runId: state.runId }));
    const selectedPairs: Array<{ candidateId: string; runId: string }> = [];
    const seen = new Set<string>();
    for (const pair of pairs) {
      const key = `${pair.runId}:${pair.candidateId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = this.store.websiteOpportunities.find((item) =>
        item.id === pair.candidateId
      );
      if (!candidate) continue;
      const existingAttempt = (candidate.websiteDiscoveryAttempts || []).find((attempt) =>
        attempt.runId === pair.runId
      );
      const retryLegacyMissingProvider = Boolean(
        existingAttempt
        && existingAttempt.outcome === "provider_unavailable"
        && !existingAttempt.providerId
      );
      if (existingAttempt && !retryLegacyMissingProvider) continue;
      selectedPairs.push(pair);
      if (selectedPairs.length >= limit) break;
    }
    let completed = 0;
    for (const pair of selectedPairs) {
      const candidate = this.store.websiteOpportunities.find((item) =>
        item.id === pair.candidateId
      );
      if (!candidate) continue;
      await discoverProspectWebsite({
        candidate,
        runId: pair.runId,
        retryExisting: Boolean(
          candidate.websiteDiscoveryAttempts?.find((attempt) =>
            attempt.runId === pair.runId
            && attempt.outcome === "provider_unavailable"
            && !attempt.providerId
          )
        ),
        search: this.websiteDiscoverySearch,
        persist: async (changedCandidate) => {
          if (this.store.persistProspectCandidates) {
            await this.store.persistProspectCandidates([changedCandidate.id]);
          } else {
            await this.store.persist();
          }
        }
      });
      completed += 1;
    }
    return completed;
  }

  private async queueMissingContactEnrichment(
    filter: ProspectCandidatePipelineFilter
  ) {
    if (process.env.WEBSITE_PROBE_AUTO_ENRICH === "false") return 0;
    const limit = Math.max(1, Math.min(30, positiveInteger(
      process.env.WEBSITE_PROBE_AUTO_MAX_PER_CYCLE,
      20
    )));
    const runCandidateIds = filter.runId
      ? new Set(
          (this.store.prospectCandidateProcessingStates || [])
            .filter((state) =>
              state.runId === filter.runId
              && (!filter.teamId || state.teamId === filter.teamId)
              && (!filter.ownerId || state.ownerId === filter.ownerId)
              && state.status === "completed"
              && Boolean(state.candidateId)
            )
            .map((state) => state.candidateId!)
        )
      : null;
    if (runCandidateIds && !runCandidateIds.size) return 0;
    const eligibleCandidates = this.store.websiteOpportunities
      .filter((candidate) =>
        (!runCandidateIds || runCandidateIds.has(candidate.id))
        && (!filter.teamId || candidate.teamId === filter.teamId)
        && (!filter.ownerId || candidate.ownerId === filter.ownerId)
        && ["preview", "contactable", "contacted"].includes(candidate.status)
        && websiteProbeAutoEnrichmentEligible(candidate)
      )
      .sort((left, right) => {
        const leftAttempted = left.websiteProbeAttempts?.length ? 1 : 0;
        const rightAttempted = right.websiteProbeAttempts?.length ? 1 : 0;
        return leftAttempted - rightAttempted
          || left.createdAt.localeCompare(right.createdAt);
      });
    const selectedDomains = new Set<string>();
    const candidateIds: string[] = [];
    for (const candidate of eligibleCandidates) {
      let domain = candidate.id;
      try {
        domain = new URL(candidate.website).hostname
          .replace(/^www\./iu, "")
          .toLocaleLowerCase("en-US");
      } catch {
        // Eligibility performs the authoritative URL validation.
      }
      if (selectedDomains.has(domain)) continue;
      selectedDomains.add(domain);
      candidateIds.push(candidate.id);
      if (candidateIds.length >= limit) break;
    }
    let queued = 0;
    for (const candidateId of candidateIds) {
      try {
        // Candidate persistence may replace every in-memory object. Always
        // resolve the current object again before adding the next task.
        const candidate = this.store.websiteOpportunities.find((item) =>
          item.id === candidateId
        );
        if (!candidate || !websiteProbeAutoEnrichmentEligible(candidate)) continue;
        await queueWebsiteProbe(
          this.store,
          candidate,
          candidate.ownerId,
          async (changedCandidate) => {
            if (this.store.persistProspectCandidates) {
              await this.store.persistProspectCandidates([changedCandidate.id]);
            } else {
              await this.store.persist();
            }
          }
        );
        queued += 1;
      } catch (error) {
        this.logFailure("website_contact_enrichment_skipped", {
          candidateId,
          runId: filter.runId || ""
        }, error);
      }
    }
    return queued;
  }

  private queueMissingContactEnrichmentCoordinated(
    filter: ProspectCandidatePipelineFilter
  ) {
    if (this.contactEnrichmentScan) return this.contactEnrichmentScan;
    const now = Date.now();
    if (!filter.runId && now < this.nextContactEnrichmentScanAt) {
      return Promise.resolve(0);
    }
    if (!filter.runId) {
      this.nextContactEnrichmentScanAt = now + this.contactEnrichmentScanMs;
    }
    const scan = this.queueMissingContactEnrichment(filter).finally(() => {
      if (this.contactEnrichmentScan === scan) {
        this.contactEnrichmentScan = null;
      }
    });
    this.contactEnrichmentScan = scan;
    return scan;
  }
}
