export type AgentRecoveryAction = "retry_once" | "replan" | "wait_user" | "stop";

export interface AgentRecoveryDecision {
  action: AgentRecoveryAction;
  category: "transient" | "validation" | "permission" | "not_found" | "external_unknown" | "unknown";
  reason: string;
}

interface RecoverableStep {
  tool: string;
  risk: string;
  input: Record<string, unknown>;
  error?: string;
}

function headerValue(input: Record<string, unknown>, name: string) {
  const headers = input.headers;
  if (!headers || typeof headers !== "object") return "";
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function decideAgentStepRecovery(step: RecoverableStep): AgentRecoveryDecision {
  const message = String(step.error || "").toLowerCase();
  if (step.risk === "external") {
    return {
      action: "stop",
      category: "external_unknown",
      reason: "外部动作失败后不能自动重放，必须先核验渠道是否已经产生副作用"
    };
  }
  if (/(401|403|无权|权限|forbidden|unauthorized)/u.test(message)) {
    return { action: "stop", category: "permission", reason: "权限错误不能通过重试修复" };
  }
  if (/(404|不存在|not found)/u.test(message)) {
    return { action: "replan", category: "not_found", reason: "目标对象已变化，需要重新查询真实对象" };
  }
  if (/(400|422|schema|zod|字段|参数|格式|必填|validation|invalid)/u.test(message)) {
    return { action: "replan", category: "validation", reason: "参数不符合契约，需要按 Schema 修正后重新规划" };
  }
  if (/(408|409|425|429|500|502|503|504|timeout|timed out|econnreset|econnrefused|socket|network|temporar)/u.test(message)) {
    const idempotentWrite = step.risk === "write" && Boolean(headerValue(step.input, "Idempotency-Key"));
    if (step.risk === "read" || step.risk === "draft" || idempotentWrite) {
      return { action: "retry_once", category: "transient", reason: "检测到瞬时故障，当前动作满足安全重试条件" };
    }
    return { action: "replan", category: "transient", reason: "检测到瞬时故障，但写入缺少幂等键，改由规划器选择安全恢复路径" };
  }
  return { action: "replan", category: "unknown", reason: "未知失败不直接重放，交由规划器根据真实错误选择下一步" };
}
