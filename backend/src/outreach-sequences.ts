import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentActor } from "./ai-agent.js";
import { assertCrmOutreachEligible } from "./prospect-outreach-eligibility.js";
import type { CrmStore } from "./store.js";
import type { OutreachSequence, OutreachSequenceStepSnapshot } from "./types.js";

const stepInputSchema = z.object({
  delayHours: z.coerce.number().min(0).max(24 * 30),
  subject: z.string().trim().max(200).default(""),
  body: z.string().trim().min(1).max(6_000)
});

const sequenceInputSchema = z.object({
  entityType: z.enum(["customer", "lead"]),
  entityId: z.string().trim().min(1).max(120),
  channel: z.enum(["email", "communication"]),
  accountId: z.string().trim().max(120).default(""),
  steps: z.array(stepInputSchema).min(1).max(5)
});

export interface OutreachSequenceRuntime {
  send(sequence: OutreachSequence, step: OutreachSequenceStepSnapshot, executionId: string): Promise<Record<string, unknown>>;
  stopReason(sequence: OutreachSequence): Promise<string>;
}

function canAccess(sequence: OutreachSequence, user: AgentActor) {
  return sequence.ownerId === user.id
    && sequence.teamId === user.teamId;
}

function appendMissionEvent(store: CrmStore, sequence: OutreachSequence, message: string, type: "result" | "error" = "result") {
  if (!sequence.missionRunId) return;
  store.agentRunEvents.push({
    id: `age_${randomUUID()}`,
    runId: sequence.missionRunId,
    ownerId: sequence.ownerId,
    teamId: sequence.teamId,
    type,
    message,
    createdAt: new Date().toISOString()
  });
}

export async function createOutreachSequence(
  store: CrmStore,
  user: AgentActor,
  rawInput: Record<string, unknown>,
  missionRunId: string,
  approvalStepId = missionRunId
) {
  const input = sequenceInputSchema.parse(rawInput);
  const entity = input.entityType === "customer"
    ? store.customers.find((item) => item.id === input.entityId && item.ownerId === user.id && item.teamId === user.teamId)
    : store.leads.find((item) => item.id === input.entityId && item.ownerId === user.id && !item.deletedAt && item.teamId === user.teamId);
  if (!entity) throw new Error("触达对象不存在，或仅对象负责人可创建自动触达序列");
  if (input.channel === "communication" && input.entityType !== "customer") {
    throw new Error("Communication 自动触达目前仅支持已进入客户库的对象");
  }
  const recipient = input.channel === "email"
    ? (input.entityType === "customer"
        ? store.leads.find((lead) => lead.convertedCustomerId === entity.id && lead.ownerId === user.id)?.email || ""
        : "email" in entity ? entity.email : "")
    : "whatsapp" in entity ? entity.whatsapp || "" : "";
  if (!recipient) throw new Error(input.channel === "email" ? "触达对象没有可用邮箱" : "客户没有有效的 WhatsApp 号码");
  const now = new Date();
  let cursor = now.getTime();
  const steps = input.steps.map((item, index): OutreachSequenceStepSnapshot => {
    cursor += item.delayHours * 3_600_000;
    return {
      index,
      delayHours: item.delayHours,
      subject: input.channel === "email" ? item.subject : "",
      body: item.body,
      status: "pending",
      scheduledAt: new Date(cursor).toISOString(),
      sentAt: "",
      error: ""
    };
  });
  if (input.channel === "email" && steps.some((item) => !item.subject)) throw new Error("邮件序列的每一步都必须锁定主题");
  const replay = store.outreachSequences.find((item) => item.approvalStepId === approvalStepId && item.ownerId === user.id);
  if (replay) return replay;
  await store.reloadProspectQualificationTeam?.(user.teamId);
  if (input.entityType === "customer") {
    assertCrmOutreachEligible(store, {
      target: { entityType: "customer", entity: entity as typeof store.customers[number] },
      actorId: user.id,
      channel: input.channel === "email" ? "email" : "whatsapp",
      recipient
    });
  } else {
    assertCrmOutreachEligible(store, {
      target: { entityType: "lead", entity: entity as typeof store.leads[number] },
      actorId: user.id,
      channel: "email",
      recipient
    });
  }
  const sequence: OutreachSequence = {
    id: `oseq_${randomUUID()}`,
    missionRunId,
    approvalStepId,
    ownerId: user.id,
    teamId: user.teamId,
    entityType: input.entityType,
    entityId: input.entityId,
    entityName: entity.company,
    recipient,
    channel: input.channel,
    accountId: input.accountId,
    status: "active",
    currentStep: 0,
    maxSends: steps.length,
    steps,
    approvedBy: user.id,
    approvedAt: now.toISOString(),
    nextExecutionAt: steps[0]!.scheduledAt,
    lastSentAt: "",
    stopReason: "",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  store.outreachSequences.unshift(sequence);
  appendMissionEvent(store, sequence, `受控触达序列已批准：${sequence.entityName}，共 ${sequence.maxSends} 次`);
  await store.persist();
  return sequence;
}

export function listOutreachSequences(store: CrmStore, user: AgentActor, limit = 20) {
  return store.outreachSequences
    .filter((item) => canAccess(item, user))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function controlOutreachSequence(
  store: CrmStore,
  user: AgentActor,
  id: string,
  action: "pause" | "resume" | "cancel"
) {
  const sequence = store.outreachSequences.find((item) => item.id === id && canAccess(item, user));
  if (!sequence) throw new Error("触达序列不存在");
  if (action === "pause") {
    if (sequence.status !== "active") throw new Error("只有运行中的序列可以暂停");
    sequence.status = "paused";
    sequence.stopReason = "用户暂停";
  } else if (action === "resume") {
    if (sequence.status !== "paused") throw new Error("只有暂停的序列可以继续");
    sequence.status = "active";
    sequence.stopReason = "";
  } else {
    if (["completed", "cancelled", "stopped"].includes(sequence.status)) throw new Error("该序列已经结束");
    sequence.status = "cancelled";
    sequence.stopReason = "用户取消";
    sequence.steps.forEach((step) => { if (step.status === "pending") step.status = "skipped"; });
  }
  sequence.updatedAt = new Date().toISOString();
  appendMissionEvent(store, sequence, `触达序列${action === "pause" ? "已暂停" : action === "resume" ? "已继续" : "已取消"}`);
  await store.persist();
  return sequence;
}

export class OutreachSequenceRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly store: CrmStore,
    private readonly runtime: OutreachSequenceRuntime,
    private readonly pollMs = 5_000
  ) {}

  async start() {
    let changed = false;
    for (const sequence of this.store.outreachSequences.filter((item) => item.steps.some((step) => step.status === "sending"))) {
      sequence.status = "failed";
      sequence.stopReason = "服务重启时发送结果不确定，已停止以避免重复发送";
      sequence.updatedAt = new Date().toISOString();
      appendMissionEvent(this.store, sequence, sequence.stopReason, "error");
      changed = true;
    }
    if (changed) await this.store.persist();
    this.timer = setInterval(() => void this.synchronize(), this.pollMs);
    await this.synchronize();
  }

  async synchronize() {
    if (this.busy) return;
    this.busy = true;
    try {
      const sequence = this.store.outreachSequences
        .filter((item) => item.status === "active" && new Date(item.nextExecutionAt).getTime() <= Date.now())
        .sort((left, right) => left.nextExecutionAt.localeCompare(right.nextExecutionAt))[0];
      if (!sequence) return;
      const stopReason = await this.runtime.stopReason(sequence);
      if (stopReason) {
        sequence.status = "stopped";
        sequence.stopReason = stopReason;
        sequence.steps.forEach((step) => { if (step.status === "pending") step.status = "skipped"; });
        sequence.updatedAt = new Date().toISOString();
        appendMissionEvent(this.store, sequence, `触达序列自动停止：${stopReason}`);
        await this.store.persist();
        return;
      }
      const step = sequence.steps.find((item) => item.status === "pending");
      if (!step) {
        sequence.status = "completed";
        sequence.nextExecutionAt = "";
        sequence.updatedAt = new Date().toISOString();
        await this.store.persist();
        return;
      }
      step.status = "sending";
      sequence.updatedAt = new Date().toISOString();
      await this.store.persist();
      try {
        await this.runtime.send(sequence, step, `sequence:${sequence.id}:${step.index}`);
        const sentAt = new Date().toISOString();
        step.status = "sent";
        step.sentAt = sentAt;
        step.error = "";
        sequence.currentStep = step.index + 1;
        sequence.lastSentAt = sentAt;
        const next = sequence.steps.find((item) => item.status === "pending");
        sequence.status = next ? "active" : "completed";
        sequence.nextExecutionAt = next?.scheduledAt || "";
        sequence.updatedAt = sentAt;
        appendMissionEvent(this.store, sequence, `${sequence.entityName} 第 ${step.index + 1}/${sequence.maxSends} 次触达已发送`);
      } catch (error) {
        step.status = "failed";
        step.error = error instanceof Error ? error.message : "发送失败";
        sequence.status = "failed";
        sequence.stopReason = step.error;
        sequence.updatedAt = new Date().toISOString();
        appendMissionEvent(this.store, sequence, `触达序列发送失败：${step.error}`, "error");
      }
      await this.store.persist();
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
