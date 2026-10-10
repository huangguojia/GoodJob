/**
 * 「新增客户资料识别」的结果解析与归因。
 *
 * 为什么单独成模块（2026-10-10 实测事故）：
 *   用户上传了一份 .xls 形式发票，CLI 因为读不了二进制文件，回了一个**完全合法**的
 *   JSON（字段全空、confidence 0、warnings 里写明「该文件是二进制 .xls，Read 无法解析，
 *   需人工用表格软件核对」）。旧实现只用「有没有解析出字段」当成功判据，于是把这种情况
 *   判成 parseError，界面上显示「CLI 返回的内容不是可解析的 JSON」。
 *   用户看到的结论和真实原因完全相反，还会误以为是模型输出格式的问题。
 *
 * 所以这里把四种终态严格分开：解析出字段 / 解析成功但零字段 / 真的解析不出 JSON /
 * 什么都没返回。每种给不同的、指向真实原因的说明。
 */
import { extractJsonObject } from "./ai-model-runtime.js";

/** 回填字段白名单与长度上限：一律按「新增客户」表单能接受的形状裁剪 */
export const CUSTOMER_INTAKE_FIELD_LIMITS: Record<string, number> = {
  company: 120,
  companyFullName: 200,
  contact: 80,
  country: 60,
  phone: 60,
  email: 160,
  whatsapp: 24,
  wechat: 100,
  website: 200,
  source: 120,
  billingAddress: 300,
  contactRemark: 500,
  otherNotes: 2000,
  defaultPortDischarge: 80,
  defaultIncoterm: 40,
  defaultPaymentTerm: 120
};

/**
 * 归因结果：
 * - `ok`        解析出至少一个可回填字段
 * - `empty`     JSON 合法，但一个字段都没抽到（多半是文件本身读不出内容，如二进制表格）
 * - `unparsable` 有返回内容，但拿不到 JSON 对象
 * - `no_output` 任务结束了却什么都没返回
 */
export type CustomerIntakeOutcome = "ok" | "empty" | "unparsable" | "no_output";

export interface CustomerIntakeParseResult {
  outcome: CustomerIntakeOutcome;
  /** 抽到至少一个可回填字段（等价于 outcome === "ok"）；调用方不必自己推 */
  usable: boolean;
  fields: Record<string, string>;
  warnings: string[];
  summary: string;
  confidence: number;
  /** 仅 `unparsable` / `no_output` 时非空 */
  parseError: string;
  /** 仅 `empty` 时非空：如实说明「解析成功但没抽到字段」 */
  emptyReason: string;
  /** 原始返回片段（排查用，已压平空白并截断） */
  rawPreview: string;
}

/** 未知字段一律丢弃、超长截断、不合法的联系方式丢弃 */
export function normalizeCustomerIntakeFields(raw: unknown) {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const nested = source.fields && typeof source.fields === "object" && !Array.isArray(source.fields)
    ? source.fields as Record<string, unknown>
    : source;
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [key, limit] of Object.entries(CUSTOMER_INTAKE_FIELD_LIMITS)) {
    const value = nested[key];
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/gu, " ").trim().slice(0, limit);
    if (text) fields[key] = text;
  }
  if (fields.whatsapp) {
    const cleaned = fields.whatsapp.replace(/[\s()\-.]/gu, "");
    if (/^\+[1-9]\d{6,14}$/u.test(cleaned)) fields.whatsapp = cleaned;
    else {
      warnings.push(`WhatsApp 号码「${fields.whatsapp}」不含有效国家码，已忽略`);
      delete fields.whatsapp;
    }
  }
  if (Array.isArray(source.warnings)) {
    source.warnings
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .slice(0, 5)
      .forEach((item) => warnings.push(item.trim().slice(0, 200)));
  }
  const summary = typeof source.summary === "string" ? source.summary.trim().slice(0, 200) : "";
  const confidence = typeof source.confidence === "number" && Number.isFinite(source.confidence)
    ? Math.max(0, Math.min(1, source.confidence))
    : 0;
  return { fields, warnings, summary, confidence };
}

export function customerIntakeRawPreview(resultText: string) {
  return resultText.replace(/\s+/gu, " ").trim().slice(0, 240);
}

export function parseCustomerIntakeResult(input: {
  resultText: string;
  status: string;
  outputTruncated?: boolean;
}): CustomerIntakeParseResult {
  const resultText = (input.resultText || "").trim();
  const empty: CustomerIntakeParseResult = {
    outcome: "no_output",
    usable: false,
    fields: {},
    warnings: [],
    summary: "",
    confidence: 0,
    parseError: "",
    emptyReason: "",
    rawPreview: ""
  };

  if (!resultText) {
    // 任务成功却没返回内容，和「任务失败」是两回事，分别给话术
    const failed = ["failed", "cancelled"].includes(input.status);
    return {
      ...empty,
      outcome: "no_output",
      parseError: failed
        ? ""
        : "CLI 没有返回任何内容，请重新识别或直接手工填写"
    };
  }

  const rawPreview = customerIntakeRawPreview(resultText);
  let parsed: ReturnType<typeof normalizeCustomerIntakeFields> | null = null;
  try {
    parsed = normalizeCustomerIntakeFields(extractJsonObject(resultText));
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      ...empty,
      outcome: "unparsable",
      rawPreview,
      parseError: input.outputTruncated
        ? "CLI 的返回内容太长被截断，没能拿到完整 JSON；请减少文件数量或改用更小的资料后重试"
        : "CLI 返回的内容不是可解析的 JSON，请重新识别或直接手工填写"
    };
  }

  if (!Object.keys(parsed.fields).length) {
    // JSON 是合法的——只是资料里没有可回填的字段（常见于二进制表格、纯图片、空白模板）。
    // 这里必须说清楚，否则用户会一直以为是模型输出格式坏了。
    return {
      outcome: "empty",
      usable: false,
      fields: {},
      warnings: parsed.warnings,
      summary: parsed.summary,
      confidence: parsed.confidence,
      parseError: "",
      emptyReason: "识别已完成，但没有从这份资料里抽到可回填的客户字段（如公司名、联系人、邮箱、电话）",
      rawPreview
    };
  }

  return {
    outcome: "ok",
    usable: true,
    fields: parsed.fields,
    warnings: parsed.warnings,
    summary: parsed.summary,
    confidence: parsed.confidence,
    parseError: "",
    emptyReason: "",
    rawPreview
  };
}
