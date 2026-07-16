import { randomUUID } from "node:crypto";
import { getProvider } from "./lead-providers.js";
import {
  providerErrorFromUnknown,
  type LeadProvider,
  type LeadQuery,
  type ProviderCredential,
  type ProviderPage
} from "./provider-contract.js";
import {
  prospectProviderResponseComponentHashes,
  prospectProviderResponseHash
} from "./prospect-provider-request-ledger.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  prospectProviderRawArtifactHash,
  type ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import {
  executeProviderSearch
} from "./provider-runtime.js";
import type {
  ProspectExecutionProviderDispatcher
} from "./prospect-execution-kernel.js";
import type {
  FakeProspectProviderDispatchRequest,
  FakeProspectProviderRequest,
  FakeProspectProviderResponse,
  FakeProspectProviderStep
} from "./prospect-fake-provider.js";
import type { CrmStore } from "./store.js";

export interface ProspectProviderResolution {
  provider: LeadProvider;
  credential?: ProviderCredential;
}

export interface ProspectProviderDispatcherOptions {
  store: CrmStore;
  resolveProvider?: (
    request: FakeProspectProviderDispatchRequest
  ) => ProspectProviderResolution | undefined;
}

function joined(values: readonly string[]) {
  return values.map((item) => item.trim()).filter(Boolean).join(", ");
}

function validHttpStatus(value: number | null, fallback: number) {
  return Number.isInteger(value) && value! >= 100 && value! <= 599
    ? value!
    : fallback;
}

function responseFromStep(
  request: FakeProspectProviderDispatchRequest,
  step: FakeProspectProviderStep,
  httpStatus: number
): FakeProspectProviderResponse {
  const externalRequestId = `provider_${request.providerCode}_${randomUUID()}`;
  const hashes = prospectProviderResponseComponentHashes(step);
  return {
    step,
    externalRequestId,
    httpStatus,
    rawResponseHash: hashes.rawResponseHash,
    normalizedResultHash: hashes.normalizedResultHash,
    accountingEvidenceHash: hashes.accountingEvidenceHash,
    responseHash: prospectProviderResponseHash({
      contractVersion: request.contractVersion,
      requestHash: request.requestHash,
      idempotencyKey: request.idempotencyKey,
      providerCode: request.providerCode,
      connectionId: request.connectionId,
      endpointCode: request.endpointCode,
      externalRequestId,
      httpStatus,
      rawResponseHash: hashes.rawResponseHash,
      normalizedResultHash: hashes.normalizedResultHash,
      accountingEvidenceHash: hashes.accountingEvidenceHash
    }),
    replayed: false
  };
}

function sourceUrl(
  provider: LeadProvider,
  catalogDocsUrl: string,
  catalogBaseUrl: string,
  record: ProviderPage["records"][number]
) {
  return record.sourceUrl
    || record.officialWebsite
    || catalogDocsUrl
    || catalogBaseUrl
    || provider.docsUrl
    || provider.defaultBaseUrl
    || `https://example.invalid/providers/${encodeURIComponent(provider.id)}`;
}

function jsonPayload(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function successStep(
  provider: LeadProvider,
  catalogDocsUrl: string,
  catalogBaseUrl: string,
  page: ProviderPage
): FakeProspectProviderStep {
  const sourceRecords: ProspectProviderSourceRecordInput[] =
    page.records.map((record) => ({
      providerRecordId: record.providerRecordId || record.payloadHash,
      sourceUrl: sourceUrl(
        provider,
        catalogDocsUrl,
        catalogBaseUrl,
        record
      ),
      fetchedAt: record.fetchedAt,
      payload: jsonPayload(record)
    }));
  const amount = page.usage.costAmount;
  const currency = amount === null
    ? ""
    : (page.usage.currency || "USD").trim().toUpperCase();
  return {
    kind: "success",
    acceptedCount: sourceRecords.length,
    rawCount: sourceRecords.length,
    invalidCount: 0,
    duplicateCount: 0,
    hasMore: Boolean(page.nextCursor) && !page.exhausted,
    cursor: page.nextCursor || "",
    partial: page.status === "partial_success"
      || page.invalidCount > 0
      || page.duplicateCount > 0
      || page.warnings.length > 0,
    usage: {
      requestUnits: Math.max(0, page.usage.requestCount ?? 1),
      resultUnits: sourceRecords.length
    },
    cost: {
      kind: amount === null
        ? "unknown"
        : page.usage.estimated ? "estimated" : "actual",
      amount,
      currency
    },
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords
  };
}

export class ProspectProviderDispatcher
implements ProspectExecutionProviderDispatcher {
  private readonly store: CrmStore;
  private readonly resolveProvider?: ProspectProviderDispatcherOptions[
    "resolveProvider"
  ];

  constructor(options: ProspectProviderDispatcherOptions) {
    this.store = options.store;
    this.resolveProvider = options.resolveProvider;
  }

  async dispatch(
    request: FakeProspectProviderDispatchRequest,
    providerRequest?: FakeProspectProviderRequest
  ): Promise<FakeProspectProviderResponse> {
    try {
      const run = this.store.prospectSearchRuns.find((item) =>
        item.id === request.runId
        && item.teamId === request.teamId
        && item.ownerId === request.ownerId
      );
      const shard = this.store.prospectRunShards.find((item) =>
        item.id === request.shardId
        && item.runId === request.runId
        && item.teamId === request.teamId
        && item.providerCode === request.providerCode
      );
      const catalog = this.store.providerCatalog.find((item) =>
        item.code === request.providerCode
      );
      const resolved: ProspectProviderResolution | undefined =
        this.resolveProvider?.(request)
        || (() => {
          const provider = getProvider(request.providerCode);
          return provider ? { provider } : undefined;
        })();
      if (!run || !shard || !catalog || !resolved) {
        throw new Error("Provider 运行、分片、目录或适配器不存在");
      }
      if (providerRequest
        && (providerRequest.runId !== run.id
          || providerRequest.shardId !== shard.id
          || providerRequest.providerCode !== shard.providerCode
          || providerRequest.requestHash !== request.requestHash)) {
        throw new Error("Provider 请求与执行分片不一致");
      }
      if (catalog.status !== "active"
        || catalog.version !== shard.catalogVersion
        || resolved.provider.adapterVersion !== shard.adapterVersion
        || resolved.provider.contractVersion !== shard.contractVersion
        || request.adapterVersion !== shard.adapterVersion
        || request.contractVersion !== shard.contractVersion) {
        throw new Error("Provider 目录、适配器或合同版本与运行快照不一致");
      }
      const connection = request.connectionId.startsWith("builtin:")
        ? undefined
        : this.store.providerConnections.find((item) =>
            item.id === request.connectionId
            && item.providerId === request.providerCode
            && item.teamId === request.teamId
            && item.ownerId === request.ownerId
            && item.scope === "personal"
            && item.status === "active"
          );
      if (!request.connectionId.startsWith("builtin:") && !connection) {
        throw new Error("Provider 连接不存在、未启用或不属于当前业务员");
      }
      const querySnapshot = run.executionSnapshot.resolvedQuery;
      const checkpoint = this.store.prospectExecutionCheckpoints.find(
        (item) =>
          item.teamId === run.teamId
          && item.ownerId === run.ownerId
          && item.runId === run.id
          && item.shardId === shard.id
      );
      const remaining = Math.max(
        1,
        shard.resultLimit - (checkpoint?.acceptedCount || 0)
      );
      const query: LeadQuery = {
        goal: [
          run.executionSnapshot.campaign.name,
          joined(querySnapshot.purchaseScenarioTerms)
        ].filter(Boolean).join("；"),
        productKeywords: joined([
          ...querySnapshot.positiveKeywords,
          ...querySnapshot.synonyms
        ]),
        countries: joined(querySnapshot.countries),
        industry: joined(querySnapshot.industryTerms),
        customerType: joined(querySnapshot.customerTypes),
        excludeKeywords: joined(querySnapshot.exclusionKeywords),
        limit: Math.min(30, remaining)
      };
      const page = await executeProviderSearch({
        provider: resolved.provider,
        catalog,
        context: {
          teamId: request.teamId,
          ownerId: request.ownerId,
          runId: request.runId,
          runShardId: request.shardId,
          requestId: request.idempotencyKey,
          purpose: "prospect_background_search",
          operation: "search"
        },
        connection,
        credential: resolved.credential
          || (connection ? undefined : { apiKey: "", baseUrl: "" }),
        query,
        cursor: providerRequest?.cursor || "",
        onLogs: (logs) => this.store.providerRequestLogs.unshift(...logs)
      });
      return responseFromStep(
        request,
        successStep(
          resolved.provider,
          catalog.officialDocsUrl,
          catalog.baseUrl,
          page
        ),
        200
      );
    } catch (error) {
      const failure = providerErrorFromUnknown(error, "search");
      return responseFromStep(request, {
        kind: "failure",
        errorCode: failure.code,
        errorMessage: failure.publicMessage,
        retryable: failure.retryable,
        retryAfterAt: failure.retryAfterAt || "",
        usage: {
          requestUnits: 1,
          resultUnits: 0
        },
        cost: {
          kind: "unknown",
          amount: null,
          currency: ""
        }
      }, validHttpStatus(
        failure.httpStatus,
        failure.retryable ? 503 : 400
      ));
    }
  }
}
