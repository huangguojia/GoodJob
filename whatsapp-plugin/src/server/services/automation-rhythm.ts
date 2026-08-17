import jwt from "jsonwebtoken";
import type { AutomationRunResult, AutomationSettings } from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { ConversationIntelligenceService } from "./conversation-intelligence.js";

function crmToken(secret: string, userId: string): string {
  return jwt.sign({ ver: 1 }, secret, { subject: userId, issuer: "goodjob-crm", audience: "goodjob-crm-web", expiresIn: "10m", algorithm: "HS256" });
}

function localDate(timezone: string, value: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function nextDaily(hour: number, minute: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const start = Date.now() + 60_000;
  for (let offset = 0; offset <= 48 * 60; offset += 1) {
    const candidate = new Date(start + offset * 60_000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    if (Number(parts.hour) === hour && Number(parts.minute) === minute) return candidate.toISOString();
  }
  return new Date(start + 24 * 3_600_000).toISOString();
}

interface CrmCustomer {
  id: string;
  whatsapp?: string;
  whatsappPhone?: string;
}

interface CrmTodo {
  triggerKey?: string;
  done?: boolean;
}

function normalizePhone(value: string | null | undefined): string {
  const digits = value?.replace(/\D/gu, "") ?? "";
  return digits ? `+${digits}` : "";
}

export class AutomationRhythmService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private readonly repository: Repository,
    private readonly intelligence: ConversationIntelligenceService,
    private readonly crmBaseUrl: string,
    private readonly crmJwtSecret?: string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.runScheduledTick();
    this.timer = setInterval(() => void this.runScheduledTick(), 60_000);
    this.timer.unref();
  }

  private async runScheduledTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      console.error("[communication-automation]", {
        event: "scheduled_tick_failed",
        error: error instanceof Error ? error.message : "unknown error"
      });
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async get(ownerUserId: string): Promise<AutomationSettings> {
    return this.repository.getAutomationSettings(ownerUserId);
  }

  async update(ownerUserId: string, input: { analysisIntervalHours: number; intelligenceMode: AutomationSettings["intelligenceMode"]; intelligenceProviderId: string | null; dailyTodoHour: number; dailyTodoMinute: number; timezone: string; enabled: boolean }): Promise<AutomationSettings> {
    const nextAnalysisAt = new Date(Date.now() + input.analysisIntervalHours * 3_600_000).toISOString();
    return this.repository.saveAutomationSettings({ ...input, ownerUserId, nextAnalysisAt, nextDailyTodoAt: nextDaily(input.dailyTodoHour, input.dailyTodoMinute, input.timezone) });
  }

  async checkCrm(ownerUserId: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this.crmJwtSecret) return { ok: false, error: "CRM 服务签名密钥尚未配置" };
    try {
      const response = await fetch(`${this.crmBaseUrl}/api/customers`, { headers: { authorization: `Bearer ${crmToken(this.crmJwtSecret, ownerUserId)}` }, signal: AbortSignal.timeout(5_000) });
      return response.ok ? { ok: true, error: null } : { ok: false, error: `CRM 返回 HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "CRM 连接失败" };
    }
  }

  async runNow(ownerUserId: string): Promise<AutomationRunResult> {
    return this.runOwner(ownerUserId, true);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const owners = new Set((await this.repository.listAccounts()).map((account) => account.ownerUserId).filter((id): id is string => Boolean(id)));
      for (const owner of owners) {
        const crm = await this.checkCrm(owner);
        if (!crm.ok) continue;
        await this.reconcileCrmTodos(owner);
        const settings = await this.repository.getAutomationSettings(owner);
        if (!settings.enabled) continue;
        const dueAnalysis = !settings.nextAnalysisAt || new Date(settings.nextAnalysisAt).getTime() <= Date.now();
        const now = Date.now();
        const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone, hour: "2-digit", hour12: false }).format(new Date()));
        const dueDaily = Boolean(settings.nextDailyTodoAt && new Date(settings.nextDailyTodoAt).getTime() <= now)
          || (!settings.lastDailyTodoAt && localHour >= settings.dailyTodoHour);
        if (dueAnalysis || dueDaily) await this.runOwner(owner, false, dueAnalysis, dueDaily);
      }
    } finally { this.running = false; }
  }

  private async reconcileCrmTodos(ownerUserId: string): Promise<void> {
    if (!this.crmJwtSecret) return;
    try {
      const response = await fetch(`${this.crmBaseUrl}/api/todos`, {
        headers: { authorization: `Bearer ${crmToken(this.crmJwtSecret, ownerUserId)}` },
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return;
      const payload = await response.json() as { todos?: CrmTodo[] };
      for (const todo of payload.todos ?? []) {
        const match = todo.triggerKey?.match(/^whatsapp-insight:[^:]+:([^:]+)$/u);
        if (!match) continue;
        await this.repository.updateConversationFollowupStatus(match[1], todo.done ? "completed" : "pending", ownerUserId);
      }
    } catch (error) {
      console.error("[communication-automation]", {
        event: "crm_todo_reconciliation_failed",
        ownerUserId,
        error: error instanceof Error ? error.message : "unknown error"
      });
    }
  }

  private async runOwner(ownerUserId: string, force = false, doAnalysis = true, doDaily = true): Promise<AutomationRunResult> {
    const started = this.clock().toISOString();
    const settings = await this.repository.getAutomationSettings(ownerUserId);
    const result: AutomationRunResult = { analysisScanned: 0, analysisUpdated: 0, todosCreated: 0, notificationsSent: 0, skipped: 0, ranAt: started };
    const deliveryErrors: string[] = [];
    const conversations = await this.repository.listAutomationConversations(ownerUserId);
    const run = await this.repository.createAutomationRun({ ownerUserId, trigger: force ? "manual" : "scheduled", totalConversations: conversations.length });
    try {
      await this.repository.updateAutomationRun(ownerUserId, { status: "running", summary: `正在分析 ${conversations.length} 个会话` });
      if (force || doAnalysis) {
        for (const conversation of conversations) {
          await this.repository.updateAutomationRunProgress(run.id, { currentConversation: conversation.contactName });
          result.analysisScanned += 1;
          const before = await this.repository.getConversationAnalysis(conversation.id, ownerUserId);
          if (!force && before && new Date(before.updatedAt).getTime() >= new Date(conversation.updatedAt).getTime()) {
            await this.repository.updateAutomationRunProgress(run.id, { processedConversations: result.analysisScanned, analysisUpdated: result.analysisUpdated });
            continue;
          }
          const after = await this.intelligence.analyzeConversation(conversation.id);
          if (!before || before.updatedAt !== after.analysis.updatedAt) result.analysisUpdated += 1;
          await this.repository.updateAutomationRunProgress(run.id, { processedConversations: result.analysisScanned, analysisUpdated: result.analysisUpdated });
        }
      }
      if (force || doDaily) {
        const pendingDeliveries: Array<{ conversation: (typeof conversations)[number]; followup: Awaited<ReturnType<ConversationIntelligenceService["getConversationIntelligence"]>>["followups"][number] }> = [];
        for (const conversation of conversations) {
          const intelligence = await this.intelligence.getConversationIntelligence(conversation.id, ownerUserId);
          for (const followup of intelligence.followups.filter((item) => item.status === "pending")) {
            pendingDeliveries.push({ conversation, followup });
          }
        }
        const customers = pendingDeliveries.length ? await this.crmCustomers(ownerUserId) : { ok: true as const, data: [], error: null };
        if (!customers.ok) throw new Error(`CRM 交付失败 ${pendingDeliveries.length * 2} 项；可再次运行。客户匹配：${customers.error}`);
        const customersByPhone = new Map(customers.data.map((customer) => [normalizePhone(customer.whatsappPhone || customer.whatsapp), customer]));
        const runDate = localDate(settings.timezone, this.clock());
        for (const { conversation, followup } of pendingDeliveries) {
          const customer = customersByPhone.get(normalizePhone(conversation.contactPhone));
          if (await this.repository.claimAutomationDelivery(ownerUserId, followup.id, runDate, "todo")) {
              const triggerSubject = customer?.id ?? normalizePhone(conversation.contactPhone);
              const delivered = await this.crmWrite(ownerUserId, "/api/todos", {
                title: followup.title,
                type: "customer",
                priority: followup.priority === "normal" ? "normal" : followup.priority,
                dueAt: followup.dueAt,
                related: `WhatsApp ${conversation.contactPhone}：${followup.reason}`,
                customerId: customer?.id,
                triggerKey: `whatsapp-insight:${triggerSubject}:${followup.id}`
              });
              if (delivered.ok && !delivered.deduplicated) result.todosCreated += 1;
              else if (delivered.ok) result.skipped += 1;
              if (delivered.ok) await this.repository.completeAutomationDelivery(ownerUserId, followup.id, runDate, "todo", delivered.externalId);
              else {
                deliveryErrors.push(`${conversation.contactName}待办：${delivered.error}`);
                await this.repository.failAutomationDelivery(ownerUserId, followup.id, runDate, "todo", delivered.error ?? "CRM 待办写入失败");
              }
          } else result.skipped += 1;
          if (await this.repository.claimAutomationDelivery(ownerUserId, followup.id, runDate, "notification")) {
              const notified = await this.crmWrite(ownerUserId, "/api/internal-messages/system", {
                subject: `WhatsApp 今日跟进：${followup.title}`,
                content: `${conversation.contactName}（${conversation.contactPhone}）需要跟进。${followup.reason}`,
                relatedId: followup.id,
                idempotencyKey: `whatsapp-insight:${followup.id}:notification:${runDate}`
              });
              if (notified.ok && !notified.deduplicated) result.notificationsSent += 1;
              else if (notified.ok) result.skipped += 1;
              if (notified.ok) await this.repository.completeAutomationDelivery(ownerUserId, followup.id, runDate, "notification", notified.externalId);
              else {
                deliveryErrors.push(`${conversation.contactName}站内信：${notified.error}`);
                await this.repository.failAutomationDelivery(ownerUserId, followup.id, runDate, "notification", notified.error ?? "CRM 站内信写入失败");
              }
          } else result.skipped += 1;
        }
      }
      if (deliveryErrors.length) {
        throw new Error(`CRM 交付失败 ${deliveryErrors.length} 项；可再次运行。${deliveryErrors.slice(0, 3).join("；")}`);
      }
      const nextAnalysisAt = new Date(this.clock().getTime() + settings.analysisIntervalHours * 3_600_000).toISOString();
      await this.repository.updateAutomationRunProgress(run.id, { status: "success", processedConversations: result.analysisScanned, analysisUpdated: result.analysisUpdated, todosCreated: result.todosCreated, notificationsSent: result.notificationsSent, skipped: result.skipped, currentConversation: null, finishedAt: new Date().toISOString() });
      await this.repository.updateAutomationRun(ownerUserId, { status: "success", summary: `分析 ${result.analysisUpdated}/${result.analysisScanned} 个会话；新增 ${result.todosCreated} 条待办；发送 ${result.notificationsSent} 条站内信；去重或跳过 ${result.skipped} 项`, lastAnalysisAt: (force || doAnalysis) ? started : settings.lastAnalysisAt ?? undefined, nextAnalysisAt, lastDailyTodoAt: (force || doDaily) ? started : settings.lastDailyTodoAt ?? undefined, nextDailyTodoAt: nextDaily(settings.dailyTodoHour, settings.dailyTodoMinute, settings.timezone) });
      return result;
    } catch (error) {
      await this.repository.updateAutomationRunProgress(run.id, { status: "failed", error: error instanceof Error ? error.message : "自动化运行失败", currentConversation: null, finishedAt: new Date().toISOString() });
      await this.repository.updateAutomationRun(ownerUserId, { status: "failed", summary: error instanceof Error ? error.message : "自动化运行失败" });
      throw error;
    }
  }

  private async crmCustomers(ownerUserId: string): Promise<{ ok: true; data: CrmCustomer[]; error: null } | { ok: false; data: []; error: string }> {
    if (!this.crmJwtSecret) return { ok: false, data: [], error: "CRM 服务签名密钥尚未配置" };
    try {
      const response = await fetch(`${this.crmBaseUrl}/api/customers`, { headers: { authorization: `Bearer ${crmToken(this.crmJwtSecret, ownerUserId)}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
        return { ok: false, data: [], error: payload.message ?? payload.error ?? `HTTP ${response.status}` };
      }
      const payload = await response.json() as { customers?: CrmCustomer[] };
      return { ok: true, data: payload.customers ?? [], error: null };
    } catch (error) {
      return { ok: false, data: [], error: error instanceof Error ? error.message : "CRM 连接失败" };
    }
  }

  private async crmWrite(ownerUserId: string, path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error: string | null; deduplicated: boolean; externalId: string | null }> {
    if (!this.crmJwtSecret) return { ok: false, error: "CRM 服务签名密钥尚未配置", deduplicated: false, externalId: null };
    try {
      const response = await fetch(`${this.crmBaseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${crmToken(this.crmJwtSecret, ownerUserId)}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const payload = await response.json().catch(() => ({})) as { deduplicated?: boolean; todo?: { id?: string }; message?: { id?: string } };
        return { ok: true, error: null, deduplicated: payload.deduplicated === true, externalId: payload.todo?.id ?? payload.message?.id ?? null };
      }
      const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
      return { ok: false, error: payload.message ?? payload.error ?? `HTTP ${response.status}`, deduplicated: false, externalId: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "CRM 连接失败", deduplicated: false, externalId: null };
    }
  }
}
