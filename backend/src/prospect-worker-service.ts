import { randomBytes } from "node:crypto";
import { createAiSearchProvider } from "./ai-search-provider.js";
import { BullMqProspectQueueBackend } from "./prospect-bullmq-backend.js";
import { ProspectProviderDispatcher } from "./prospect-provider-dispatcher.js";
import {
  ProspectQueueCoordinator,
  type ProspectQueueCoordinatorStatus
} from "./prospect-queue-coordinator.js";
import { ProspectWorker } from "./prospect-worker.js";
import type { CrmStore } from "./store.js";

const DEVELOPMENT_CLAIM_SECRET =
  randomBytes(48).toString("base64url");

export interface ProspectWorkerServiceOptions {
  store: CrmStore;
  redisUrl?: string;
  queueRequired?: boolean;
}

export interface ProspectWorkerServiceStatus {
  running: boolean;
  queue: ProspectQueueCoordinatorStatus | {
    mode: "mysql_polling";
    running: boolean;
    degraded: false;
  };
}

function executionClaimSecret() {
  const configured =
    process.env.PROSPECT_EXECUTION_CLAIM_SECRET?.trim()
    || process.env.JWT_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "生产环境必须配置 PROSPECT_EXECUTION_CLAIM_SECRET 或 JWT_SECRET"
    );
  }
  return DEVELOPMENT_CLAIM_SECRET;
}

export class ProspectWorkerService {
  private readonly store: CrmStore;
  private readonly redisUrl: string;
  private readonly queueRequired: boolean;
  private readonly worker: ProspectWorker;
  private coordinator: ProspectQueueCoordinator | null = null;
  private running = false;

  constructor(options: ProspectWorkerServiceOptions) {
    this.store = options.store;
    this.redisUrl =
      options.redisUrl ?? process.env.REDIS_URL?.trim() ?? "";
    this.queueRequired =
      options.queueRequired
      ?? process.env.PROSPECT_QUEUE_REQUIRED === "true";
    this.worker = new ProspectWorker({
      store: this.store,
      dispatcher: new ProspectProviderDispatcher({
        store: this.store,
        resolveProvider: (request) => {
          if (request.providerCode !== "ai_search") return undefined;
          const config = this.store.aiModelConfigs
            .filter((item) =>
              item.teamId === request.teamId
              && item.ownerId === request.ownerId
              && item.enabled
              && item.useLeadFinder
              && Boolean(item.apiKey)
            )
            .sort((left, right) =>
              new Date(right.updatedAt).getTime()
              - new Date(left.updatedAt).getTime()
            )[0];
          return config
            ? {
                provider: createAiSearchProvider(config),
                credential: {
                  apiKey: config.apiKey,
                  baseUrl: config.baseUrl
                }
              }
            : undefined;
        }
      }),
      claimSecret: executionClaimSecret(),
      providerRawEnvelopeSecret:
        process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET,
      organizationIdentitySecret:
        process.env.ORGANIZATION_IDENTITY_MASTER_SECRET,
      prospectCoverageSecret:
        process.env.PROSPECT_COVERAGE_MASTER_SECRET
        || process.env.ORGANIZATION_IDENTITY_MASTER_SECRET,
      pollMs: Number(process.env.PROSPECT_WORKER_POLL_MS || 1_000),
      onStateChanged: () => this.coordinator?.synchronize()
    });
  }

  async start() {
    if (this.running) return;
    if (this.queueRequired && !this.redisUrl) {
      throw new Error(
        "PROSPECT_QUEUE_REQUIRED=true 时必须配置 REDIS_URL"
      );
    }
    await this.worker.start();
    this.running = true;
    if (!this.redisUrl) return;
    try {
      const coordinator = new ProspectQueueCoordinator({
        store: this.store,
        backend: new BullMqProspectQueueBackend({
          redisUrl: this.redisUrl,
          connectionTimeoutMs: Number(
            process.env.PROSPECT_REDIS_CONNECT_TIMEOUT_MS || 3_000
          )
        }),
        onWake: () => this.worker.wakeNow(),
        syncIntervalMs: Number(
          process.env.PROSPECT_QUEUE_SYNC_MS || 5_000
        )
      });
      await coordinator.start();
      this.coordinator = coordinator;
      console.log(
        "GoodJob CRM prospect queue coordination enabled with BullMQ"
      );
    } catch (error) {
      if (this.queueRequired) {
        this.running = false;
        await this.worker.stop();
        throw error;
      }
      console.warn(
        "GoodJob CRM Redis/BullMQ unavailable, "
        + "prospect worker continues with MySQL polling"
      );
    }
  }

  async stop() {
    if (!this.running && !this.coordinator) return;
    const coordinator = this.coordinator;
    this.coordinator = null;
    await coordinator?.stop();
    await this.worker.stop();
    this.running = false;
  }

  async synchronize() {
    await this.coordinator?.synchronize();
  }

  status(): ProspectWorkerServiceStatus {
    return {
      running: this.running,
      queue: this.coordinator?.status() || {
        mode: "mysql_polling",
        running: this.running,
        degraded: false
      }
    };
  }
}
