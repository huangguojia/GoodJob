export interface AgentWorkflowStepLike {
  key: string;
  dependsOn: string[];
  status: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const STEP_REFERENCE_SOURCE = "\\{\\{step:([a-z][a-z0-9_-]{0,79}):([a-zA-Z0-9_.-]{1,300})\\}\\}";
const BLOCKED_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

function stepReferencePattern() {
  return new RegExp(STEP_REFERENCE_SOURCE, "gu");
}

export function normalizeAgentWorkflowKey(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "")
    .slice(0, 80);
  const candidate = normalized && /^[a-z]/u.test(normalized) ? normalized : fallback;
  return candidate.slice(0, 80);
}

export function collectAgentStepReferences(value: unknown, depth = 0): string[] {
  if (depth > 20) throw new Error("Agent 工作流输入嵌套过深");
  if (typeof value === "string") {
    return [...value.matchAll(stepReferencePattern())].map((match) => match[1] || "").filter(Boolean);
  }
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => collectAgentStepReferences(item, depth + 1)))];
  if (!value || typeof value !== "object") return [];
  return [...new Set(Object.values(value as Record<string, unknown>).flatMap((item) => collectAgentStepReferences(item, depth + 1)))];
}

function resultAtPath(result: Record<string, unknown> | undefined, path: string) {
  const parts = path.split(".").filter(Boolean);
  if (!result || !parts.length || parts.some((part) => BLOCKED_PATH_PARTS.has(part))) return undefined;
  return parts.reduce<unknown>((current, part) => {
    if (Array.isArray(current) && /^\d+$/u.test(part)) return current[Number(part)];
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, result);
}

function resolveReferenceString(value: string, steps: AgentWorkflowStepLike[]) {
  const matches = [...value.matchAll(stepReferencePattern())];
  if (!matches.length) return value;
  const resolveMatch = (match: RegExpMatchArray) => {
    const key = match[1] || "";
    const path = match[2] || "";
    const source = steps.find((step) => step.key === key);
    if (!source) throw new Error(`工作流引用的步骤不存在：${key}`);
    if (source.status !== "done") throw new Error(`工作流前置步骤尚未完成：${key}`);
    const resolved = resultAtPath(source.result, path);
    if (resolved === undefined) throw new Error(`工作流结果路径不存在：${key}.${path}`);
    return resolved;
  };
  if (matches.length === 1 && matches[0]?.[0] === value) return structuredClone(resolveMatch(matches[0]));
  let output = value;
  for (const match of matches) {
    const resolved = resolveMatch(match);
    if (resolved !== null && typeof resolved === "object") throw new Error(`工作流嵌入引用必须是标量：${match[1]}.${match[2]}`);
    output = output.replace(match[0], String(resolved ?? ""));
  }
  return output;
}

export function resolveAgentWorkflowInput(value: unknown, steps: AgentWorkflowStepLike[], depth = 0): unknown {
  if (depth > 20) throw new Error("Agent 工作流输入嵌套过深");
  if (typeof value === "string") return resolveReferenceString(value, steps);
  if (Array.isArray(value)) return value.map((item) => resolveAgentWorkflowInput(item, steps, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, resolveAgentWorkflowInput(item, steps, depth + 1)]));
}

export function agentWorkflowDependenciesSatisfied(step: AgentWorkflowStepLike, steps: AgentWorkflowStepLike[]) {
  return step.dependsOn.every((key) => steps.some((candidate) => candidate.key === key && candidate.status === "done"));
}

export function agentWorkflowDependencyFailure(step: AgentWorkflowStepLike, steps: AgentWorkflowStepLike[]) {
  return step.dependsOn.find((key) => steps.some((candidate) => candidate.key === key && ["failed", "skipped"].includes(candidate.status))) || "";
}

export function validateAgentWorkflowGraph(steps: Array<{ key: string; dependsOn: string[]; input: Record<string, unknown> }>, existingKeys: string[] = []) {
  const known = new Set(existingKeys);
  for (const step of steps) {
    if (known.has(step.key)) throw new Error(`Agent 工作流步骤 key 重复：${step.key}`);
    known.add(step.key);
  }
  for (const step of steps) {
    const references = collectAgentStepReferences(step.input);
    const dependencies = [...new Set([...step.dependsOn, ...references])];
    const unknown = dependencies.find((key) => !known.has(key));
    if (unknown) throw new Error(`Agent 工作流依赖不存在：${step.key} -> ${unknown}`);
    if (dependencies.includes(step.key)) throw new Error(`Agent 工作流不能依赖自身：${step.key}`);
    step.dependsOn = dependencies;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const visit = (key: string) => {
    if (visited.has(key) || !byKey.has(key)) return;
    if (visiting.has(key)) throw new Error(`Agent 工作流存在循环依赖：${key}`);
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const step of steps) visit(step.key);
  return steps;
}
