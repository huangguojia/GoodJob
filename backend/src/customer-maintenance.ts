import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentActor } from "./ai-agent.js";
import type { CrmStore } from "./store.js";
import type { CustomerMaintenanceFinding, CustomerMaintenanceWatch, Todo } from "./types.js";

const rulesSchema = z.object({
  intervalHours: z.coerce.number().int().min(1).max(24 * 7).default(24),
  inactivityDays: z.coerce.number().int().min(1).max(90).default(7),
  healthBelow: z.coerce.number().int().min(0).max(100).default(60),
  includeOverdueReminder: z.boolean().default(true),
  includeMissingNextAction: z.boolean().default(true),
  grades: z.array(z.enum(["A", "B", "C", "D"])).max(4).default(["A", "B", "C", "D"]),
  maxTodosPerRun: z.coerce.number().int().min(1).max(50).default(10)
});

const watchInputSchema = z.object({
  name: z.string().trim().min(1).max(120).default("客户自动维护"),
  rules: rulesSchema.default({})
});

function canAccess(watch: CustomerMaintenanceWatch, user: AgentActor) {
  return watch.ownerId === user.id
    && watch.teamId === user.teamId;
}

function localMinuteText(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nextSortOrder(store: CrmStore, ownerId: string) {
  return Math.min(0, ...store.todos.filter((item) => item.ownerId === ownerId).map((item) => item.sortOrder || 0)) - 1;
}

function appendMissionEvent(store: CrmStore, watch: CustomerMaintenanceWatch, message: string, type: "result" | "error" = "result") {
  if (!watch.missionRunId) return;
  store.agentRunEvents.push({
    id: `age_${randomUUID()}`,
    runId: watch.missionRunId,
    ownerId: watch.ownerId,
    teamId: watch.teamId,
    type,
    message,
    createdAt: new Date().toISOString()
  });
}

export function scanCustomerMaintenance(store: CrmStore, watch: CustomerMaintenanceWatch, now = new Date()) {
  const inactivityBoundary = now.getTime() - watch.rules.inactivityDays * 86_400_000;
  const findings: CustomerMaintenanceFinding[] = [];
  const owner = store.users.find((item) => item.id === watch.ownerId && item.teamId === watch.teamId);
  for (const customer of store.customers.filter((item) =>
    item.ownerId === watch.ownerId
    && item.teamId === watch.teamId
    && item.poolStatus !== "public"
    && (!watch.rules.grades.length || watch.rules.grades.includes(item.grade || "C"))
  )) {
    const reasonCodes: string[] = [];
    const reasons: string[] = [];
    if (customer.health < watch.rules.healthBelow) {
      reasonCodes.push("low_health");
      reasons.push(`健康度 ${customer.health}`);
    }
    if (watch.rules.includeOverdueReminder && customer.nextReminder.includes("逾期")) {
      reasonCodes.push("overdue_followup");
      reasons.push("客户跟进已逾期");
    }
    const activities = store.customerActivities
      .filter((item) => item.customerId === customer.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const lastActivityAt = activities[0]?.createdAt || "";
    if (!lastActivityAt || new Date(lastActivityAt).getTime() <= inactivityBoundary) {
      reasonCodes.push("inactive_customer");
      reasons.push(lastActivityAt ? `${watch.rules.inactivityDays} 天未跟进` : "暂无跟进记录");
    }
    const activeDeals = store.deals.filter((item) =>
      item.customerId === customer.id
      && item.ownerId === watch.ownerId
      && !item.archivedAt
      && item.stage !== "成交"
      && item.stage !== "丢单"
    );
    const deal = activeDeals.sort((left, right) => right.amount - left.amount)[0];
    if (watch.rules.includeMissingNextAction && deal) {
      if (!deal.nextAction.trim()) {
        reasonCodes.push("missing_next_action");
        reasons.push("商机缺少下一动作");
      } else if (deal.nextActionAt && new Date(deal.nextActionAt).getTime() < now.getTime()) {
        reasonCodes.push("next_action_due");
        reasons.push("商机下一动作已到期");
      }
    }
    if (!reasonCodes.length) continue;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      watchId: watch.id,
      customerId: customer.id,
      reasonCodes,
      health: customer.health,
      nextReminder: customer.nextReminder,
      lastActivityAt,
      dealId: deal?.id || "",
      nextAction: deal?.nextAction || "",
      nextActionAt: deal?.nextActionAt || ""
    })).digest("hex").slice(0, 32);
    findings.push({
      customerId: customer.id,
      customerName: customer.company,
      dealId: deal?.id || "",
      reasonCodes,
      reason: reasons.join("；"),
      priority: reasonCodes.includes("overdue_followup") || customer.health < 40 ? "high" : "medium",
      triggerKey: `maintenance:${watch.id}:${fingerprint}`
    });
  }
  return findings.sort((left, right) => {
    const priority = { high: 3, medium: 2, normal: 1 };
    return priority[right.priority] - priority[left.priority] || left.customerName.localeCompare(right.customerName);
  });
}

export function previewCustomerMaintenance(store: CrmStore, user: AgentActor, rawInput: Record<string, unknown>, now = new Date()) {
  const rules = rulesSchema.parse(rawInput.rules || rawInput);
  const previewWatch = {
    id: "preview",
    ownerId: user.id,
    teamId: user.teamId,
    rules
  } as CustomerMaintenanceWatch;
  const findings = scanCustomerMaintenance(store, previewWatch, now);
  return {
    matchedCount: findings.length,
    creatableCount: Math.min(findings.length, rules.maxTodosPerRun),
    findings: findings.slice(0, 10),
    rules
  };
}

export async function createCustomerMaintenanceWatch(
  store: CrmStore,
  user: AgentActor,
  rawInput: Record<string, unknown>,
  missionRunId: string,
  approvalStepId: string
) {
  const input = watchInputSchema.parse(rawInput);
  const replay = store.customerMaintenanceWatches.find((item) => item.ownerId === user.id && item.approvalStepId === approvalStepId);
  if (replay) return replay;
  const now = new Date().toISOString();
  const watch: CustomerMaintenanceWatch = {
    id: `cmw_${randomUUID()}`,
    missionRunId,
    approvalStepId,
    ownerId: user.id,
    teamId: user.teamId,
    name: input.name,
    status: "active",
    rules: input.rules,
    nextRunAt: now,
    lastRunAt: "",
    lastMatchedCount: 0,
    lastCreatedCount: 0,
    lastSkippedCount: 0,
    totalCreatedCount: 0,
    lastFindings: [],
    lastError: "",
    approvedBy: user.id,
    approvedAt: now,
    createdAt: now,
    updatedAt: now
  };
  store.customerMaintenanceWatches.unshift(watch);
  appendMissionEvent(store, watch, `客户守护已启用：每 ${watch.rules.intervalHours} 小时巡检，单次最多创建 ${watch.rules.maxTodosPerRun} 个待办`);
  await store.persist();
  return watch;
}

export function listCustomerMaintenanceWatches(store: CrmStore, user: AgentActor, limit = 20) {
  return store.customerMaintenanceWatches
    .filter((item) => canAccess(item, user))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function controlCustomerMaintenanceWatch(
  store: CrmStore,
  user: AgentActor,
  id: string,
  action: "pause" | "resume" | "cancel"
) {
  const watch = store.customerMaintenanceWatches.find((item) => item.id === id && canAccess(item, user));
  if (!watch) throw new Error("客户守护策略不存在");
  if (action === "pause") {
    if (watch.status !== "active") throw new Error("只有运行中的客户守护可以暂停");
    watch.status = "paused";
  } else if (action === "resume") {
    if (!["paused", "error"].includes(watch.status)) throw new Error("只有暂停或受阻的客户守护可以继续");
    watch.status = "active";
    watch.lastError = "";
    watch.nextRunAt = new Date().toISOString();
  } else {
    if (watch.status === "cancelled") throw new Error("客户守护已经取消");
    watch.status = "cancelled";
  }
  watch.updatedAt = new Date().toISOString();
  appendMissionEvent(store, watch, `客户守护${action === "pause" ? "已暂停" : action === "resume" ? "已继续" : "已取消"}`);
  await store.persist();
  return watch;
}

export async function runCustomerMaintenanceWatch(store: CrmStore, watch: CustomerMaintenanceWatch, now = new Date()) {
  const findings = scanCustomerMaintenance(store, watch, now);
  const selected = findings.slice(0, watch.rules.maxTodosPerRun);
  const created: Todo[] = [];
  let skippedCount = Math.max(0, findings.length - selected.length);
  for (const finding of selected) {
    if (store.todos.some((item) => item.triggerKey === finding.triggerKey)) {
      skippedCount += 1;
      continue;
    }
    const customer = store.customers.find((item) => item.id === finding.customerId && item.ownerId === watch.ownerId);
    if (!customer) {
      skippedCount += 1;
      continue;
    }
    created.push({
      id: `t_maintenance_${randomUUID()}`,
      title: `客户守护：${customer.company}`,
      type: "customer",
      priority: finding.priority,
      status: "pending",
      pinState: "",
      sortOrder: nextSortOrder(store, watch.ownerId) - created.length,
      dueAt: localMinuteText(now),
      ownerId: watch.ownerId,
      teamId: watch.teamId,
      related: `${customer.company} · ${finding.reason}`,
      done: false,
      impactAmount: customer.amount,
      createdAt: now.toISOString(),
      customerId: customer.id,
      dealId: finding.dealId || undefined,
      reminderRuleId: `maintenance_watch:${watch.id}`,
      triggerKey: finding.triggerKey
    });
  }
  store.todos.unshift(...created);
  watch.lastRunAt = now.toISOString();
  watch.lastMatchedCount = findings.length;
  watch.lastCreatedCount = created.length;
  watch.lastSkippedCount = skippedCount;
  watch.totalCreatedCount += created.length;
  watch.lastFindings = findings.slice(0, 20);
  watch.lastError = "";
  watch.nextRunAt = new Date(now.getTime() + watch.rules.intervalHours * 3_600_000).toISOString();
  watch.updatedAt = now.toISOString();
  appendMissionEvent(store, watch, `客户守护巡检完成：发现 ${findings.length} 项，创建 ${created.length} 个待办，跳过 ${skippedCount} 项`);
  await store.persist();
  return { watch, findings, created, skippedCount };
}

export class CustomerMaintenanceRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly store: CrmStore, private readonly pollMs = 30_000) {}

  async start() {
    this.timer = setInterval(() => void this.synchronize(), this.pollMs);
    await this.synchronize();
  }

  async synchronize() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let cycle = 0; cycle < 50; cycle += 1) {
        const watch = this.store.customerMaintenanceWatches
          .filter((item) => item.status === "active" && new Date(item.nextRunAt).getTime() <= Date.now())
          .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))[0];
        if (!watch) break;
        try {
          await runCustomerMaintenanceWatch(this.store, watch);
        } catch (error) {
          watch.status = "error";
          watch.lastError = error instanceof Error ? error.message : "客户守护巡检失败";
          watch.updatedAt = new Date().toISOString();
          appendMissionEvent(this.store, watch, `客户守护巡检失败：${watch.lastError}`, "error");
          await this.store.persist();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
