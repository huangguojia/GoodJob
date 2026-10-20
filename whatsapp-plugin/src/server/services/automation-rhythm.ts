import type { AutomationRunResult, AutomationSettings } from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { ConversationIntelligenceService } from "./conversation-intelligence.js";
// 「替 owner 签一枚 CRM token」这件事全仓只有一份实现（crm-client.ts）。
// 原先这里自带一份，与 crm-context.ts 各自签发时，issuer/audience/TTL 一漂移就是
// 「一条通道能用、另一条 401」这种极难查的故障。
import { crmIdentityToken, normalizePhone } from "./crm-client.js";
// 日期函数抽到 time-zone.ts：跟进同步也要「按业务员时区算今天」，两份实现迟早会漂。
import { localDate, nextDaily } from "./time-zone.js";

interface CrmCustomer {
  id: string;
  whatsapp?: string;
  whatsappPhone?: string;
}

interface CrmTodo {
  triggerKey?: string;
  done?: boolean;
}

export class AutomationRhythmService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ownerTick: ((ownerUserId: string) => Promise<void>) | null = null;
  private followupSync: ((ownerUserId: string) => Promise<void>) | null = null;
  constructor(
    private readonly repository: Repository,
    private readonly intelligence: ConversationIntelligenceService,
    private readonly crmBaseUrl: string,
    private readonly crmJwtSecret?: string,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /**
   * 注册「每个 owner 每分钟都要跑一次」的钩子（自动聊兜底扫描走这里）。
   *
   * 用注入而不是构造函数参数：这类钩子是可选的，晚绑定能避开它与自动聊服务之间的循环依赖。
   */
  setOwnerTick(handler: (ownerUserId: string) => Promise<void>): void {
    this.ownerTick = handler;
  }

  /**
   * 注册跟进同步（WhatsApp 对话 → CRM 客户跟进）。同样用晚绑定注入，理由与 `setOwnerTick` 一致。
   *
   * 它**不受本服务 `enabled` 开关约束**：跟进同步有自己的开关
   * （`automation_settings.followup_sync_enabled`），两件事互不牵连 ——
   * 关掉「节奏中心」不该顺手把客户跟进同步也停掉。
   */
  setFollowupSync(handler: (ownerUserId: string) => Promise<void>): void {
    this.followupSync = handler;
  }

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
      const response = await fetch(`${this.crmBaseUrl}/api/customers`, { headers: { authorization: `Bearer ${crmIdentityToken(this.crmJwtSecret, ownerUserId)}` }, signal: AbortSignal.timeout(5_000) });
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
        // 兜底钩子刻意排在 CRM 可达性检查之前：自动回复不依赖 CRM 是否在线。
        if (this.ownerTick) {
          try {
            await this.ownerTick(owner);
          } catch (error) {
            console.error("[communication-automation]", {
              event: "owner_tick_failed",
              ownerUserId: owner,
              error: error instanceof Error ? error.message : "unknown error"
            });
          }
        }
        const crm = await this.checkCrm(owner);
        if (!crm.ok) continue;
        await this.reconcileCrmTodos(owner);
        // 跟进同步刻意排在 `settings.enabled` 闸门**之前**：它有自己的开关，而且
        // 失败必须被单独记下（它的运行记录在 followup_sync_runs 里），不能和节奏中心混在一起。
        if (this.followupSync) {
          try {
            await this.followupSync(owner);
          } catch (error) {
            console.error("[communication-automation]", {
              event: "followup_sync_failed",
              ownerUserId: owner,
              error: error instanceof Error ? error.message : "unknown error"
            });
          }
        }
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
        headers: { authorization: `Bearer ${crmIdentityToken(this.crmJwtSecret, ownerUserId)}` },
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
      const response = await fetch(`${this.crmBaseUrl}/api/customers`, { headers: { authorization: `Bearer ${crmIdentityToken(this.crmJwtSecret, ownerUserId)}` }, signal: AbortSignal.timeout(10_000) });
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
      const response = await fetch(`${this.crmBaseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${crmIdentityToken(this.crmJwtSecret, ownerUserId)}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
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
