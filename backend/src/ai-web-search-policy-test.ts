import assert from "node:assert/strict";
import {
  aiLeadFinderReadiness,
  aiWebSearchPolicy,
  isOpenAiModelConfig,
  webSearchFailureSuggestion
} from "./ai-web-search-policy.js";
import type { AiModelConfig } from "./types.js";

function config(overrides: Partial<AiModelConfig> = {}): AiModelConfig {
  return {
    id: "policy-test",
    provider: "custom",
    protocol: "openai-compatible",
    name: "Policy test",
    baseUrl: "https://api.example.test/v1",
    model: "gpt-5.5",
    apiKey: "test-key",
    enabled: true,
    temperature: 0.1,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: false,
    ownerId: "owner",
    teamId: "team",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides
  };
}

assert.equal(isOpenAiModelConfig(config()), true);
assert.equal(isOpenAiModelConfig(config({ provider: "compatible", model: "custom-chat-model" })), false);
assert.equal(isOpenAiModelConfig(config({ provider: "anthropic", protocol: "anthropic", model: "claude-3" })), false);
assert.equal(isOpenAiModelConfig(config({ provider: "custom", model: "o3-mini" })), true);

const untested = aiWebSearchPolicy(config());
assert.equal(untested.supported, true);
assert.equal(untested.ready, false);
assert.equal(untested.reasonCode, "AI_WEB_SEARCH_NOT_TESTED");

const passed = aiWebSearchPolicy(config({ webSearchStatus: "passed" }));
assert.equal(passed.ready, true);
assert.equal(passed.reasonCode, "AI_WEB_SEARCH_READY");

const unsupported = aiWebSearchPolicy(config({ model: "deepseek-chat" }));
assert.equal(unsupported.status, "unsupported");
assert.equal(unsupported.ready, false);
assert.match(webSearchFailureSuggestion(unsupported), /Brave/u);

const missingKey = aiWebSearchPolicy(config({ apiKey: "" }));
assert.equal(missingKey.reasonCode, "AI_WEB_SEARCH_API_KEY_MISSING");

const ordinaryWithFallback = aiLeadFinderReadiness(
  config({ model: "deepseek-chat", lastTestStatus: "passed", webSearchStatus: "unsupported" }),
  true
);
assert.equal(ordinaryWithFallback.ready, true);
assert.equal(ordinaryWithFallback.mode, "external_website_api");
const ordinaryWithoutFallback = aiLeadFinderReadiness(
  config({ model: "deepseek-chat", lastTestStatus: "passed", webSearchStatus: "unsupported" }),
  false
);
assert.equal(ordinaryWithoutFallback.ready, false);

console.log(JSON.stringify({ ok: true, openAiDetection: true, statusGate: true, unsupportedModelFallback: true }));
