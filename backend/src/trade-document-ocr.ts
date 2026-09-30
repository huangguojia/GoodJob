import { createAiHttpClient } from "./ai-http-security.js";
import { aiHttpErrorMessage, extractJsonObject, readAiJson } from "./ai-model-runtime.js";
import type { AiModelConfig, TradeDocument, TradeDocumentImportEvidence, TradeDocumentImportDraft, TradeDocumentItem } from "./types.js";
import { parseTradeDocumentText, type ParsedTradeDocumentSource } from "./trade-document-import.js";
import { createProviderHttpClient } from "./provider-http-client.js";

const OCR_TIMEOUT_MS = 120_000;
const MAX_TEXT = 4_000;
const SUPPORTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const BAIDU_OCR_HOST = "aip.baidubce.com";

export type TradeDocumentOcrProvider = "none" | "baidu" | "siliconflow";

export interface TradeDocumentOcrProviderConfig {
  provider: TradeDocumentOcrProvider;
  enabled: boolean;
  apiKey: string;
  secretKey: string;
  model: string;
  baseUrl: string;
}

type VisionFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function isTradeDocumentOcrMime(value: string): value is "image/png" | "image/jpeg" | "image/webp" {
  return SUPPORTED_MIME.has(value);
}

function dataUrlBase64(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1).replace(/\s+/gu, "") : "";
}

function cleanText(value: unknown, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/[,\s]/gu, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function dateValue(value: unknown) {
  const text = cleanText(value, 40);
  const match = text.match(/\b(20\d{2}|19\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/u);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return "";
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
}

function confidenceValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

function responseText(data: unknown, protocol: string) {
  const root = data && typeof data === "object" ? data as Record<string, any> : {};
  if (protocol === "gemini") {
    return (root.candidates?.[0]?.content?.parts || []).map((part: any) => String(part?.text || "")).filter(Boolean).join("\n");
  }
  const choice = root.choices?.[0];
  const content = choice?.message?.content;
  if (Array.isArray(content)) return content.map((part: any) => String(part?.text || part?.content || "")).filter(Boolean).join("\n");
  return String(content || choice?.text || root.output_text || root.response || "");
}

function baiduHttpClient() {
  return createProviderHttpClient({
    allowedHosts: [BAIDU_OCR_HOST],
    allowedPathPrefixes: ["/oauth/2.0/token", "/rest/2.0/ocr/v1/general_basic"],
    allowedMethods: ["POST"],
    timeoutMs: 30_000,
    maxResponseBytes: 2 * 1024 * 1024
  });
}

async function recognizeWithBaidu(dataUrl: string, config: TradeDocumentOcrProviderConfig) {
  if (!config.apiKey || !config.secretKey) throw new Error("百度 OCR 需要同时填写 API Key 和 Secret Key");
  const http = baiduHttpClient();
  const tokenUrl = `https://${BAIDU_OCR_HOST}/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(config.apiKey)}&client_secret=${encodeURIComponent(config.secretKey)}`;
  const tokenResponse = await http.fetch(tokenUrl, { method: "POST" });
  const tokenBody = await readAiJson<Record<string, unknown>>(tokenResponse);
  const accessToken = typeof tokenBody.access_token === "string" ? tokenBody.access_token : "";
  if (!accessToken) throw new Error(typeof tokenBody.error_description === "string" ? `百度 OCR 授权失败：${tokenBody.error_description}` : "百度 OCR 未返回 access_token");
  const image = dataUrlBase64(dataUrl);
  const form = new URLSearchParams({ image, access_token: accessToken });
  const ocrResponse = await http.fetch(`https://${BAIDU_OCR_HOST}/rest/2.0/ocr/v1/general_basic`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });
  const ocrBody = await readAiJson<Record<string, unknown>>(ocrResponse);
  const words = Array.isArray(ocrBody.words_result)
    ? ocrBody.words_result.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).words || "") : "").filter(Boolean)
    : [];
  if (!words.length) throw new Error(typeof ocrBody.error_msg === "string" ? `百度 OCR 未识别到文字：${ocrBody.error_msg}` : "百度 OCR 未识别到文字");
  return words.join("\n");
}

function hasUsableStructure(parsed: ParsedTradeDocumentSource) {
  return Boolean(parsed.draft.seller && parsed.draft.buyer && parsed.draft.items.length);
}

export async function recognizeConfiguredTradeDocument(input: {
  dataUrl: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  fileName: string;
  provider: TradeDocumentOcrProviderConfig;
  aiConfig: AiModelConfig | null;
}) {
  const { dataUrl, mime, fileName, provider, aiConfig } = input;
  if (!provider.enabled || provider.provider === "none") {
    if (!aiConfig?.enabled || !aiConfig.apiKey || !aiConfig.baseUrl || !aiConfig.model) throw new Error("未配置可用的 AI 视觉模型，请先在 AI 配置中启用支持图片识别的模型");
    const parsed = await recognizeTradeDocument(dataUrl, mime, fileName, aiConfig);
    parsed.warnings.unshift("识别来源：当前 AI 视觉模型（未配置外部 OCR）");
    return parsed;
  }
  if (provider.provider === "siliconflow") {
    if (!provider.apiKey) throw new Error("硅基流动 OCR 需要填写 API Key");
    const parsed = await recognizeTradeDocument(dataUrl, mime, fileName, {
      ...(aiConfig || {}),
      id: "ocr_siliconflow",
      provider: "siliconflow",
      protocol: "openai-compatible",
      name: "硅基流动视觉 OCR",
      baseUrl: provider.baseUrl || "https://api.siliconflow.cn/v1",
      model: provider.model || "Qwen/Qwen2.5-VL-32B-Instruct",
      apiKey: provider.apiKey,
      enabled: true
    } as AiModelConfig);
    parsed.warnings.unshift(`识别来源：硅基流动视觉模型「${provider.model || "Qwen/Qwen2.5-VL-32B-Instruct"}」`);
    return parsed;
  }
  try {
    const text = await recognizeWithBaidu(dataUrl, provider);
    const parsed = parseTradeDocumentText(text, fileName);
    parsed.warnings.unshift("识别来源：百度 OCR 文字识别");
    if (hasUsableStructure(parsed) || !aiConfig?.enabled || !aiConfig.apiKey || !aiConfig.baseUrl || !aiConfig.model) return parsed;
    try {
      const enriched = await recognizeTradeDocument(dataUrl, mime, fileName, aiConfig);
      enriched.warnings.unshift("百度 OCR 结构不足，已自动切换当前 AI 视觉模型复核");
      return enriched;
    } catch (fallbackError) {
      parsed.warnings.push(`AI 视觉复核失败：${fallbackError instanceof Error ? fallbackError.message : "未知错误"}`);
      return parsed;
    }
  } catch (providerError) {
    if (!aiConfig?.enabled || !aiConfig.apiKey || !aiConfig.baseUrl || !aiConfig.model) {
      throw new Error(`百度 OCR 调用失败：${providerError instanceof Error ? providerError.message : "未知错误"}；且未配置 AI 视觉模型兜底`);
    }
    const parsed = await recognizeTradeDocument(dataUrl, mime, fileName, aiConfig);
    parsed.warnings.unshift(`百度 OCR 不可用，已自动回落 AI 视觉模型：${providerError instanceof Error ? providerError.message : "未知错误"}`);
    return parsed;
  }
}

function documentType(value: unknown): TradeDocument["type"] {
  const normalized = cleanText(value, 40).toUpperCase();
  if (["PI", "CI", "CUSTOMS", "PL", "CONTRACT", "QUOTATION", "COO", "SHIPPING"].includes(normalized)) return normalized as TradeDocument["type"];
  if (/报价|quotation|quote/iu.test(normalized)) return "QUOTATION";
  if (/装箱|packing/iu.test(normalized)) return "PL";
  if (/商业发票|commercial/iu.test(normalized)) return "CI";
  if (/报关|customs/iu.test(normalized)) return "CUSTOMS";
  return "PI";
}

function fieldConfidence(raw: Record<string, unknown>, field: string, value: string) {
  const confidence = raw.fieldConfidence && typeof raw.fieldConfidence === "object"
    ? (raw.fieldConfidence as Record<string, unknown>)[field]
    : undefined;
  return confidenceValue(confidence, value ? 0.72 : 0);
}

function normalizeItem(raw: unknown, index: number, warnings: string[], evidence: TradeDocumentImportEvidence[], rawConfidence: Record<string, unknown>) {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const product = cleanText(source.product || source.name || source.description, 500);
  const model = cleanText(source.model || source.modelNo, 200);
  const quantity = numberValue(source.quantity ?? source.qty);
  const amount = numberValue(source.amount ?? source.lineTotal ?? source.total);
  let unitPrice = numberValue(source.unitPrice ?? source.price);
  if (!unitPrice && amount > 0 && quantity > 0) {
    unitPrice = amount / quantity;
    warnings.push(`第 ${index + 1} 条明细的单价由金额和数量计算得出，请核对原图`);
  }
  const item: TradeDocumentItem = {
    id: `ocr_item_${index + 1}`,
    product,
    model,
    material: cleanText(source.material, 200),
    finish: cleanText(source.finish || source.surfaceFinish, 200),
    hsCode: cleanText(source.hsCode || source.hs_code, 40),
    quantity,
    unit: cleanText(source.unit || source.uom, 40) || "PCS",
    unitPrice,
    originCountry: cleanText(source.originCountry || source.origin, 80),
    weightKg: numberValue(source.weightKg ?? source.weight),
    packageCount: Math.round(numberValue(source.packageCount ?? source.packages ?? source.cartons))
  };
  if (product) evidence.push({ field: `items.${index}.product`, value: product, source: "视觉模型识别", confidence: confidenceValue(rawConfidence[`items.${index}.product`], product ? 0.7 : 0) });
  else warnings.push(`第 ${index + 1} 条明细未识别到品名，请人工补充`);
  if (!quantity) warnings.push(`第 ${index + 1} 条明细未识别到数量，请核对原图`);
  if (unitPrice === 0) warnings.push(`第 ${index + 1} 条明细未识别到单价，请核对原图`);
  return item;
}

function normalizeRecognition(content: string, fileName: string, config: AiModelConfig): ParsedTradeDocumentSource {
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(content);
  } catch {
    throw new Error("视觉模型没有返回可用的单据字段，请确认当前模型支持图片识别并只返回 JSON");
  }
  const raw = parsed.document && typeof parsed.document === "object" ? parsed.document as Record<string, unknown> : parsed;
  const warnings = ["AI 视觉识别结果仅作为单据草稿，确认前请逐项核对原图"]; 
  const evidence: TradeDocumentImportEvidence[] = [];
  const textFields: Array<[keyof TradeDocumentImportDraft, string, number]> = [
    ["number", "number", 80], ["buyer", "buyer", 200], ["buyerAddress", "buyerAddress", 4_000], ["buyerContact", "buyerContact", 200],
    ["seller", "seller", 200], ["sellerAddress", "sellerAddress", 4_000], ["currency", "currency", 12], ["incoterm", "incoterm", 80],
    ["paymentTerm", "paymentTerm", 255], ["shippingMethod", "shippingMethod", 120], ["portLoading", "portLoading", 120], ["portDischarge", "portDischarge", 120],
    ["bankInfo", "bankInfo", 8_000], ["notes", "notes", 8_000]
  ];
  const values = new Map<string, string>();
  for (const [field, key, max] of textFields) {
    const value = cleanText(raw[key], max);
    values.set(field, value);
    if (value) evidence.push({ field, value, source: "视觉模型识别", confidence: fieldConfidence(parsed, key, value) });
    else if (["number", "buyer", "seller"].includes(field)) warnings.push(`未识别到${field === "number" ? "单据编号" : field === "buyer" ? "买方公司" : "卖方公司"}，请人工核对`);
  }
  const issueDate = dateValue(raw.issueDate);
  const validityDate = dateValue(raw.validityDate);
  if (issueDate) evidence.push({ field: "issueDate", value: issueDate, source: "视觉模型识别", confidence: fieldConfidence(parsed, "issueDate", issueDate) });
  else warnings.push("未识别到签发日期，请人工补充");
  if (validityDate) evidence.push({ field: "validityDate", value: validityDate, source: "视觉模型识别", confidence: fieldConfidence(parsed, "validityDate", validityDate) });
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const rawFieldConfidence = parsed.fieldConfidence && typeof parsed.fieldConfidence === "object" ? parsed.fieldConfidence as Record<string, unknown> : {};
  const items = rawItems.slice(0, 80).map((item, index) => normalizeItem(item, index, warnings, evidence, rawFieldConfidence));
  if (rawItems.length > 80) warnings.push("明细超过 80 条，仅保留前 80 条，请按原图补充其余明细");
  if (!items.length) warnings.push("未识别到商品明细，请人工补充至少一条明细");
  const detectedType = documentType(raw.type || parsed.detectedType);
  const title = cleanText(raw.title, 255) || `${detectedType} · OCR 导入`;
  const declaredRaw = parsed.declaredTotal ?? raw.totalAmount ?? raw.grandTotal ?? raw.total;
  const declaredTotal = declaredRaw === undefined || declaredRaw === null || declaredRaw === "" ? undefined : numberValue(declaredRaw);
  const calculatedTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  if (declaredTotal !== undefined && Math.abs(declaredTotal - calculatedTotal) > 0.02) warnings.push(`明细计算金额与识别总金额相差 ${Math.abs(declaredTotal - calculatedTotal).toFixed(2)}，请重点核对`);
  const draft: TradeDocumentImportDraft = {
    customerId: "",
    dealId: "",
    type: detectedType,
    title,
    number: values.get("number") || `OCR-${new Date().toISOString().slice(0, 10).replace(/-/gu, "")}`,
    issueDate,
    buyer: values.get("buyer") || "",
    buyerAddress: values.get("buyerAddress") || "",
    buyerContact: values.get("buyerContact") || "",
    seller: values.get("seller") || "",
    sellerAddress: values.get("sellerAddress") || "",
    currency: values.get("currency") || "USD",
    incoterm: values.get("incoterm") || "",
    paymentTerm: values.get("paymentTerm") || "",
    shippingMethod: values.get("shippingMethod") || "",
    portLoading: values.get("portLoading") || "",
    portDischarge: values.get("portDischarge") || "",
    validityDate,
    bankInfo: values.get("bankInfo") || "",
    notes: values.get("notes") || "",
    language: /[\u4e00-\u9fff]/u.test(content) ? "ZH" : "EN",
    templateStyle: "rose",
    items
  };
  const meaningful = [draft.number, draft.buyer, draft.seller, draft.issueDate, draft.currency, ...items.map((item) => item.product)].filter(Boolean).length;
  const confidence = confidenceValue(parsed.confidence, Math.min(0.95, 0.3 + Math.min(0.7, meaningful / 12)));
  return {
    draft,
    evidence,
    warnings,
    preview: [
      `识别文件：${fileName}`,
      `识别类型：${detectedType}`,
      draft.number ? `单据编号：${draft.number}` : "单据编号：未识别",
      ...items.slice(0, 20).map((item, index) => `明细 ${index + 1}：${item.product || "未识别品名"} · ${item.quantity} ${item.unit} · ${item.unitPrice}`)
    ],
    confidence,
    declaredTotal,
    calculatedTotal
  };
}

export async function recognizeTradeDocument(
  dataUrl: string,
  mime: "image/png" | "image/jpeg" | "image/webp",
  fileName: string,
  config: AiModelConfig,
  fetcher?: VisionFetcher
): Promise<ParsedTradeDocumentSource> {
  if (!isTradeDocumentOcrMime(mime)) throw new Error("仅支持 PNG、JPG/JPEG 或 WEBP 图片");
  const base64 = dataUrlBase64(dataUrl);
  if (!base64) throw new Error("图片内容为空，请重新选择文件");
  const endpointBase = config.baseUrl.replace(/\/+$/u, "");
  const protocol = config.protocol || "openai-compatible";
  const client = fetcher ? null : createAiHttpClient(endpointBase);
  const request = fetcher || ((url: string, init?: RequestInit) => client!.fetch(url, init));
  const prompt = [
    "你是外贸单据 OCR 审核助手。识别图片中明确出现的单据内容，只提取看得清的文字，不猜测、不补全、不根据常识制造官网、公司、金额或联系方式。",
    "必须只返回严格 JSON，不要 Markdown、不要解释。无法确认的字段返回空字符串，无法确认的数字返回 0。",
    "JSON 格式：{\"confidence\":0,\"fieldConfidence\":{},\"document\":{\"type\":\"PI\",\"title\":\"\",\"number\":\"\",\"issueDate\":\"YYYY-MM-DD\",\"validityDate\":\"YYYY-MM-DD\",\"buyer\":\"\",\"buyerAddress\":\"\",\"buyerContact\":\"\",\"seller\":\"\",\"sellerAddress\":\"\",\"currency\":\"\",\"incoterm\":\"\",\"paymentTerm\":\"\",\"shippingMethod\":\"\",\"portLoading\":\"\",\"portDischarge\":\"\",\"bankInfo\":\"\",\"notes\":\"\",\"totalAmount\":0,\"items\":[{\"product\":\"\",\"model\":\"\",\"material\":\"\",\"finish\":\"\",\"hsCode\":\"\",\"quantity\":0,\"unit\":\"PCS\",\"unitPrice\":0,\"amount\":0,\"originCountry\":\"\",\"weightKg\":0,\"packageCount\":0}]}}",
    "type 只能是 PI、CI、PL、CONTRACT、QUOTATION、COO、SHIPPING、CUSTOMS；confidence 和 fieldConfidence 使用 0-100。产品明细要逐行识别，material 和 finish 有内容才填写。"
  ].join("\n");
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  if (protocol === "anthropic") {
    url = `${endpointBase}/messages`;
    headers = { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    body = { model: config.model, max_tokens: 4_000, temperature: 0.1, system: "你负责外贸单据 OCR，只输出严格 JSON。", messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image", source: { type: "base64", media_type: mime, data: base64 } }] }] };
  } else if (protocol === "gemini") {
    url = `${endpointBase}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers = { "content-type": "application/json", "x-goog-api-key": config.apiKey };
    body = { generationConfig: { temperature: 0.1 }, contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }] }] };
  } else {
    url = `${endpointBase}/chat/completions`;
    headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
    body = { model: config.model, temperature: 0.1, messages: [{ role: "system", content: "你负责外贸单据 OCR，只输出严格 JSON。" }, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }] };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
  try {
    const response = await request(url, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
    const data = await readAiJson<unknown>(response);
    const text = responseText(data, protocol).trim();
    if (!text) throw new Error("视觉模型返回为空，请确认当前模型支持图片输入");
    return normalizeRecognition(text, fileName, config);
  } catch (error) {
    const status = Number((error as { httpStatus?: unknown })?.httpStatus || 0);
    if (status) throw new Error(aiHttpErrorMessage(status));
    if (error instanceof Error && error.name === "AbortError") throw new Error("单据 OCR 识别超时，请检查模型响应速度或更换视觉模型");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
