import type { AiModelConfig } from "./types.js";
import type { ProviderErrorCode } from "./provider-contract.js";

export type AiWebSearchStatus = "untested" | "passed" | "failed" | "unsupported";

export interface AiWebSearchPolicy {
  status: AiWebSearchStatus;
  supported: boolean;
  ready: boolean;
  reasonCode: ProviderErrorCode;
  message: string;
}

export interface AiLeadFinderReadiness {
  ready: boolean;
  mode: "native_web_search" | "external_website_api" | "blocked";
  reasonCode: ProviderErrorCode;
  message: string;
}

const OPENAI_MODEL_PATTERN = /^(?:gpt(?:-[a-z0-9.]+)*|o[134](?:-[a-z0-9.]+)*|chatgpt(?:-[a-z0-9.]+)*)$/iu;

export function isOpenAiModelConfig(config: Pick<AiModelConfig, "provider" | "protocol" | "model">) {
  if (config.protocol !== "openai-compatible") return false;
  const provider = String(config.provider || "").trim().toLocaleLowerCase("en-US");
  const model = String(config.model || "").trim().toLocaleLowerCase("en-US");
  return provider === "openai" || OPENAI_MODEL_PATTERN.test(model);
}

export function aiWebSearchPolicy(config: Pick<AiModelConfig, "provider" | "protocol" | "model" | "apiKey" | "webSearchStatus">): AiWebSearchPolicy {
  if (!isOpenAiModelConfig(config)) {
    return {
      status: "unsupported",
      supported: false,
      ready: false,
      reasonCode: "AI_WEB_SEARCH_UNSUPPORTED_MODEL",
      message: "当前模型只支持普通 AI 处理，不支持本系统的 OpenAI Web Search 官网核验。"
    };
  }
  if (!config.apiKey) {
    return {
      status: config.webSearchStatus || "untested",
      supported: true,
      ready: false,
      reasonCode: "AI_WEB_SEARCH_API_KEY_MISSING",
      message: "OpenAI Web Search 尚未测试：请先配置 API Key。"
    };
  }
  const status = config.webSearchStatus || "untested";
  if (status === "passed") {
    return {
      status,
      supported: true,
      ready: true,
      reasonCode: "AI_WEB_SEARCH_READY",
      message: "OpenAI Web Search 已验证，可用于官网发现。"
    };
  }
  if (status === "failed") {
    return {
      status,
      supported: true,
      ready: false,
      reasonCode: "AI_WEB_SEARCH_TEST_FAILED",
      message: "普通 AI 调用可用，但 Web Search 测试失败，系统不会采信模型猜测的官网。"
    };
  }
  return {
    status: "untested",
    supported: true,
    ready: false,
    reasonCode: "AI_WEB_SEARCH_NOT_TESTED",
    message: "当前模型可能支持 Web Search，但尚未完成真实联网测试，不能用于确认官网。"
  };
}

export function webSearchFailureSuggestion(policy: AiWebSearchPolicy) {
  if (policy.reasonCode === "AI_WEB_SEARCH_UNSUPPORTED_MODEL") {
    return "请在 AI 配置中更换 OpenAI 模型，或配置 Brave、Serper、SerpApi、Google Places 等官网搜索来源。";
  }
  if (policy.reasonCode === "AI_WEB_SEARCH_API_KEY_MISSING") {
    return "请填写 API Key 后点击“测试连接”；系统不会在页面明文显示密钥。";
  }
  if (policy.reasonCode === "AI_WEB_SEARCH_TEST_FAILED") {
    return "请检查 Base URL、模型权限和 Responses API Web Search 支持，修复后重新测试。";
  }
  return "请在 AI 配置中点击“测试连接”，测试通过后再启动自动搜客。";
}

export function aiLeadFinderReadiness(
  config: Pick<AiModelConfig,
    "provider" | "protocol" | "model" | "apiKey" | "enabled" | "useLeadFinder"
    | "lastTestStatus" | "webSearchStatus">,
  externalWebsiteSearchReady: boolean
): AiLeadFinderReadiness {
  if (!config.enabled || !config.apiKey || !config.useLeadFinder) {
    return {
      ready: false,
      mode: "blocked",
      reasonCode: "PROVIDER_CONNECTION_INVALID",
      message: "请先保存 API Key、启用模型并勾选自动获客。"
    };
  }
  const policy = aiWebSearchPolicy(config);
  if (policy.ready) {
    return {
      ready: true,
      mode: "native_web_search",
      reasonCode: "AI_WEB_SEARCH_READY",
      message: "OpenAI Web Search 已验证，官网将从联网引用中确认。"
    };
  }
  if (!policy.supported && config.lastTestStatus === "passed") {
    if (externalWebsiteSearchReady) {
      return {
        ready: true,
        mode: "external_website_api",
        reasonCode: "AI_WEB_SEARCH_UNSUPPORTED_MODEL",
        message: "普通 AI 负责生成企业候选，官网由已配置的搜索 API 补查；模型猜测的网址不会保存。"
      };
    }
    return {
      ready: false,
      mode: "blocked",
      reasonCode: "AI_WEB_SEARCH_UNSUPPORTED_MODEL",
      message: "当前模型可以生成企业候选，但不能联网确认官网。请配置 Brave、Serper、SerpApi 或 Google Places。"
    };
  }
  return {
    ready: false,
    mode: "blocked",
    reasonCode: policy.reasonCode,
    message: `${policy.message}${webSearchFailureSuggestion(policy)}`
  };
}
