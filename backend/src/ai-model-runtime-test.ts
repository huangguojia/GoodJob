import assert from "node:assert/strict";
import {
  aiGenerateLeads,
  callAiModel,
  extractJsonObject,
  readAiJson
} from "./ai-model-runtime.js";
import {
  AI_SEARCH_ADAPTER_VERSION,
  createAiSearchProvider
} from "./ai-search-provider.js";
import {
  ProviderHttpStatusError,
  providerErrorFromUnknown
} from "./provider-contract.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { executeProviderSearch } from "./provider-runtime.js";
import { providerSnapshotVersionsMatch } from "./prospect-provider-dispatcher.js";
import type { AiModelConfig, ProviderCatalogItem } from "./types.js";

assert.deepEqual(
  extractJsonObject('{"done":true,"steps":[]}\n补充说明：任务规划完成。'),
  { done: true, steps: [] }
);
assert.deepEqual(
  extractJsonObject('计划如下：{"summary":"包含 { 花括号 } 的文本","steps":[]}。额外示例：{"ignored":true}'),
  { summary: "包含 { 花括号 } 的文本", steps: [] }
);
assert.deepEqual(
  extractJsonObject('```json\n{"done":false}\n```'),
  { done: false }
);

function config(overrides: Partial<AiModelConfig> = {}): AiModelConfig {
  return {
    id: "ai_runtime_test",
    provider: "compatible",
    protocol: "openai-compatible",
    name: "Test model",
    baseUrl: "https://model.example/v1/chat/completions",
    model: "custom-chat-model",
    apiKey: "test-only-key",
    enabled: true,
    temperature: 0.1,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: false,
    ownerId: "owner_test",
    teamId: "team_test",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides
  };
}

const rejected = new Response(JSON.stringify({
  error: {
    code: "unsupported_parameter",
    message: "Unsupported parameter temperature; token=sk-secretvalue123"
  }
}), {
  status: 400,
  headers: { "content-type": "application/json" }
});
let rejectedError: unknown;
try {
  await readAiJson(rejected);
} catch (error) {
  rejectedError = error;
}
assert.ok(rejectedError instanceof ProviderHttpStatusError);
assert.equal(rejectedError.upstreamCode, "unsupported_parameter");
assert.match(rejectedError.upstreamMessage, /temperature/u);
assert.equal(rejectedError.upstreamMessage.includes("sk-secretvalue123"), false);
const normalized = providerErrorFromUnknown(rejectedError, "search");
assert.equal(normalized.code, "AI_MODEL_REQUEST_REJECTED");
assert.equal(normalized.httpStatus, 400);
assert.match(normalized.publicMessage, /unsupported_parameter.*temperature/u);

const requestBodies: Array<Record<string, unknown>> = [];
const requestUrls: string[] = [];
const adaptiveContent = await callAiModel(
  config(),
  "return json",
  4_000,
  async (url, init) => {
    requestUrls.push(url);
    requestBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: "unsupported_parameter",
          message: "temperature is not supported by this model"
        }
      }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"companies\":[]}" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
);
assert.equal(adaptiveContent, "{\"companies\":[]}");
assert.equal(requestBodies.length, 2);
assert.equal("temperature" in requestBodies[0]!, true);
assert.equal("temperature" in requestBodies[1]!, false);
assert.deepEqual(requestUrls, [
  "https://model.example/v1/chat/completions",
  "https://model.example/v1/chat/completions"
]);

let emptyContentCalls = 0;
const recoveredEmptyContent = await callAiModel(
  config(),
  "return evaluation json",
  4_000,
  async () => {
    emptyContentCalls += 1;
    return new Response(JSON.stringify({
      choices: [{
        message: { content: emptyContentCalls === 1 ? "" : "{\"done\":true}" },
        finish_reason: "stop"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
);
assert.equal(emptyContentCalls, 2);
assert.equal(recoveredEmptyContent, "{\"done\":true}");

let repairedEmptyContentCalls = 0;
const repairedEmptyContent = await callAiModel(
  config(),
  "return evaluation json",
  4_000,
  async (_url, init) => {
    repairedEmptyContentCalls += 1;
    const body = JSON.parse(String(init?.body || "{}")) as { messages?: Array<{ content?: string }> };
    const repairRequested = body.messages?.some((item) => String(item.content || "").includes("上一次响应以 finish_reason=stop 结束"));
    return new Response(JSON.stringify({
      choices: [{
        message: { content: repairRequested ? "{\"done\":true}" : "" },
        finish_reason: "stop"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
);
assert.equal(repairedEmptyContentCalls, 2);
assert.equal(repairedEmptyContent, "{\"done\":true}");

const toolArgumentsContent = await callAiModel(
  config(),
  "return evaluation json",
  4_000,
  async () => new Response(JSON.stringify({
    choices: [{ message: { content: "", tool_calls: [{ function: { arguments: "{\"done\":true}" } }] }, finish_reason: "tool_calls" }]
  }), { status: 200, headers: { "content-type": "application/json" } })
);
assert.equal(toolArgumentsContent, "{\"done\":true}");

const reasoningJsonContent = await callAiModel(
  config(),
  "return evaluation json",
  4_000,
  async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "", reasoning_content: "analysis\n{\"done\":true}" },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } })
);
assert.match(reasoningJsonContent, /\{"done":true\}/u);

const reasoningBodies: Array<Record<string, unknown>> = [];
await callAiModel(
  config({
    baseUrl: "https://model.example/v1",
    model: "gpt-5-mini"
  }),
  "return json",
  4_000,
  async (url, init) => {
    assert.equal(url, "https://model.example/v1/chat/completions");
    reasoningBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: [{ text: "{\"ok\":true}" }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
);
assert.equal(reasoningBodies.length, 1);
assert.equal("temperature" in reasoningBodies[0]!, false);

const runtimeProvider = createAiSearchProvider(config());
assert.equal(runtimeProvider.adapterVersion, AI_SEARCH_ADAPTER_VERSION);
assert.equal(runtimeProvider.contractVersion, "1.0");
assert.equal(providerSnapshotVersionsMatch({
  providerCode: "ai_search",
  runtimeAdapterVersion: runtimeProvider.adapterVersion,
  runtimeContractVersion: runtimeProvider.contractVersion,
  snapshotAdapterVersion: AI_SEARCH_ADAPTER_VERSION,
  snapshotContractVersion: "search_run_control_plane_v1"
}), true);
assert.equal(providerSnapshotVersionsMatch({
  providerCode: "other_provider",
  runtimeAdapterVersion: runtimeProvider.adapterVersion,
  runtimeContractVersion: runtimeProvider.contractVersion,
  snapshotAdapterVersion: AI_SEARCH_ADAPTER_VERSION,
  snapshotContractVersion: "search_run_control_plane_v1"
}), false);
const runtimeCatalog: ProviderCatalogItem = {
  id: "provider_ai_search_test",
  code: "ai_search",
  name: "AI 搜索",
  category: "ai",
  sourceLevel: "assisted",
  accessMode: "api",
  baseUrl: "https://model.example/v1/chat/completions",
  officialDocsUrl: "",
  capabilities: ["ai", "company"],
  allowedFields: [
    "company",
    "officialWebsite",
    "country",
    "business",
    "description"
  ],
  licensePolicy: { requiresKey: false },
  defaultRatePolicy: {},
  retentionPolicy: { mode: "none" },
  status: "active",
  version: "ai-runtime-test-v1",
  reviewedAt: "2026-07-22T00:00:00.000Z",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z"
};
setProviderHttpTestTransport(async () => new Response(JSON.stringify({
  error: {
    code: "model_not_found",
    message: "The configured model does not exist or is unavailable"
  }
}), { status: 400, headers: { "content-type": "application/json" } }));
try {
  await assert.rejects(
    executeProviderSearch({
      provider: runtimeProvider,
      catalog: runtimeCatalog,
      context: {
        teamId: "team_test",
        ownerId: "owner_test",
        runId: "run_test",
        runShardId: "shard_test",
        requestId: "request_test",
        purpose: "ai_runtime_failure_test",
        operation: "search"
      },
      credential: {
        apiKey: "test-only-key",
        baseUrl: "https://model.example/v1/chat/completions"
      },
      query: {
        goal: "find distributors",
        productKeywords: "pump",
        countries: "Germany",
        industry: "water treatment",
        customerType: "distributor",
        excludeKeywords: "",
        limit: 5
      },
      onLogs: () => undefined
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && (error as { code?: unknown }).code === "AI_MODEL_REQUEST_REJECTED"
      && error.message.includes("model_not_found")
      && error.message.includes("configured model does not exist")
  );
} finally {
  setProviderHttpTestTransport(null);
}

await assert.rejects(
  aiGenerateLeads({
    goal: "find distributors",
    productKeywords: "pump",
    countries: "Germany",
    industry: "water treatment",
    customerType: "distributor",
    excludeKeywords: "",
    limit: 5
  }, config(), async () => new Response(JSON.stringify({
    choices: [{ message: { content: "I cannot return JSON" } }]
  }), { status: 200, headers: { "content-type": "application/json" } })),
  (error: unknown) => error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "AI_MODEL_RESPONSE_INVALID"
);

await assert.rejects(
  readAiJson(new Response("<html>Bad gateway</html>", {
    status: 400,
    headers: { "content-type": "text/html" }
  })),
  (error: unknown) => {
    const mapped = providerErrorFromUnknown(error, "search");
    return mapped.code === "AI_MODEL_REQUEST_REJECTED"
      && mapped.httpStatus === 400
      && mapped.publicMessage.includes("HTML")
      && mapped.publicMessage.includes("Base URL");
  }
);

await assert.rejects(
  readAiJson(new Response("<html>Sign in</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  })),
  (error: unknown) => error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "AI_MODEL_RESPONSE_INVALID"
    && error.message.includes("HTML")
);

console.log(JSON.stringify({
  ok: true,
  actualReasonPreserved: true,
  sensitiveDetailRedacted: true,
  compatibilityRetry: true,
  reasoningModelCompatibility: true,
  fullEndpointCompatibility: true,
  providerRuntimeReasonPreserved: true,
  invalidModelResponseClassified: true,
  htmlProxyResponseClassified: true
}, null, 2));
