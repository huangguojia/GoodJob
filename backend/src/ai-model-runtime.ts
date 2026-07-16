import { createAiHttpClient } from "./ai-http-security.js";
import type { LeadQuery, RawLead } from "./provider-contract.js";
import type { AiModelConfig } from "./types.js";

export const AI_MODEL_TIMEOUT_MS = 120_000;

export async function callAiModel(
  config: AiModelConfig,
  prompt: string,
  maxInputChars = 12_000,
  fetcher?: (
    url: string,
    init?: RequestInit
  ) => Promise<globalThis.Response>
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
    AI_MODEL_TIMEOUT_MS
  );
  try {
    if (protocol === "anthropic") {
      const response = await request(`${endpointBase}/messages`, {
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
      if (!content) throw new Error("模型返回为空");
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
      if (!content) throw new Error("模型返回为空");
      return content;
    }
    const response = await request(`${endpointBase}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature ?? 0.1,
        messages: [
          {
            role: "system",
            content:
              "你擅长整理授权 API、搜索服务和用户提供的结构化资料。"
              + "不得声称访问过企业网页。"
              + "输出必须可被 JSON.parse 解析。"
          },
          {
            role: "user",
            content: prompt.slice(0, maxInputChars)
          }
        ],
        response_format: { type: "json_object" }
      })
    });
    const data = await readAiJson<{
      choices?: Array<{ message?: { content?: string } }>;
    }>(response);
    const content = data.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("模型返回为空");
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
    if (contentType.includes("text/html")
      || text.trim().startsWith("<")) {
      throw new Error(
        "接口返回 HTML 页面而不是 JSON，请检查 Base URL 是否填写为 API 地址"
      );
    }
    throw new Error("接口返回内容不是有效 JSON");
  }
  if (!response.ok) {
    throw new Error(aiHttpErrorMessage(response.status));
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
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI JSON missing");
  return JSON.parse(
    source.slice(start, end + 1)
  ) as Record<string, unknown>;
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
  const parsed = extractJsonObject(content) as { companies?: unknown };
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
