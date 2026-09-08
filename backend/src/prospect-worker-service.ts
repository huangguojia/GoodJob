import { randomBytes } from "node:crypto";
import { createAiSearchProvider } from "./ai-search-provider.js";
import { callAiModelWithWebSearch } from "./ai-model-runtime.js";
import { getProvider } from "./lead-providers.js";
import { aiWebsiteCitationsToProviderRecords } from "./prospect-ai-website-discovery.js";
import { BullMqProspectQueueBackend } from "./prospect-bullmq-backend.js";
import { ProspectProviderDispatcher } from "./prospect-provider-dispatcher.js";
import type { ProspectCandidatePipelineFilter } from "./prospect-candidate-pipeline.js";
import {
  ProspectQueueCoordinator,
  type ProspectQueueCoordinatorStatus
} from "./prospect-queue-coordinator.js";
import { ProspectWorker } from "./prospect-worker.js";
import type { CrmStore } from "./store.js";
import {
  createProviderExecutionContext,
  executeProviderSearch
} from "./provider-runtime.js";

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
    const nativeWebSearchCooldowns = new Map<string, number>();
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
      concurrency: Number(process.env.PROSPECT_WORKER_CONCURRENCY || 3),
      websiteDiscoverySearch: async ({ candidate, runId, query }) => {
        let lastFailure: unknown;
        let lastFailedProvider = "";
        const aiConfig = this.store.aiModelConfigs
          .filter((item) =>
            item.teamId === candidate.teamId
            && item.ownerId === candidate.ownerId
            && item.enabled
            && item.useLeadFinder
            && item.protocol === "openai-compatible"
            && Boolean(item.apiKey)
          )
          .sort((left, right) =>
            new Date(right.updatedAt).getTime()
            - new Date(left.updatedAt).getTime()
          )[0];
        if (aiConfig
          && (nativeWebSearchCooldowns.get(aiConfig.id) || 0) <= Date.now()) {
          try {
            const result = await callAiModelWithWebSearch(
              aiConfig,
              [
                `Find the official website for this company: ${candidate.company}`,
                `Country or region: ${candidate.country || "unknown"}`,
                `Business: ${candidate.business || "unknown"}`,
                "Search the public web and cite the company's own official HTTPS website.",
                "Do not cite directories, social networks, marketplaces, news articles or Wikipedia.",
                "If the official website cannot be confirmed, say so and do not invent a domain."
              ].join("\n"),
              4_000,
              undefined,
              45_000
            );
            if (result.usedSearch && result.citations.length) {
              const records = aiWebsiteCitationsToProviderRecords(
                candidate,
                result.citations
              );
              if (records.length) {
                return { providerId: "openai_web_search", records };
              }
            }
          } catch (error) {
            lastFailure = error;
            lastFailedProvider = "openai_web_search";
            nativeWebSearchCooldowns.set(
              aiConfig.id,
              Date.now() + 30 * 60 * 1000
            );
          }
        }
        const preferredProviders = ["brave", "serper", "serpapi", "google_places"];
        const connections = this.store.providerConnections
          .filter((item) =>
            item.teamId === candidate.teamId
            && item.ownerId === candidate.ownerId
            && item.scope === "personal"
            && item.status === "active"
            && preferredProviders.includes(item.providerId)
          )
          .sort((left, right) =>
            preferredProviders.indexOf(left.providerId)
            - preferredProviders.indexOf(right.providerId)
          );
        let lastSuccessfulProvider = "";
        for (const connection of connections) {
          const provider = getProvider(connection.providerId);
          const catalog = this.store.providerCatalog.find((item) =>
            item.code === connection.providerId && item.status === "active"
          );
          if (!provider || !provider.search || !catalog) continue;
          try {
            const page = await executeProviderSearch({
              provider,
              catalog,
              context: createProviderExecutionContext({
                teamId: candidate.teamId,
                ownerId: candidate.ownerId,
                runId,
                providerId: provider.id,
                operation: "search",
                purpose: "prospect_official_website_discovery",
                suffix: candidate.id.slice(-12)
              }),
              connection,
              query: {
                goal: query,
                productKeywords: candidate.company,
                countries: candidate.country,
                industry: candidate.business,
                customerType: "company",
                excludeKeywords: "directory, linkedin, facebook, wikipedia",
                limit: 5
              },
              cursor: "",
              onLogs: (logs) => this.store.providerRequestLogs.unshift(...logs)
            });
            lastSuccessfulProvider = provider.id;
            if (page.records.some((record) => record.officialWebsite || record.website)) {
              return { providerId: provider.id, records: page.records };
            }
          } catch (error) {
            lastFailure = error;
            lastFailedProvider = provider.id;
          }
        }
        const wikidata = getProvider("wikidata");
        const wikidataCatalog = this.store.providerCatalog.find((item) =>
          item.code === "wikidata" && item.status === "active"
        );
        if (wikidata?.search && wikidataCatalog) {
          try {
            const page = await executeProviderSearch({
              provider: wikidata,
              catalog: wikidataCatalog,
              context: createProviderExecutionContext({
                teamId: candidate.teamId,
                ownerId: candidate.ownerId,
                runId,
                providerId: wikidata.id,
                operation: "search",
                purpose: "prospect_official_website_discovery_free_fallback",
                suffix: candidate.id.slice(-12)
              }),
              credential: { apiKey: "", baseUrl: "" },
              query: {
                goal: query,
                productKeywords: candidate.company,
                countries: candidate.country,
                industry: candidate.business,
                customerType: "company",
                excludeKeywords: "",
                limit: 5
              },
              cursor: "",
              onLogs: (logs) => this.store.providerRequestLogs.unshift(...logs)
            });
            if (page.records.some((record) => record.officialWebsite || record.website)) {
              return { providerId: wikidata.id, records: page.records };
            }
          } catch (error) {
            lastFailure ||= error;
            lastFailedProvider ||= wikidata.id;
          }
        }
        if (lastSuccessfulProvider) {
          return { providerId: lastSuccessfulProvider, records: [] };
        }
        if (lastFailure) {
          return {
            providerId: lastFailedProvider || connections[0]?.providerId || "",
            records: [],
            errorCode: "WEBSITE_SEARCH_PROVIDER_FAILED",
            errorMessage: lastFailure instanceof Error
              ? lastFailure.message.slice(0, 240)
              : "已配置的官网搜索能力均执行失败"
          };
        }
        return {
          providerId: "wikidata",
          records: [],
          errorCode: "WEBSITE_SEARCH_PROVIDER_UNAVAILABLE",
          errorMessage: "OpenAI 联网与免费 Wikidata 均未取得官网；可配置 Brave Search、Serper、SerpApi 或 Google Places 扩大覆盖"
        };
      },
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

  async processPendingCandidates(
    filter: ProspectCandidatePipelineFilter
  ) {
    if (!this.running) return null;
    const result = await this.worker.processPendingCandidates(filter);
    await this.coordinator?.synchronize();
    return result;
  }

  pendingCandidates(filter: ProspectCandidatePipelineFilter) {
    if (!this.running) return null;
    return this.worker.pendingCandidates(filter);
  }

  async requestCancel(runId: string) {
    if (!this.running) {
      throw new Error("搜客执行服务未运行，无法取消搜索任务");
    }
    return await this.worker.requestCancel(runId);
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
