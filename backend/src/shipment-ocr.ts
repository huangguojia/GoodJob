import { createAiHttpClient } from "./ai-http-security.js";
import { aiHttpErrorMessage, readAiJson } from "./ai-model-runtime.js";
import type { AiModelConfig } from "./types.js";

const AI_TIMEOUT_MS = 120_000;

function base64FromDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function contentText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => contentText(item)).filter(Boolean).join("\n");
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  return contentText(item.text) || contentText(item.value) || contentText(item.content);
}

function responseText(data: any): string {
  const choice = data?.choices?.[0];
  return (
    contentText(choice?.message?.content) ||
    contentText(choice?.delta?.content) ||
    contentText(choice?.text) ||
    contentText(data?.output_text) ||
    contentText(data?.response) ||
    ""
  );
}

const NOISE_TOKENS = new Set([
  "trackingcode", "tracking_code", "trackingnumber", "tracking_number",
  "waybill", "waybillcode", "waybill_code", "waybillnumber",
  "json", "object", "string", "null", "undefined"
]);

function extractTrackingCode(text: string): string {
  // 去掉 markdown 代码围栏（```json ... ```）后再解析
  const cleaned = (text || "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 优先解析 JSON（整体或提取第一个 {...} 片段）
  const jsonCandidates = [cleaned];
  const braceMatch = cleaned.match(/\{[^{}]*\}/);
  if (braceMatch) jsonCandidates.push(braceMatch[0]);
  for (const candidate of jsonCandidates) {
    try {
      const json = JSON.parse(candidate);
      const value = json?.trackingCode ?? json?.tracking_code ?? json?.code ?? json?.waybill;
      // JSON 解析成功即为权威结果：空值直接返回空，不再进入正则兜底
      return value == null ? "" : String(value).trim();
    } catch {
      // not JSON, try next candidate
    }
  }
  // 正则兜底：要求候选串含数字（运单号几乎必含数字），并排除字段名等噪声词
  const candidates = cleaned.match(/[A-Za-z0-9][A-Za-z0-9\-_.]{5,}/g) || [];
  const filtered = candidates
    .map((c) => c.replace(/^["']|["']$/g, ""))
    .filter((c) => c.length >= 6 && /\d/.test(c) && !NOISE_TOKENS.has(c.toLowerCase().replace(/[-_.]/g, "")));
  if (!filtered.length) return "";
  filtered.sort((a, b) => b.length - a.length);
  return filtered[0];
}

export async function recognizeTrackingCode(
  dataUrl: string,
  mime: string,
  config: AiModelConfig
): Promise<string> {
  const endpointBase = config.baseUrl.replace(/\/+$/, "");
  const client = createAiHttpClient(endpointBase);
  const protocol = config.protocol || "openai-compatible";
  const prompt =
    "这是一张快递/物流单的运单号图片。请识别其中的运单号（tracking number / waybill number）。"
    + "只返回一个 JSON 对象：{\"trackingCode\": \"<运单号>\"}，不要包含多余文字。"
    + "如果图中没有清晰的运单号，返回 {\"trackingCode\": \"\"}。";
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
      max_tokens: 500,
      temperature: 0.1,
      system: "你负责从图片中识别快递运单号，只输出 JSON。",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mime === "image/png" ? "image/png" : "image/jpeg",
              data: base64
            }
          }
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
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime || "image/jpeg", data: base64 } }
        ]
      }]
    };
  } else {
    url = `${endpointBase}/chat/completions`;
    headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
    body = {
      model: config.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你负责从图片中识别快递运单号，只输出 JSON。" },
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
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await client.fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    });
    const data = await readAiJson<any>(response);
    const text = protocol === "gemini"
      ? contentText(data?.candidates?.[0]?.content?.parts)
      : responseText(data);
    return extractTrackingCode(text);
  } catch (err) {
    const status = (err as { httpStatus?: number })?.httpStatus;
    if (status) throw new Error(aiHttpErrorMessage(status));
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
