import { compileAgentGoalSpec, type AgentGoalSpec } from "./agent-goal.js";

interface VerifiableStep {
  tool: string;
  risk: string;
  status: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface AgentMissionVerification {
  complete: boolean;
  satisfied: string[];
  missing: string[];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nestedValue(value: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function hasEntityId(step: VerifiableStep, path: string, responsePath: string) {
  if (step.tool !== "api.write" || step.status !== "done") return false;
  if (text(step.input.method).toUpperCase() !== "POST" || text(step.input.path) !== path) return false;
  return Boolean(text(nestedValue(step.result?.data, responsePath)));
}

function hasDeclaredCompletionEvidence(step: VerifiableStep) {
  if (step.status !== "done" || !step.result) return false;
  const evidence = step.result.completionEvidence;
  if (!evidence || typeof evidence !== "object") return false;
  const record = evidence as Record<string, unknown>;
  if (record.type === "created_object_id" && Array.isArray(record.responsePaths)) {
    const data = step.result.data;
    return record.responsePaths.length > 0
      && record.responsePaths.every((path) => typeof path === "string" && Boolean(text(nestedValue(data, path))));
  }
  return typeof step.result.status === "number" && step.result.status >= 200 && step.result.status < 300;
}

function minimumRequestedCount(spec: AgentGoalSpec, objective: AgentGoalSpec["objectives"][number]) {
  const source = `${spec.rawGoal} ${objective.completionCriteria.join(" ")}`;
  const numeric = source.match(/(?:至少|目标|需要|希望|返回|搜出|找到|形成)?\s*(\d{1,5})\s*(?:家|个|条|名)/u)?.[1];
  if (numeric) return Math.max(1, Number(numeric));
  if (/(至少|形成|得到|返回).{0,8}(?:一|1).{0,2}(?:家|个|条|名|候选)/u.test(source)) return 1;
  return 1;
}

function selectedTargetId(spec: AgentGoalSpec, domain: AgentGoalSpec["primaryDomain"]) {
  if (domain === "customers") return spec.pageContext.selectedCustomerId;
  if (domain === "leads") return spec.pageContext.selectedLeadId;
  if (domain === "deals") return spec.pageContext.selectedDealId;
  return "";
}

function stepMatchesTarget(step: VerifiableStep, targetId: string) {
  if (!targetId) return true;
  return [step.input.customerId, step.input.leadId, step.input.dealId, step.input.entityId]
    .some((value) => text(value) === targetId)
    || text(step.input.path).split("/").includes(targetId);
}

function stepTargetId(step: VerifiableStep) {
  const direct = [step.input.customerId, step.input.leadId, step.input.dealId, step.input.entityId]
    .map(text)
    .find(Boolean);
  if (direct) return direct;
  const parts = text(step.input.path).split("/").filter(Boolean);
  return parts.length >= 3 ? parts[2] || "" : "";
}

function requestedUpdateFields(spec: AgentGoalSpec) {
  const fields: string[] = [];
  if (/(健康度|health)/iu.test(spec.rawGoal)) fields.push("health");
  if (/(分级|等级|grade)/iu.test(spec.rawGoal)) fields.push("grade");
  if (/(阶段|stage)/iu.test(spec.rawGoal)) fields.push("stage");
  if (/(下一步|下一动作|nextAction)/iu.test(spec.rawGoal)) fields.push("nextAction");
  return fields;
}

function requestedUpdateValues(spec: AgentGoalSpec) {
  const values: Record<string, unknown> = {};
  const health = spec.rawGoal.match(/(?:健康度|health).{0,10}?(\d{1,3})/iu)?.[1];
  if (health !== undefined) values.health = Number(health);
  const grade = spec.rawGoal.match(/(?:分级|等级|grade).{0,10}?([ABCD])/iu)?.[1];
  if (grade) values.grade = grade.toUpperCase();
  const stage = spec.rawGoal.match(/(?:阶段|stage).{0,10}?(询盘|已联系|已报价|样品|谈判|成交|丢单)/iu)?.[1];
  if (stage) values.stage = stage;
  return values;
}

function resultEntity(step: VerifiableStep, domain: AgentGoalSpec["primaryDomain"]) {
  const key = domain === "customers" ? "customer"
    : domain === "leads" ? "lead"
      : domain === "deals" ? "deal"
        : "";
  if (!key) return undefined;
  return nestedValue(step.result, key) || nestedValue(step.result?.data, key);
}

function objectiveSatisfied(spec: AgentGoalSpec, objective: AgentGoalSpec["objectives"][number], steps: VerifiableStep[]) {
  const done = steps.filter((item) => item.status === "done" && item.result);
  if (objective.action === "create") {
    const mapping: Partial<Record<typeof objective.domain, [string, string]>> = {
      customers: ["/api/customers", "customer.id"],
      leads: ["/api/leads", "lead.id"],
      deals: ["/api/deals", "deal.id"],
      documents: ["/api/trade-documents", "document.id"],
      todos: ["/api/todos", "todo.id"],
      memos: ["/api/memos", "memo.id"]
    };
    const target = mapping[objective.domain];
    if (target) {
      const apiEvidence = done.some((step) => hasEntityId(step, target[0], target[1]));
      if (apiEvidence) return true;
      if (objective.domain === "todos") {
        return done.some((step) => step.tool === "crm.create_todo" && Boolean(text(nestedValue(step.result, "todo.id"))));
      }
      return false;
    }
    if (objective.domain === "outreach" || objective.domain === "communication") {
      return done.some((step) =>
        (step.tool === "outreach.create_sequence" && Boolean(text(step.result?.sequenceId)))
        || (step.tool === "outreach.draft_development_email" && Boolean(text(nestedValue(step.result, "draft.body"))))
      );
    }
    return done.some((step) => hasDeclaredCompletionEvidence(step));
  }
  if (objective.action === "record") {
    return done.some((step) => Boolean(
      text(nestedValue(step.result, "activity.id"))
      || text(nestedValue(step.result?.data, "activity.id"))
    ));
  }
  if (objective.action === "navigate") {
    return done.some((step) => step.tool.startsWith("ui.") && Boolean(step.result?.uiAction));
  }
  if (objective.action === "send") {
    return done.some((step) => {
      if (step.risk !== "external") return false;
      const channelReceipt = Boolean(text(step.result?.messageId)) || step.result?.replayed === true;
      const crmActivity = Boolean(text(step.result?.activityId));
      return step.result?.sent === true && channelReceipt && crmActivity;
    }) || done.some((step) => step.tool === "outreach.get_sequence_progress"
      && step.result?.terminal === true
      && Number(step.result?.currentStep || 0) >= 1);
  }
  if (objective.action === "search" && objective.domain === "prospecting") {
    const minimum = minimumRequestedCount(spec, objective);
    return done.some((step) => step.tool === "prospect.get_search_progress"
      && step.result?.terminal === true
      && Number(step.result?.candidateCount || 0) >= minimum);
  }
  if (objective.action === "update") {
    const targetId = selectedTargetId(spec, objective.domain);
    const requiredFields = requestedUpdateFields(spec);
    const expectedValues = requestedUpdateValues(spec);
    return done.some((step) => {
      if (step.risk !== "write" || step.tool === "api.catalog" || !stepMatchesTarget(step, targetId)) return false;
      const entity = resultEntity(step, objective.domain);
      if (!entity || typeof entity !== "object") return false;
      const record = entity as Record<string, unknown>;
      const actualTargetId = text(record.id);
      const requestedTargetId = targetId || stepTargetId(step);
      if (requestedTargetId && actualTargetId !== requestedTargetId) return false;
      if (!requiredFields.every((field) => record[field] !== undefined)) return false;
      return Object.entries(expectedValues).every(([field, value]) => record[field] === value);
    });
  }
  if (objective.action === "read" || objective.action === "analyze") {
    const targetId = selectedTargetId(spec, objective.domain);
    return done.some((step) => step.risk === "read" && step.tool !== "api.catalog" && stepMatchesTarget(step, targetId));
  }
  if (objective.action === "draft") {
    return done.some((step) => step.risk === "draft" && (
      Boolean(text(step.result?.body))
      || Boolean(text(nestedValue(step.result, "draft.body")))
      || Boolean(text(nestedValue(step.result?.data, "document.id")))
    ));
  }
  if (objective.action === "export" && objective.domain === "documents") {
    return done.some((step) => {
      if (step.tool !== "api.write" || text(step.input.method).toUpperCase() !== "POST") return false;
      if (!/^\/api\/trade-documents\/[^/]+\/export$/u.test(text(step.input.path))) return false;
      const fileName = text(nestedValue(step.result?.data, "fileName"));
      const jobId = text(nestedValue(step.result?.data, "job.id"));
      const documentId = text(nestedValue(step.result?.data, "document.id"));
      return Boolean(fileName && jobId && documentId);
    });
  }
  if (objective.action === "manage") {
    return done.some((step) => ["write", "external"].includes(step.risk));
  }
  // An unknown objective cannot be satisfied by an unrelated successful read.
  return false;
}

export function verifyAgentMissionOutcome(input: {
  goal: string;
  goalSpec?: AgentGoalSpec;
  steps: VerifiableStep[];
}): AgentMissionVerification {
  if (input.steps.some((item) => item.status === "failed")) {
    return { complete: false, satisfied: [], missing: ["仍有失败步骤未恢复"] };
  }
  const spec = input.goalSpec || compileAgentGoalSpec(input.goal);
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const objective of spec.objectives) {
    if (objectiveSatisfied(spec, objective, input.steps)) satisfied.push(objective.id);
    else missing.push(`${objective.description}：${objective.completionCriteria.join("；")}`);
  }
  return { complete: missing.length === 0, satisfied, missing };
}
