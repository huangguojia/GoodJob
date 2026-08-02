import { createAiHttpClient } from "./ai-http-security.js";
import {
  ProviderContractError,
  providerHttpStatusError,
  type LeadQuery,
  type RawLead
} from "./provider-contract.js";
import type { AiModelConfig } from "./types.js";

export const AI_MODEL_TIMEOUT_MS = 120_000;

function sanitizedAiErrorText(value: unknown) {
  return String(value || "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer ****")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-****")
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=****")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 420);
}

function aiUpstreamErrorDetails(data: unknown, fallback = "") {
  const root = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : root;
  return {
    upstreamCode: sanitizedAiErrorText(
      nested.code || nested.type || nested.status || root.code || root.status
    ).slice(0, 100),
    upstreamMessage: sanitizedAiErrorText(
      nested.message || root.message || fallback
    )
  };
}

function modelEndpoint(endpointBase: string, suffix: string) {
  return endpointBase.toLocaleLowerCase("en-US").endsWith(suffix)
    ? endpointBase
    : `${endpointBase}${suffix}`;
}

function reasoningModelWithoutTemperature(model: string) {
  return /^(?:o1|o3|o4|gpt-5)(?:$|[-_.])/iu.test(model.trim());
}

function compatibilityRetryReason(error: unknown) {
  if (!(error instanceof Error)
    || !("httpStatus" in error)
    || ![400, 422].includes(Number((error as { httpStatus?: unknown }).httpStatus))) {
    return false;
  }
  const detail = "upstreamMessage" in error
    ? String((error as { upstreamMessage?: unknown }).upstreamMessage || "")
    : error.message;
  return /(temperature|system.{0,20}role|role.{0,20}system|unsupported.{0,30}(parameter|field)|unknown.{0,20}(parameter|field))/iu.test(detail);
}

function aiResponseInvalid(message: string) {
  return new ProviderContractError({
    code: "AI_MODEL_RESPONSE_INVALID",
    retryable: false,
    retryAfterAt: null,
    publicMessage: message,
    httpStatus: 200,
    phase: "search"
  });
}

export async function callAiModel(
  config: AiModelConfig,
  prompt: string,
  maxInputChars = 12_000,
  fetcher?: (
    url: string,
    init?: RequestInit
  ) => Promise<globalThis.Response>,
  timeoutMs = AI_MODEL_TIMEOUT_MS
) {
  const protocol = config.protocol || "openai-compatible";
  const endpointBase = config.baseUrl.replace(/\/+$/, "");
  const secureClient = fetcher ? null : createAiHttpClient(endpointBase);
  const request = fetcher
    || ((url: string, init?: RequestInit) =>
      secureClient!.fetch(url, init));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1_000, Math.min(AI_MODEL_TIMEOUT_MS, timeoutMs))
  );
  try {
    if (protocol === "anthropic") {
      const response = await request(modelEndpoint(endpointBase, "/messages"), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 800,
          temperature: config.temperature ?? 0.1,
          system:
            "你擅长整理授权 API、搜索服务和用户提供的结构化资料。"
            + "不得声称访问过企业网页，输出必须可被 JSON.parse 解析。",
          messages: [{
            role: "user",
            content: prompt.slice(0, maxInputChars)
          }]
        })
      });
      const data = await readAiJson<{
        content?: Array<{ type?: string; text?: string }>;
      }>(response);
      const content = data.content
        ?.map((item) => item.text || "")
        .join("\n")
        .trim() || "";
      if (!content) throw aiResponseInvalid("AI 模型返回为空，请检查模型是否支持当前对话协议");
      return content;
    }
    if (protocol === "gemini") {
      const endpoint =
        `${endpointBase}/models/${encodeURIComponent(config.model)}:generateContent`;
      const response = await request(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey
        },
        body: JSON.stringify({
          generationConfig: {
            temperature: config.temperature ?? 0.1
          },
          contents: [{
            role: "user",
            parts: [{
              text:
                "你擅长整理授权 API、搜索服务和用户提供的结构化资料。"
                + "不得声称访问过企业网页。"
                + "输出必须可被 JSON.parse 解析。\n"
                + prompt.slice(0, maxInputChars)
            }]
          }]
        })
      });
      const data = await readAiJson<{
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      }>(response);
      const content = data.candidates?.[0]?.content?.parts
        ?.map((item) => item.text || "")
        .join("\n")
        .trim() || "";
      if (!content) throw aiResponseInvalid("AI 模型返回为空，请检查 Gemini 协议和模型名称");
      return content;
    }
    const systemPrompt =
      "你擅长整理授权 API、搜索服务和用户提供的结构化资料。"
      + "不得声称访问过企业网页。"
      + "输出必须可被 JSON.parse 解析。";
    const endpoint = modelEndpoint(endpointBase, "/chat/completions");
    type CompatibleContentPart = { text?: string; value?: string; content?: unknown };
    type CompatibleToolCall = { function?: { arguments?: string } };
    type CompatibleMessage = {
      content?: string | CompatibleContentPart[] | CompatibleContentPart;
      reasoning_content?: string | CompatibleContentPart[];
      reasoning?: string | CompatibleContentPart[];
      analysis?: string | CompatibleContentPart[];
      tool_calls?: CompatibleToolCall[];
      refusal?: string;
    };
    type CompatibleCompletion = {
      choices?: Array<{
        message?: CompatibleMessage;
        delta?: CompatibleMessage;
        text?: string;
        finish_reason?: string;
      }>;
      output_text?: string;
      response?: string | CompatibleContentPart[] | CompatibleContentPart;
    };
    const contentText = (value: unknown): string => {
      if (Array.isArray(value)) return value.map((item) => contentText(item)).filter(Boolean).join("\n");
      if (typeof value === "string") return value;
      if (!value || typeof value !== "object") return "";
      const item = value as Record<string, unknown>;
      return contentText(item.text) || contentText(item.value) || contentText(item.content);
    };
    const completionText = (data: CompatibleCompletion) => {
      const choice = data.choices?.[0];
      const primary = contentText(choice?.message?.content)
        || contentText(choice?.delta?.content)
        || contentText(choice?.text)
        || contentText(data.output_text)
        || contentText(data.response)
        || contentText(choice?.message?.tool_calls?.[0]?.function?.arguments);
      if (primary.trim()) return primary;
      const reasoning = contentText(choice?.message?.reasoning_content)
        || contentText(choice?.message?.reasoning)
        || contentText(choice?.message?.analysis)
        || contentText(choice?.delta?.reasoning_content)
        || contentText(choice?.delta?.reasoning)
        || contentText(choice?.delta?.analysis);
      return reasoning.includes("{") && reasoning.includes("}") ? reasoning : "";
    };
    const requestCompletion = async (compatibilityMode: boolean, repairMode = false) => {
      const userPrompt = repairMode
        ? `上一次响应以 finish_reason=stop 结束但没有可用内容。请重新完成任务，只输出一个完整 JSON 对象，不要只输出思考过程，也不要留空。\n${prompt.slice(0, maxInputChars)}`
        : prompt.slice(0, maxInputChars);
      const body: Record<string, unknown> = {
        model: config.model,
        messages: compatibilityMode
          ? [{ role: "user", content: `${systemPrompt}\n${userPrompt}` }]
          : [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
      };
      if (!compatibilityMode && !reasoningModelWithoutTemperature(config.model)) {
        body.temperature = config.temperature ?? 0.1;
      }
      const response = await request(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
      return readAiJson<CompatibleCompletion>(response);
    };
    let data: CompatibleCompletion;
    try {
      data = await requestCompletion(false);
    } catch (error) {
      if (!compatibilityRetryReason(error)) throw error;
      data = await requestCompletion(true);
    }
    let content = completionText(data);
    if (!content.trim()) {
      data = await requestCompletion(true, true);
      content = completionText(data);
    }
    if (!content.trim()) {
      const finishReason = String(data.choices?.[0]?.finish_reason || "unknown");
      const refusal = String(data.choices?.[0]?.message?.refusal || "").trim();
      const fields = Object.keys(data.choices?.[0]?.message || {}).slice(0, 8).join(",") || "none";
      throw aiResponseInvalid(`AI 模型在一次修复重试后仍未返回可用内容（finish_reason=${finishReason}，message_fields=${fields}${refusal ? `，refusal=${refusal.slice(0, 120)}` : ""}）；运行时将改用确定性证据和基础执行继续处理`);
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export function aiHttpErrorMessage(status: number) {
  if ([401, 403].includes(status)) {
    return "模型认证失败，请检查 API Key 和账号权限";
  }
  if (status === 404) {
    return "模型接口或模型名称不存在，请检查 Base URL 和 Model";
  }
  if (status === 429) {
    return "模型请求过于频繁或额度不足，请稍后重试并检查配额";
  }
  if (status >= 500) return "模型服务暂时不可用，请稍后重试";
  if (status >= 400) {
    return "模型请求参数不被接受，请检查协议、模型名称和配置";
  }
  return `模型接口返回 HTTP ${status}`;
}

export async function readAiJson<T>(
  response: globalThis.Response
): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) {
      throw providerHttpStatusError(response, "AI 模型", aiUpstreamErrorDetails(
        null,
        contentType.includes("text/html") || text.trim().startsWith("<")
          ? "接口返回 HTML 页面而不是 JSON，Base URL 可能不是模型 API 地址"
          : `接口返回非 JSON 错误正文：${text}`
      ));
    }
    if (contentType.includes("text/html")
      || text.trim().startsWith("<")) {
      throw aiResponseInvalid(
        "接口返回 HTML 页面而不是 JSON，请检查 Base URL 是否填写为 API 地址"
      );
    }
    throw aiResponseInvalid("AI 模型返回内容不是有效 JSON，请检查协议与模型兼容性");
  }
  if (!response.ok) {
    throw providerHttpStatusError(
      response,
      "AI 模型",
      aiUpstreamErrorDetails(data)
    );
  }
  return data as T;
}

export function extractJsonObject(content: string) {
  const source = content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          return JSON.parse(source.slice(start, index + 1)) as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("AI JSON missing or invalid");
}

export async function aiGenerateLeads(
  query: LeadQuery,
  config: AiModelConfig,
  fetcher?: (
    url: string,
    init?: RequestInit
  ) => Promise<globalThis.Response>
): Promise<RawLead[]> {
  const count = Math.min(query.limit, 12);
  const prompt = [
    "你是资深外贸获客研究助手。根据客户画像列出真实、可能存在的目标公司。",
    "严格只返回 JSON，不要解释、不要 Markdown。",
    "JSON 结构：{\"companies\":[{\"company\":\"\",\"website\":\"\",\"country\":\"\",\"business\":\"\",\"description\":\"\"}]}",
    "只给有把握真实存在的公司；官网不确定就留空，禁止编造域名、邮箱、电话或联系人。",
    `目标公司数量：${count}`,
    `产品/关键词：${query.productKeywords || "未指定"}`,
    `国家/地区：${query.countries || "未指定"}`,
    `行业/场景：${query.industry || "未指定"}`,
    `客户类型：${query.customerType || "未指定"}`,
    `获客目标：${query.goal || "未指定"}`,
    `排除：${query.excludeKeywords || "无"}`
  ].join("\n");
  const content = await callAiModel(config, prompt, 4_000, fetcher);
  let parsed: { companies?: unknown };
  try {
    parsed = extractJsonObject(content) as { companies?: unknown };
  } catch {
    throw aiResponseInvalid("AI 模型已响应，但未返回可解析的公司 JSON，请检查模型能力或更换模型");
  }
  const companies = Array.isArray(parsed.companies)
    ? parsed.companies
    : [];
  return companies
    .slice(0, count)
    .map((raw): RawLead => {
      const item = (raw || {}) as Record<string, unknown>;
      const firstCountry =
        query.countries.split(/,|，/)[0]?.trim() || "未知";
      const detail = String(item.description || "").trim();
      const officialWebsite = String(item.website || "").trim();
      return {
        company: String(item.company || "").trim(),
        officialWebsite,
        website: officialWebsite,
        country: String(item.country || firstCountry).trim(),
        business: String(
          item.business
          || query.productKeywords
          || "待核实业务"
        ).trim(),
        contact: "待维护",
        contactInfo: "",
        description: detail
          ? `${detail}（AI 生成，待核实）`
          : "AI 生成候选，待核实。",
        confidence: 58,
        sourceUrl: "",
        recordType: "assisted_suggestion",
        evidenceSummary:
          `${detail || "AI 生成候选"}；尚未完成外部事实核验。`,
        matchedFields: [
          "company",
          ...(officialWebsite ? ["officialWebsite"] : []),
          "country",
          "business"
        ]
      };
    })
    .filter((lead) => lead.company);
}
