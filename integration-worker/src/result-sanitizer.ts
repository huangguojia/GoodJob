import type { CallToolResult } from "@modelcontextprotocol/client";

export interface SanitizedToolResult {
  value: Record<string, unknown>;
  summary: Record<string, unknown>;
  evidence: Record<string, unknown>;
  externalReceipt: string;
  injectionDetected: boolean;
}

const injectionPatterns = [
  /ignore (?:all|any|previous) instructions/iu,
  /system prompt/iu,
  /developer message/iu,
  /忽略(?:此前|之前|以上|所有)指令/u,
  /你现在是/u
];

function sanitizeText(value: string, state: { injectionDetected: boolean }) {
  const withoutMarkup = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "[removed-script]")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/giu, "[removed-iframe]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, 64_000);
  if (injectionPatterns.some((pattern) => pattern.test(withoutMarkup))) state.injectionDetected = true;
  return withoutMarkup;
}

function sanitizeValue(value: unknown, depth: number, state: { nodes: number; injectionDetected: boolean }): unknown {
  state.nodes += 1;
  if (state.nodes > 2_000) throw new Error("INTEGRATION_RESULT_TOO_LARGE: 返回节点数量超过限制");
  if (depth > 16) throw new Error("INTEGRATION_RESULT_TOO_LARGE: 返回嵌套超过限制");
  if (typeof value === "string") return sanitizeText(value, state);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeValue(item, depth + 1, state));
  if (!value || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    result[key.slice(0, 160)] = sanitizeValue(item, depth + 1, state);
  }
  return result;
}

const writeEvidenceValue = (type: string, structured: Record<string, unknown>) => {
  if (type === "created_object_id") return structured.createdObjectId || structured.objectId || structured.id;
  if (type === "external_receipt_id") return structured.externalReceiptId || structured.receiptId || structured.messageId;
  if (type === "state_transition") return structured.stateTransition
    || (structured.previousState && structured.currentState ? `${structured.previousState}->${structured.currentState}` : "");
  if (type === "read_after_write_match") return structured.readAfterWriteMatch === true ? true : "";
  if (type === "delivery_acceptance") return structured.deliveryAccepted === true
    || (Array.isArray(structured.acceptedRecipients) && structured.acceptedRecipients.length > 0)
    ? structured.acceptedRecipients || true : "";
  if (type === "file_artifact") return structured.fileId && structured.checksum
    ? { fileId: structured.fileId, checksum: structured.checksum } : "";
  return "";
};

export function sanitizeToolResult(result: CallToolResult, options: {
  riskLevel?: number;
  completionEvidence?: string[];
} = {}): SanitizedToolResult {
  if (result.isError) throw new Error("INTEGRATION_REMOTE_UNAVAILABLE: 远程工具返回失败结果");
  const state = { nodes: 0, injectionDetected: false };
  const value = sanitizeValue({
    content: result.content,
    structuredContent: result.structuredContent
  }, 0, state) as Record<string, unknown>;
  const structured = value.structuredContent;
  const structuredRecord = structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured as Record<string, unknown> : {};
  if (Number(options.riskLevel || 0) >= 3) {
    const required = [...new Set(options.completionEvidence || [])];
    if (!required.length) throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: 写入工具未声明完成证据");
    const proofs = Object.fromEntries(required.map((type) => [type, writeEvidenceValue(type, structuredRecord)]));
    const missing = Object.entries(proofs).filter(([, proof]) => !proof).map(([type]) => type);
    if (missing.length) {
      throw new Error(`INTEGRATION_COMPLETION_EVIDENCE_MISSING: 写入结果缺少证据 ${missing.join(",")}`);
    }
    const externalReceipt = String(structuredRecord.externalReceiptId || structuredRecord.receiptId
      || structuredRecord.messageId || structuredRecord.createdObjectId || structuredRecord.objectId || structuredRecord.id || "");
    return {
      value,
      summary: {
        contentBlocks: Array.isArray(value.content) ? value.content.length : 0,
        structuredKeys: Object.keys(structuredRecord).slice(0, 50),
        injectionDetected: state.injectionDetected
      },
      evidence: {
        type: "write_completion",
        proofs,
        observedAt: new Date().toISOString(),
        injectionDetected: state.injectionDetected
      },
      externalReceipt,
      injectionDetected: state.injectionDetected
    };
  }
  const evidenceSource = structured && typeof structured === "object"
    ? String((structured as Record<string, unknown>).source || "")
    : "";
  const observedAt = structured && typeof structured === "object"
    ? String((structured as Record<string, unknown>).observedAt || "")
    : "";
  if (!evidenceSource || !observedAt || Number.isNaN(Date.parse(observedAt))) {
    throw new Error("INTEGRATION_COMPLETION_EVIDENCE_MISSING: 只读工具必须返回 source 和 observedAt");
  }
  const structuredKeys = structured && typeof structured === "object" && !Array.isArray(structured)
    ? Object.keys(structured as Record<string, unknown>).slice(0, 50)
    : [];
  return {
    value,
    summary: {
      contentBlocks: Array.isArray(value.content) ? value.content.length : 0,
      structuredKeys,
      injectionDetected: state.injectionDetected
    },
    evidence: {
      type: "read_observation",
      source: evidenceSource,
      observedAt,
      injectionDetected: state.injectionDetected
    },
    externalReceipt: evidenceSource,
    injectionDetected: state.injectionDetected
  };
}
