import { createAiHttpClient } from "./ai-http-security.js";
import {
  aiHttpErrorMessage,
  extractJsonObject,
  readAiJson
} from "./ai-model-runtime.js";
import type { AiModelConfig } from "./types.js";

const OCR_TIMEOUT_MS = 120_000;

export const BUSINESS_CARD_FIELD_LIMITS = {
  company: 200,
  contact: 120,
  title: 120,
  email: 254,
  whatsapp: 60,
  wechat: 80,
  phone: 60,
  country: 80,
  city: 120
} as const;

export type BusinessCardField = keyof typeof BUSINESS_CARD_FIELD_LIMITS;

export interface BusinessCardRecognition {
  confidence: number;
  fields: Record<BusinessCardField, string>;
}

type VisionFetcher = (
  url: string,
  init?: RequestInit
) => Promise<globalThis.Response>;

function base64FromDataUrl(dataUrl: string) {
  const separator = dataUrl.indexOf(",");
  return separator >= 0 ? dataUrl.slice(separator + 1) : dataUrl;
}

function contentText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item)).filter(Boolean).join("\n");
  }
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  return contentText(item.text) || contentText(item.value) || contentText(item.content);
}

function responseText(data: unknown, protocol: string) {
  const root = data && typeof data === "object" ? data as Record<string, any> : {};
  if (protocol === "gemini") {
    return contentText(root.candidates?.[0]?.content?.parts);
  }
  const choice = root.choices?.[0];
  return contentText(choice?.message?.content)
    || contentText(choice?.delta?.content)
    || contentText(choice?.text)
    || contentText(root.output_text)
    || contentText(root.response);
}

function normalizedText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function parseBusinessCardRecognition(content: string): BusinessCardRecognition {
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(content);
  } catch {
    throw new Error("视觉模型没有返回可用的名片字段，请确认模型支持图片识别");
  }
  const rawFields = parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)
    ? parsed.fields as Record<string, unknown>
    : parsed;
  const fields = Object.fromEntries(
    Object.entries(BUSINESS_CARD_FIELD_LIMITS).map(([key, maxLength]) => [
      key,
      normalizedText(rawFields[key], maxLength)
    ])
  ) as Record<BusinessCardField, string>;
  if (!Object.values(fields).some(Boolean)) {
    throw new Error("图片中未识别到清晰的名片信息，请更换清晰、正向的名片图片");
  }
  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.round(Math.max(0, Math.min(100, rawConfidence)))
    : 0;
  return { confidence, fields };
}

export async function recognizeBusinessCard(
  dataUrl: string,
  mime: "image/png" | "image/jpeg" | "image/webp",
  config: AiModelConfig,
  fetcher?: VisionFetcher
): Promise<BusinessCardRecognition> {
  const endpointBase = config.baseUrl.replace(/\/+$/, "");
  const protocol = config.protocol || "openai-compatible";
  const client = fetcher ? null : createAiHttpClient(endpointBase);
  const request = fetcher || ((url: string, init?: RequestInit) => client!.fetch(url, init));
  const prompt = [
    "识别这张商务名片中的文字，只提取图片中明确出现的信息，不推测、不补全。",
    "只返回一个 JSON 对象，不要 Markdown 和解释。",
    "格式：{\"confidence\":0,\"fields\":{\"company\":\"\",\"contact\":\"\",\"title\":\"\",\"email\":\"\",\"whatsapp\":\"\",\"wechat\":\"\",\"phone\":\"\",\"country\":\"\",\"city\":\"\"}}。",
    "confidence 为整体识别置信度 0-100；无法确认的字段必须留空。"
  ].join("\n");
  const base64 = base64FromDataUrl(dataUrl);

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  if (protocol === "anthropic") {
    url = `${endpointBase}/messages`;
    headers = {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    };
    body = {
      model: config.model,
      max_tokens: 1_000,
      temperature: 0.1,
      system: "你负责商务名片 OCR，只输出严格 JSON。",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: mime, data: base64 } }
        ]
      }]
    };
  } else if (protocol === "gemini") {
    url = `${endpointBase}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers = { "content-type": "application/json", "x-goog-api-key": config.apiKey };
    body = {
      generationConfig: { temperature: 0.1 },
      contents: [{
        role: "user",
        parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }]
      }]
    };
  } else {
    url = `${endpointBase}/chat/completions`;
    headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
    body = {
      model: config.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你负责商务名片 OCR，只输出严格 JSON。" },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
  try {
    const response = await request(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    });
    const data = await readAiJson<unknown>(response);
    const text = responseText(data, protocol).trim();
    if (!text) throw new Error("视觉模型返回为空，请确认当前模型支持图片输入");
    return parseBusinessCardRecognition(text);
  } catch (error) {
    const status = Number((error as { httpStatus?: unknown })?.httpStatus || 0);
    if (status) throw new Error(aiHttpErrorMessage(status));
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("名片识别超时，请稍后重试或更换视觉模型");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
