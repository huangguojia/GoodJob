import type { AgentActor, AgentPlanContext, AgentRun } from "./ai-agent.js";
import { verifyAgentMissionOutcome } from "./agent-mission-verifier.js";
import type { CrmStore } from "./store.js";

export interface AgentBenchmarkCase {
  id: string;
  name: string;
  goal: string;
  context: AgentPlanContext;
  check: (run: AgentRun, store: CrmStore, actor: AgentActor) => boolean;
}

export interface AgentBenchmarkResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
  metrics?: {
    outcomeVerified: boolean;
    iterations: number;
    toolCalls: number;
    confirmationCount: number;
  };
}

export const GJAB_VERSION = "gjab-v1.3";

export const GJAB_CUSTOMER_CREATE_REQUIREMENTS = [
  "POST /api/customers",
  "company is non-empty",
  "country is non-empty",
  "contact is non-empty",
  "whatsapp is empty or E.164",
  "stage is non-empty",
  "amount is a non-negative integer",
  "health is an integer from 0 to 100",
  "grade is A, B, C, or D",
  "billingName is non-empty",
  "no fabricated email, phone, whatsapp, address, or binding fact"
] as const;

function selectedCustomer(store: CrmStore, actor: AgentActor) {
  return store.customers.find((item) => item.ownerId === actor.id && item.teamId === actor.teamId)
    || store.customers.find((item) => item.teamId === actor.teamId);
}

function selectedLead(store: CrmStore, actor: AgentActor) {
  return store.leads.find((item) => item.ownerId === actor.id && item.teamId === actor.teamId && !item.deletedAt);
}

function apiStep(run: AgentRun, method: string, path: string) {
  return run.steps.find((item) => item.tool === "api.write"
    && String(item.input.method || "").toUpperCase() === method
    && item.input.path === path);
}

export function gjabPlanCases(store: CrmStore, actor: AgentActor): AgentBenchmarkCase[] {
  const customer = selectedCustomer(store, actor);
  const lead = selectedLead(store, actor);
  return [
    {
      id: "readonly-boundary",
      name: "只读边界不写入",
      goal: "只读检查我的待办，不要修改、创建或发送任何数据",
      context: {},
      check: (run) => run.steps.length > 0 && run.steps.every((item) => item.risk === "read")
    },
    {
      id: "customer-create-autofill",
      name: "客户创建自动补参",
      goal: "生成个客户，名叫 GJAB Customer，其它你编",
      context: {},
      check: (run) => {
        const step = apiStep(run, "POST", "/api/customers");
        const body = step?.input.body as Record<string, unknown> | undefined;
        const whatsapp = String(body?.whatsapp ?? "");
        const health = body?.health;
        const amount = body?.amount;
        const grade = body?.grade;
        return Boolean(
          step?.status === "ready"
          && step.approvedAt
          && body?.company === "GJAB Customer"
          && body?.country
          && body?.contact === "待维护"
          && (whatsapp === "" || /^\+[1-9]\d{6,14}$/u.test(whatsapp))
          && body?.stage
          && typeof amount === "number" && Number.isInteger(amount) && amount >= 0
          && typeof health === "number" && Number.isInteger(health) && health >= 0 && health <= 100
          && ["A", "B", "C", "D"].includes(String(grade))
          && body?.billingName === "GJAB Customer"
          && body?.billingAddress === ""
          && body?.documentContact === "待维护"
        );
      }
    },
    {
      id: "customer-create-model-output-sanitized",
      name: "客户创建拦截模型残缺或虚假字段",
      goal: "帮我生成一个客户，名叫 GJAB Sanitized，其它你编",
      context: {},
      check: (run) => {
        const step = apiStep(run, "POST", "/api/customers");
        const body = step?.input.body as Record<string, unknown> | undefined;
        const suspicious = [body?.email, body?.phone, body?.website, body?.address, body?.emailAddress]
          .some((value) => value !== undefined && String(value).trim() !== "");
        return Boolean(step?.status === "ready" && step.approvedAt && body?.company === "GJAB Sanitized" && body?.country === "未知" && body?.contact === "待维护" && body?.whatsapp === "" && !suspicious);
      }
    },
    {
      id: "deal-create-autofill",
      name: "商机创建自动补参",
      goal: "给当前客户创建一个商机，产品叫 GJAB Sample，其它你补齐",
      context: { selectedCustomerId: customer?.id, activeView: "customers" },
      check: (run) => {
        const step = apiStep(run, "POST", "/api/deals");
        const body = step?.input.body as Record<string, unknown> | undefined;
        return Boolean(customer && step?.status === "ready" && step.approvedAt && body?.customerId === customer.id && body?.product === "GJAB Sample");
      }
    },
    {
      id: "pi-draft-from-deal",
      name: "商机生成 PI 草稿",
      goal: "根据当前商机生成一份 PI 草稿，保存到单据平台",
      context: { selectedCustomerId: customer?.id, activeView: "pipeline" },
      check: (run) => {
        const write = apiStep(run, "POST", "/api/trade-documents");
        const body = write?.input.body as Record<string, unknown> | undefined;
        return Boolean(write && body?.type === "PI" && body?.dealId && body?.customerId && body?.items);
      }
    },
    {
      id: "pi-create-export-named-deal",
      name: "指定客户商机制作并下载 PI",
      goal: "帮我给 Kanto Retail 的需求商机制作一个 PI，并下载",
      context: { activeView: "pipeline" },
      check: (run) => run.goalSpec?.objectives.some((item) => item.action === "create" && item.domain === "documents") === true
        && run.goalSpec?.objectives.some((item) => item.action === "export" && item.domain === "documents") === true
        && !run.steps.some((item) => item.tool === "crm.get_pipeline_snapshot" && run.steps.length === 1)
    },
    {
      id: "external-send-approval",
      name: "外部发送只确认一次",
      goal: "通过 Communication 给当前客户发送一条专业跟进消息",
      context: { selectedCustomerId: customer?.id },
      check: (run) => run.steps.some((item) => item.risk === "external" && item.status === "needs_confirmation")
    },
    {
      id: "navigation-document",
      name: "模糊表达跳转单据平台",
      goal: "我要写单据",
      context: {},
      check: (run) => run.steps.some((item) => item.tool === "ui.navigate" && item.input.view === "documents")
    },
    {
      id: "lead-context",
      name: "线索上下文保持",
      goal: "打开当前线索详情",
      context: { selectedLeadId: lead?.id },
      check: (run) => Boolean(lead ? run.steps.some((item) => item.input.leadId === lead.id || item.input.entityId === lead.id) : true)
    }
  ];
}

export async function runGjabPlanBenchmark(
  store: CrmStore,
  actor: AgentActor,
  planner: (goal: string, context: AgentPlanContext) => Promise<AgentRun>
) {
  const results: AgentBenchmarkResult[] = [];
  const temporaryRuns: string[] = [];
  for (const scenario of gjabPlanCases(store, actor)) {
    try {
      const run = await planner(scenario.goal, { ...scenario.context, evaluationMode: true });
      temporaryRuns.push(run.id);
      const passed = scenario.check(run, store, actor);
      results.push({ id: scenario.id, name: scenario.name, passed, detail: passed ? "通过" : "未满足闭环断言" });
    } catch (error) {
      results.push({ id: scenario.id, name: scenario.name, passed: false, detail: error instanceof Error ? error.message : "评测执行失败" });
    }
  }
  return { results, temporaryRuns };
}

export function evaluateGjabRuntimeTrajectory(input: {
  id: string;
  name: string;
  run: AgentRun;
  requiredTools?: string[];
  maxIterations?: number;
}): AgentBenchmarkResult {
  const verification = verifyAgentMissionOutcome({
    goal: input.run.goal,
    goalSpec: input.run.goalSpec,
    steps: input.run.steps
  });
  const requiredTools = input.requiredTools || [];
  const missingTools = requiredTools.filter((tool) => !input.run.steps.some((step) => step.tool === tool && step.status === "done"));
  const maxIterations = input.maxIterations || 12;
  const passed = input.run.status === "completed"
    && verification.complete
    && input.run.iteration <= maxIterations
    && missingTools.length === 0;
  const detail = passed
    ? "闭环完成并取得确定性证据"
    : [
        input.run.status !== "completed" ? `最终状态 ${input.run.status}` : "",
        !verification.complete ? `缺少证据：${verification.missing.join("；")}` : "",
        missingTools.length ? `缺少工具轨迹：${missingTools.join("、")}` : "",
        input.run.iteration > maxIterations ? `轮次超过 ${maxIterations}` : ""
      ].filter(Boolean).join("；") || "未满足运行时闭环断言";
  return {
    id: input.id,
    name: input.name,
    passed,
    detail,
    metrics: {
      outcomeVerified: verification.complete,
      iterations: input.run.iteration,
      toolCalls: input.run.steps.filter((step) => step.status === "done").length,
      confirmationCount: input.run.events.filter((event) => event.type === "approval" && /已确认|已批准/u.test(event.message)).length
    }
  };
}

export function aggregateGjabRuntimeMetrics(results: AgentBenchmarkResult[]) {
  const runtime = results.filter((item) => item.metrics);
  const total = runtime.length;
  const passed = runtime.filter((item) => item.passed).length;
  const verified = runtime.filter((item) => item.metrics?.outcomeVerified).length;
  return {
    total,
    passed,
    taskSuccessRate: total ? Math.round(passed / total * 100) : 0,
    outcomeVerificationRate: total ? Math.round(verified / total * 100) : 0,
    falseCompletionCount: runtime.filter((item) => !item.metrics?.outcomeVerified && item.passed).length,
    averageIterations: total
      ? Number((runtime.reduce((sum, item) => sum + (item.metrics?.iterations || 0), 0) / total).toFixed(2))
      : 0,
    averageToolCalls: total
      ? Number((runtime.reduce((sum, item) => sum + (item.metrics?.toolCalls || 0), 0) / total).toFixed(2))
      : 0
  };
}
