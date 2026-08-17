import { randomUUID } from "node:crypto";

export type ApprovalNodeType = "start" | "approval" | "condition" | "cc" | "automation" | "end";
export type ApprovalOperator = "equals" | "not_equals" | "greater_than" | "greater_or_equal" | "less_than" | "less_or_equal" | "contains" | "in" | "exists";

export interface ApprovalGraphNode {
  id: string;
  type: ApprovalNodeType;
  name: string;
  position: { x: number; y: number };
  approverStrategy: string;
  approverConfig: Record<string, unknown>;
  approvalMode: "single" | "all" | "any";
  config: Record<string, unknown>;
  sortOrder: number;
}

export interface ApprovalGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  priority: number;
  condition?: { field: string; operator: ApprovalOperator; value?: unknown };
}

export interface ApprovalGraph {
  nodes: ApprovalGraphNode[];
  edges: ApprovalGraphEdge[];
}

const nodeTypes = new Set<ApprovalNodeType>(["start", "approval", "condition", "cc", "automation", "end"]);
const operators = new Set<ApprovalOperator>(["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "contains", "in", "exists"]);
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
const stringValue = (value: unknown, fallback = "") => String(value ?? fallback).trim();
const finite = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function normalizeNode(raw: unknown, index: number): ApprovalGraphNode {
  const item = record(raw);
  const rawPosition = record(item.position);
  const type = nodeTypes.has(String(item.type || item.nodeType) as ApprovalNodeType)
    ? String(item.type || item.nodeType) as ApprovalNodeType
    : "approval";
  const defaultName: Record<ApprovalNodeType, string> = {
    start: "发起申请", approval: `第 ${index + 1} 级审批`, condition: "条件判断", cc: "抄送通知", automation: "自动动作", end: "流程结束"
  };
  return {
    id: stringValue(item.id) || id("apnode"),
    type,
    name: stringValue(item.name) || defaultName[type],
    position: { x: finite(rawPosition.x ?? item.positionX, 120 + index * 220), y: finite(rawPosition.y ?? item.positionY, 180) },
    approverStrategy: stringValue(item.approverStrategy, "requester_manager"),
    approverConfig: record(item.approverConfig),
    approvalMode: ["single", "all", "any"].includes(String(item.approvalMode)) ? item.approvalMode as ApprovalGraphNode["approvalMode"] : "single",
    config: record(item.config),
    sortOrder: finite(item.sortOrder, index + 1)
  };
}

function normalizeEdge(raw: unknown, index: number): ApprovalGraphEdge | null {
  const item = record(raw);
  const source = stringValue(item.source);
  const target = stringValue(item.target);
  if (!source || !target) return null;
  const conditionRaw = record(item.condition);
  const operator = operators.has(String(conditionRaw.operator) as ApprovalOperator)
    ? String(conditionRaw.operator) as ApprovalOperator
    : "equals";
  const condition = stringValue(conditionRaw.field)
    ? { field: stringValue(conditionRaw.field), operator, ...(Object.hasOwn(conditionRaw, "value") ? { value: conditionRaw.value } : {}) }
    : undefined;
  return {
    id: stringValue(item.id) || id("apedge"), source, target,
    label: stringValue(item.label), priority: finite(item.priority, index + 1), condition
  };
}

export function normalizeApprovalGraph(input: Record<string, unknown>): ApprovalGraph {
  const sourceNodes = Array.isArray(input.nodes) ? input.nodes : [];
  let nodes = sourceNodes.map(normalizeNode);
  let edges = (Array.isArray(input.edges) ? input.edges : []).map(normalizeEdge).filter((edge): edge is ApprovalGraphEdge => Boolean(edge));

  const hasExplicitGraph = nodes.some((node) => node.type !== "approval") || edges.length > 0;
  if (!hasExplicitGraph && nodes.length > 0) {
    const start = normalizeNode({ type: "start", name: "发起申请", position: { x: 80, y: 180 } }, 0);
    const end = normalizeNode({ type: "end", name: "流程结束", position: { x: 300 + nodes.length * 220, y: 180 } }, nodes.length + 1);
    nodes = [start, ...nodes.map((node, index) => ({ ...node, position: { x: 300 + index * 220, y: 180 }, sortOrder: index + 2 })), end];
    edges = nodes.slice(0, -1).map((node, index) => ({ id: id("apedge"), source: node.id, target: nodes[index + 1].id, label: "", priority: index + 1 }));
  }
  return { nodes, edges };
}

export function validateApprovalGraph(graph: ApprovalGraph): string[] {
  const issues: string[] = [];
  if (graph.nodes.length < 3) issues.push("流程至少需要开始、一个处理节点和结束节点");
  if (graph.nodes.length > 60) issues.push("单个流程最多支持 60 个节点");
  if (graph.edges.length > 120) issues.push("单个流程最多支持 120 条连线");
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push(`节点 ID 重复：${node.id}`);
    ids.add(node.id);
  }
  const starts = graph.nodes.filter((node) => node.type === "start");
  const ends = graph.nodes.filter((node) => node.type === "end");
  if (starts.length !== 1) issues.push("流程必须且只能有一个开始节点");
  if (ends.length !== 1) issues.push("流程必须且只能有一个结束节点");

  const outgoing = new Map<string, ApprovalGraphEdge[]>();
  const incoming = new Map<string, ApprovalGraphEdge[]>();
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) issues.push("存在连接到已删除节点的连线");
    if (edge.source === edge.target) issues.push("节点不能连接到自身");
    const key = `${edge.source}:${edge.target}`;
    if (edgeKeys.has(key)) issues.push("相同节点之间不能重复连线");
    edgeKeys.add(key);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge]);
  }
  if (starts[0] && (incoming.get(starts[0].id) || []).length) issues.push("开始节点不能有入口连线");
  if (ends[0] && (outgoing.get(ends[0].id) || []).length) issues.push("结束节点不能有出口连线");
  for (const node of graph.nodes) {
    if (node.type !== "start" && !(incoming.get(node.id) || []).length) issues.push(`“${node.name}”没有入口连线`);
    if (node.type !== "end" && !(outgoing.get(node.id) || []).length) issues.push(`“${node.name}”没有出口连线`);
    if (node.type === "condition") {
      const branches = outgoing.get(node.id) || [];
      if (branches.length < 2) issues.push(`条件节点“${node.name}”至少需要两个分支`);
      if (!branches.some((edge) => !edge.condition)) issues.push(`条件节点“${node.name}”需要一个默认分支`);
    }
    if (node.type === "approval" && !["specific_member", "role_in_tenant", "requester_manager", "permission_holder"].includes(node.approverStrategy)) {
      issues.push(`审批节点“${node.name}”的审批人规则无效`);
    }
  }

  if (starts[0]) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let cycle = false;
    const walk = (nodeId: string) => {
      if (visiting.has(nodeId)) { cycle = true; return; }
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const edge of outgoing.get(nodeId) || []) walk(edge.target);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    walk(starts[0].id);
    if (cycle) issues.push("当前流程存在循环连线，审批流只能向前推进");
    const unreachable = graph.nodes.filter((node) => !visited.has(node.id));
    if (unreachable.length) issues.push(`存在不可到达节点：${unreachable.map((node) => node.name).join("、")}`);
  }
  return [...new Set(issues)];
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => record(value)[key], source);
}

export function evaluateApprovalCondition(condition: ApprovalGraphEdge["condition"], context: Record<string, unknown>): boolean {
  if (!condition) return true;
  const actual = getPath(context, condition.field);
  const expected = condition.value;
  switch (condition.operator) {
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "not_equals": return String(actual ?? "") !== String(expected ?? "");
    case "greater_than": return Number(actual) > Number(expected);
    case "greater_or_equal": return Number(actual) >= Number(expected);
    case "less_than": return Number(actual) < Number(expected);
    case "less_or_equal": return Number(actual) <= Number(expected);
    case "contains": return Array.isArray(actual) ? actual.map(String).includes(String(expected)) : String(actual ?? "").includes(String(expected ?? ""));
    case "in": return Array.isArray(expected) ? expected.map(String).includes(String(actual)) : String(expected ?? "").split(",").map((item) => item.trim()).includes(String(actual));
    default: return String(actual ?? "") === String(expected ?? "");
  }
}

export function nextApprovalNode(graph: ApprovalGraph, fromNodeId: string, context: Record<string, unknown>): ApprovalGraphNode | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, ApprovalGraphEdge[]>();
  for (const edge of graph.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge].sort((a, b) => a.priority - b.priority));
  let currentId = fromNodeId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const current = byId.get(currentId);
    if (!current) return null;
    if (current.type === "approval") return current;
    if (current.type === "end") return null;
    const branches = outgoing.get(current.id) || [];
    const edge = current.type === "condition"
      ? branches.find((candidate) => candidate.condition && evaluateApprovalCondition(candidate.condition, context)) || branches.find((candidate) => !candidate.condition)
      : branches[0];
    if (!edge) return null;
    currentId = edge.target;
  }
  return null;
}

export function nextApprovalNodeAfter(graph: ApprovalGraph, completedNodeId: string, context: Record<string, unknown>): ApprovalGraphNode | null {
  const branches = graph.edges.filter((edge) => edge.source === completedNodeId).sort((a, b) => a.priority - b.priority);
  const edge = branches.find((candidate) => candidate.condition && evaluateApprovalCondition(candidate.condition, context))
    || branches.find((candidate) => !candidate.condition);
  return edge ? nextApprovalNode(graph, edge.target, context) : null;
}

export function graphStartNode(graph: ApprovalGraph) {
  return graph.nodes.find((node) => node.type === "start") || null;
}

export function graphSnapshot(input: Record<string, unknown>, graph: ApprovalGraph) {
  return {
    name: stringValue(input.name), businessType: stringValue(input.businessType),
    triggerConfig: record(input.triggerConfig), formSchema: record(input.formSchema), nodes: graph.nodes, edges: graph.edges
  };
}

export function workflowMatches(triggerConfig: Record<string, unknown>, context: Record<string, unknown>) {
  if (triggerConfig.enabled === false) return false;
  const conditions = Array.isArray(triggerConfig.conditions) ? triggerConfig.conditions : [];
  return conditions.every((raw) => {
    const item = record(raw);
    return evaluateApprovalCondition({ field: stringValue(item.field), operator: operators.has(String(item.operator) as ApprovalOperator) ? item.operator as ApprovalOperator : "equals", value: item.value }, context);
  });
}
