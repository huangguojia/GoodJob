import {
  AI_MODEL_TIMEOUT_MS,
  aiGenerateLeads
} from "./ai-model-runtime.js";
import {
  defineProvider,
  type LeadQuery
} from "./provider-contract.js";
import type { AiModelConfig } from "./types.js";

export function createAiSearchProvider(config: AiModelConfig) {
  const base = new URL(config.baseUrl);
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  return defineProvider({
    id: "ai_search",
    name: "AI 搜索",
    tier: "ai",
    category: "ai",
    requiresKey: false,
    capabilities: ["ai", "company"],
    docsUrl: "",
    keyHint: "",
    defaultBaseUrl: config.baseUrl,
    costNote:
      "调用当前账号已配置的 AI 模型，候选结果必须人工核实。",
    networkPolicy: {
      allowedHosts: [base.hostname.toLocaleLowerCase()],
      allowedPathPrefixes: [basePath],
      allowedMethods: ["POST"],
      timeoutMs: AI_MODEL_TIMEOUT_MS,
      maxResponseBytes: 2 * 1024 * 1024
    },
    async search({ query }, credential, tools) {
      const legacyQuery: LeadQuery = {
        goal: query.goal,
        productKeywords: query.productKeywords.join(", "),
        countries: query.countries.join(", "),
        industry: query.industries.join(", "),
        customerType: query.customerTypes.join(", "),
        excludeKeywords: query.excludeKeywords.join(", "),
        limit: query.limit
      };
      const records = await aiGenerateLeads(
        legacyQuery,
        { ...config, apiKey: credential.apiKey },
        (url, init) => tools.http.fetch(url, init)
      );
      return {
        records,
        rawCount: records.length,
        invalidCount: 0,
        nextCursor: null,
        exhausted: true,
        warnings: [
          "AI 生成候选仅属于辅助建议，进入跟进前必须核实企业身份与官网。"
        ],
        usage: {
          requestCount: 1,
          estimated: false,
          display: ""
        }
      };
    },
    async health() {
      return {
        ok: true,
        message: "AI 搜索复用当前账号已验证的模型配置"
      };
    }
  });
}
