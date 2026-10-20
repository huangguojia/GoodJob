import type {
  ChatMessage,
  Conversation,
  FollowupSyncEngine,
  FollowupSyncItem,
  FollowupSyncRun,
  FollowupSyncRunResult
} from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { crmIdentityToken, normalizePhone } from "./crm-client.js";
import { localDate, nextDaily } from "./time-zone.js";

/**
 * WhatsApp 对话 → CRM 客户跟进自动同步（docs/WHATSAPP-FOLLOWUP-SYNC-DESIGN.md）。
 *
 * 2026-10-15 用户拍板「**结论在 CRM 做**」后，这个服务瘦身为三件事：
 * 扫描会话库 → 打包当天消息推给 CRM → 记录运行明细。
 * 客户匹配、跟进结论生成（CRM 自己配置的 AI 模型）、写跟进/线索、站内信
 * 全部在 CRM 侧 `POST /api/whatsapp/followup-sync` 完成（见
 * `backend/src/whatsapp-followup-sync.ts`）——插件不再自己调模型，也不再写 CRM。
 *
 * 不变的约束：
 * 1. **只传库里的消息，原文不落 CRM 库**（CRM 只写整理过的结论）；
 * 2. **单个会话失败不拖垮整轮**，每个会话都有明细（含跳过）；
 * 3. 同一天重跑仍是「改写」：priorActivityId 随包带上，CRM 走 PATCH；
 * 4. 定时仍由插件 tick 驱动（常驻进程可靠，扩展的 chrome.alarms 不可靠）。
 */

/** 单次运行最多处理多少个会话。防某天消息爆量时一轮跑几十分钟。 */
const MAX_CONVERSATIONS_PER_RUN = 30;
/** 每批推给 CRM 的会话数：单批请求时长有界，批内失败不跨批。 */
const CONVERSATIONS_PER_BATCH = 5;
/** 单批请求超时。CRM 侧逐会话调模型（各 45s 上限），本机进程给足余量。 */
const DISPATCH_TIMEOUT_MS = 180_000;

/** CRM 返回的逐会话明细（backend/src/whatsapp-followup-sync.ts 的 FollowupSyncOutcome）。 */
export interface FollowupSyncDispatchOutcome {
  conversationId: string;
  contactName: string;
  contactPhone: string;
  messageCount: number;
  kind: FollowupSyncItem["kind"];
  status: FollowupSyncItem["status"];
  customerId: string | null;
  leadId: string | null;
  activityId: string | null;
  summary: string;
  error: string | null;
  ambiguousWith: number;
  /** true = 基础跟进已写入、AI 总结在 CRM 后台补全中（两段式，2026-10-15 起）。 */
  pending?: boolean;
  uncurated: boolean;
}

export interface FollowupSyncDispatchResult {
  engine: FollowupSyncEngine;
  model: string;
  failures: string[];
  /** 兼容旧字段：恒 0（占位口径已废弃）。 */
  uncurated: number;
  curationReason: string;
  notificationSent: boolean;
  /** 本轮进入 CRM 后台补全队列的会话数。 */
  refineQueued?: number;
  outcomes: FollowupSyncDispatchOutcome[];
}

export type FollowupSyncDispatcher = (payload: {
  runId: string;
  runDate: string;
  timezone: string;
  conversations: Array<{
    conversationId: string;
    contactName: string;
    contactPhone: string;
    priorActivityId?: string;
    messages: Array<{ direction: "inbound" | "outbound"; occurredAt: string; body: string }>;
  }>;
}) => Promise<FollowupSyncDispatchResult>;

/** 回测注入点：默认实现把包 POST 给 CRM。 */
export interface FollowupSyncOptions {
  dispatch?: FollowupSyncDispatcher;
}

/** 系统消息、空消息、已撤回都不进摘要 —— 它们不是「聊了什么」。 */
export function isSummarizable(message: ChatMessage): boolean {
  if (message.messageType === "system") return false;
  if (message.revokedAt) return false;
  return Boolean(String(message.body ?? "").trim());
}

/** 挑出「业务员所在时区里的那一天」的消息。 */
export function selectDayMessages(messages: ChatMessage[], timezone: string, runDate: string): ChatMessage[] {
  return messages.filter((message) => isSummarizable(message) && localDate(timezone, new Date(message.occurredAt)) === runDate);
}

/** 一次会话推给 CRM 前的打包结果。 */
interface PreparedConversation {
  conversation: Conversation;
  messages: ChatMessage[];
}

export class FollowupSyncService {
  constructor(
    private readonly repository: Repository,
    private readonly crmBaseUrl: string,
    private readonly crmJwtSecret?: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly options: FollowupSyncOptions = {}
  ) {}

  get configured(): boolean {
    return Boolean(this.crmJwtSecret);
  }

  /** 读设置（含跟进同步那几列）。 */
  async settings(ownerUserId: string): Promise<import("../../shared/types.js").AutomationSettings> {
    return this.repository.getAutomationSettings(ownerUserId);
  }

  /**
   * 保存跟进同步设置。`enabled` 默认是关的，这里只负责存，不负责劝用户开。
   *
   * 关闭时把 `nextFollowupSyncAt` 一并置空：留着一个未来时刻会让界面显示
   * 「下次同步 19:00」而实际永远不会跑，是最容易让人误判状态的一种假信息。
   */
  async updateSettings(ownerUserId: string, input: { enabled: boolean; hour: number; minute: number; timezone: string }): Promise<import("../../shared/types.js").AutomationSettings> {
    // 先读一次：设置行是懒建的（`getAutomationSettings` 在缺行时才插），
    // 不读就直接 UPDATE 会更新 0 行——保存看起来成功、其实什么都没写。
    await this.repository.getAutomationSettings(ownerUserId);
    await this.repository.saveFollowupSyncSettings(ownerUserId, {
      enabled: input.enabled,
      hour: input.hour,
      minute: input.minute,
      nextAt: input.enabled ? nextDaily(input.hour, input.minute, input.timezone) : null
    });
    return this.repository.getAutomationSettings(ownerUserId);
  }

  /**
   * 定时入口（由 AutomationRhythmService 每分钟调一次）。
   *
   * 触发条件两个，任一成立即跑：
   * - `nextFollowupSyncAt` 已到期；
   * - 从未跑过（`lastFollowupSyncAt` 为空）且**本地时间已过设定时点** —— 这条是为了
   *   「用户下午 3 点才把开关打开、时点是 19:00 之前的 9:00」这种情况不至于要等到明天。
   */
  async runIfDue(ownerUserId: string): Promise<FollowupSyncRunResult | null> {
    const settings = await this.repository.getAutomationSettings(ownerUserId);
    if (!settings.followupSyncEnabled) return null;
    const now = this.clock();
    const due = Boolean(settings.nextFollowupSyncAt && new Date(settings.nextFollowupSyncAt).getTime() <= now.getTime())
      || (!settings.lastFollowupSyncAt && this.localHour(settings.timezone, now) >= settings.followupSyncHour);
    if (!due) return null;
    return this.run(ownerUserId, { trigger: "scheduled" });
  }

  private localHour(timezone: string, value: Date): number {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false }).format(value));
  }

  async listRuns(ownerUserId: string, limit = 20): Promise<FollowupSyncRun[]> {
    return this.repository.listFollowupSyncRuns(ownerUserId, limit);
  }

  async listItems(runId: string, ownerUserId: string): Promise<FollowupSyncItem[]> {
    return this.repository.listFollowupSyncItems(runId, ownerUserId);
  }

  /**
   * 按 CRM activityId 取当次同步的对话文字版（跟进/旅程上点图标的供给端）。
   *
   * 原文一直在插件会话库里（这是唯一持久化的地方），这里只是按「那轮同步的
   * runDate + 时区」把当天消息挑出来回给 CRM —— 不新存一份数据。
   * 附件消息正文为空时用媒体文件名/类型占位，看的人知道「这里有个文件」。
   */
  async transcriptByActivity(ownerUserId: string, activityId: string): Promise<{
    activityId: string;
    runDate: string;
    timezone: string;
    contactName: string;
    contactPhone: string;
    messages: Array<{ direction: "inbound" | "outbound"; occurredAt: string; body: string; kind: string }>;
  } | null> {
    const item = await this.repository.findFollowupSyncItemByActivity(activityId, ownerUserId);
    if (!item) return null;
    const run = await this.repository.getFollowupSyncRun(item.runId, ownerUserId);
    const timezone = run?.timezone || "Asia/Shanghai";
    const runDate = run?.runDate || "";
    const all = await this.repository.listMessages(item.conversationKey, ownerUserId);
    const messages = selectDayMessages(all, timezone, runDate);
    return {
      activityId,
      runDate,
      timezone,
      contactName: item.contactName,
      contactPhone: item.contactPhone,
      messages: messages.map((message) => ({
        direction: message.direction,
        occurredAt: message.occurredAt,
        body: message.media?.fileName && !String(message.body ?? "").trim()
          ? `[${message.messageType === "file" || message.messageType === "image" || message.messageType === "video" || message.messageType === "audio" ? "文件" : "附件"}] ${message.media.fileName}`
          : String(message.body ?? ""),
        kind: message.messageType
      }))
    };
  }

  /**
   * 跑一次同步。**永不因为单个会话失败而整轮失败** ——
   * 一个号码写崩了不该让另外二十个客户的跟进也丢掉。失败逐条记进明细，整轮状态置 `partial`。
   */
  async run(ownerUserId: string, options: { trigger: "scheduled" | "manual" }): Promise<FollowupSyncRunResult> {
    const settings = await this.repository.getAutomationSettings(ownerUserId);
    const now = this.clock();
    const runDate = localDate(settings.timezone, now);
    const run = await this.repository.claimFollowupSyncRun({ ownerUserId, runDate, trigger: options.trigger, timezone: settings.timezone });
    const failures: string[] = [];
    try {
      const libraryConversations = await this.repository.listAutomationConversations(ownerUserId);
      const conversations = libraryConversations.slice(0, MAX_CONVERSATIONS_PER_RUN);
      // 先把「今天有对话」的会话连消息一起挑出来，再决定要不要连 CRM。
      // 一个消息都没有的日子不该产生任何 CRM 请求，也不该建线索。
      const prepared: PreparedConversation[] = [];
      for (const conversation of conversations) {
        const messages = selectDayMessages(await this.repository.listMessages(conversation.id, ownerUserId), settings.timezone, runDate);
        if (messages.length) prepared.push({ conversation, messages });
      }

      /** 已存在的今日明细：重跑时把 priorActivityId 带给 CRM，改写而不是再写一条。 */
      const priorItems = new Map((await this.repository.listFollowupSyncItems(run.id, ownerUserId)).map((item) => [item.conversationKey, item]));
      const outcomes: FollowupSyncDispatchOutcome[] = [];
      let engine: FollowupSyncEngine = "none";
      let model = "";
      let notificationSent = false;
      let pendingCount = 0;
      let curationReason = "";

      if (prepared.length) {
        for (let offset = 0; offset < prepared.length; offset += CONVERSATIONS_PER_BATCH) {
          const batch = prepared.slice(offset, offset + CONVERSATIONS_PER_BATCH);
          try {
            const result = await this.dispatch(ownerUserId, {
              runId: run.id,
              runDate,
              timezone: settings.timezone,
              conversations: batch.map(({ conversation, messages }) => ({
                conversationId: this.conversationKey(conversation),
                contactName: conversation.contactName,
                contactPhone: conversation.contactPhone,
                priorActivityId: priorItems.get(this.conversationKey(conversation))?.activityId ?? undefined,
                messages: messages.map((message) => ({
                  direction: message.direction === "outbound" ? "outbound" as const : "inbound" as const,
                  occurredAt: message.occurredAt,
                  body: String(message.body ?? "")
                }))
              }))
            });
            for (const outcome of result.outcomes) {
              outcomes.push(outcome);
              // 每个会话都要落一条明细，**包括被跳过和占位的** —— 这是「同步记录」的核心价值。
              await this.repository.saveFollowupSyncItem({
                runId: run.id,
                ownerUserId,
                conversationKey: outcome.conversationId,
                contactName: outcome.contactName,
                contactPhone: outcome.contactPhone,
                kind: outcome.kind,
                status: outcome.status,
                customerId: outcome.customerId,
                leadId: outcome.leadId,
                activityId: outcome.activityId,
                messageCount: outcome.messageCount,
                summary: outcome.summary,
                error: outcome.error
              });
            }
            if (result.engine !== "none") engine = result.engine;
            if (result.model) model = result.model;
            notificationSent = notificationSent || result.notificationSent;
            pendingCount += result.outcomes.filter((outcome) => outcome.pending).length;
            curationReason = result.curationReason || curationReason;
            failures.push(...result.failures);
          } catch (error) {
            // 整批失败（CRM 不可达/500）：批内每个会话都留一条失败明细，下一批继续。
            const message = error instanceof Error ? error.message : "同步失败";
            for (const { conversation, messages } of batch) {
              const conversationKey = this.conversationKey(conversation);
              const outcome: FollowupSyncDispatchOutcome = {
                conversationId: conversationKey,
                contactName: conversation.contactName,
                contactPhone: conversation.contactPhone,
                messageCount: messages.length,
                kind: "skipped",
                status: "failed",
                customerId: null,
                leadId: null,
                activityId: null,
                summary: "",
                error: message,
                ambiguousWith: 0,
                uncurated: false
              };
              outcomes.push(outcome);
              failures.push(`${conversation.contactName || conversation.contactPhone}：${message}`);
              await this.repository.saveFollowupSyncItem({
                runId: run.id,
                ownerUserId,
                conversationKey,
                contactName: conversation.contactName,
                contactPhone: conversation.contactPhone,
                kind: outcome.kind,
                status: outcome.status,
                customerId: null,
                leadId: null,
                activityId: null,
                messageCount: outcome.messageCount,
                summary: "",
                error: message
              });
            }
          }
        }
      }

      const result = this.tally(run, outcomes);
      const status = failures.length ? "partial" : "success";
      // 「扫描 0 个」必须说明**为什么**是 0：库是空的（用户不知道同步只扫插件库）和
      // 库里有会话但今天没消息，是两件完全不同的事。前者曾经让用户对着
      // 「扫描 0 个会话；更新 0 条」的记录完全无法自查。
      const summary = outcomes.length
        ? this.describe(result, status, failures.length, pendingCount, curationReason)
        : libraryConversations.length === 0
          ? "插件库里还没有任何 WhatsApp 会话，没有可归纳的内容（网页版的聊天要先送进插件库：侧边栏「同步今天 → CRM」会自动带上当前打开的会话，或在插件控制台手动导入）"
          : `插件库里的 ${libraryConversations.length} 个会话在 ${runDate} 当天都没有可归纳的消息`;
      await this.repository.updateFollowupSyncRun(run.id, {
        status,
        conversationsScanned: result.conversationsScanned,
        messageCount: result.messageCount,
        customersMatched: result.customersMatched,
        activitiesWritten: result.activitiesWritten,
        leadsCreated: result.leadsCreated,
        leadsExisting: result.leadsExisting,
        skipped: result.skipped,
        ambiguous: result.ambiguous,
        engine,
        model: model || null,
        notificationSent,
        error: failures.length ? failures.slice(0, 3).join("；") : null,
        summary,
        finishedAt: new Date().toISOString()
      });
      // 下一次时点必须在**这一轮跑完之后**才算，否则同一次 tick 会连跑两轮。
      await this.repository.updateFollowupSyncState(ownerUserId, {
        lastFollowupSyncAt: this.clock().toISOString(),
        nextFollowupSyncAt: nextDaily(settings.followupSyncHour, settings.followupSyncMinute, settings.timezone)
      });
      return { ...this.zeroResult(run.id, runDate), ...result, status, summary, notificationSent, engine, ranAt: this.clock().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步失败";
      await this.repository.updateFollowupSyncRun(run.id, { status: "failed", error: message, summary: message, finishedAt: new Date().toISOString() });
      // 失败也必须推进下次时点，否则 tick 每 60 秒重试一次，把 CRM 打爆。
      await this.repository.updateFollowupSyncState(ownerUserId, {
        lastFollowupSyncAt: this.clock().toISOString(),
        nextFollowupSyncAt: nextDaily(settings.followupSyncHour, settings.followupSyncMinute, settings.timezone)
      });
      throw error;
    }
  }

  /** 会话在记录表里的稳定键。用会话 id 而不是号码：同一号码理论上可能有两条会话。 */
  private conversationKey(conversation: Conversation): string {
    return conversation.id || normalizePhone(conversation.contactPhone) || conversation.contactId;
  }

  private zeroResult(runId: string, runDate: string): FollowupSyncRunResult {
    return {
      runId,
      runDate,
      status: "success",
      conversationsScanned: 0,
      messageCount: 0,
      customersMatched: 0,
      activitiesWritten: 0,
      leadsCreated: 0,
      leadsExisting: 0,
      skipped: 0,
      ambiguous: 0,
      engine: "none",
      notificationSent: false,
      summary: "",
      ranAt: this.clock().toISOString()
    };
  }

  private tally(run: FollowupSyncRun, outcomes: FollowupSyncDispatchOutcome[]): Omit<FollowupSyncRunResult, "status" | "summary" | "notificationSent" | "ranAt" | "engine"> {
    return {
      runId: run.id,
      runDate: run.runDate,
      conversationsScanned: outcomes.length,
      messageCount: outcomes.reduce((total, outcome) => total + outcome.messageCount, 0),
      customersMatched: outcomes.filter((outcome) => outcome.kind === "customer").length,
      activitiesWritten: outcomes.filter((outcome) => outcome.kind === "customer" && outcome.status === "written").length,
      leadsCreated: outcomes.filter((outcome) => outcome.kind === "lead" && outcome.status === "written").length,
      leadsExisting: outcomes.filter((outcome) => outcome.kind === "lead" && outcome.status === "existing").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped" || outcome.status === "existing").length,
      ambiguous: outcomes.filter((outcome) => outcome.ambiguousWith > 1).length
    };
  }

  private describe(result: { conversationsScanned: number; customersMatched: number; activitiesWritten: number; leadsCreated: number; leadsExisting: number; skipped: number; ambiguous: number }, status: string, failureCount: number, pendingCount: number, curationReason: string): string {
    const head = `扫描 ${result.conversationsScanned} 个会话；更新客户跟进 ${result.activitiesWritten} 条（匹配 ${result.customersMatched} 个客户）；新建线索 ${result.leadsCreated} 条（已有 ${result.leadsExisting} 条）；跳过 ${result.skipped} 个`;
    const tail = result.ambiguous ? `；${result.ambiguous} 个号码在 CRM 里对应多个客户，未写入` : "";
    // 两段式：跟进即时写入（基础信息），AI 总结由 CRM 后台补全。「补全中」必须说出来，
    // 否则用户会以为基础统计就是最终内容。
    const pendingNote = pendingCount ? `；${pendingCount} 个已入库、AI 进展总结后台补全中（${curationReason || "完成后自动更新跟进"}）` : "";
    const fail = failureCount ? `；${failureCount} 项失败` : "";
    return `${head}${tail}${pendingNote}${fail}（${status}）`;
  }

  /** 默认的推送实现：自签 owner 身份 JWT，与插件其它 CRM 调用同一套口径。 */
  private async dispatch(ownerUserId: string, payload: Parameters<FollowupSyncDispatcher>[0]): Promise<FollowupSyncDispatchResult> {
    if (this.options.dispatch) return this.options.dispatch(payload);
    if (!this.crmJwtSecret) throw new Error("CRM 服务签名密钥尚未配置");
    const response = await fetch(`${this.crmBaseUrl}/api/whatsapp/followup-sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${crmIdentityToken(this.crmJwtSecret, ownerUserId)}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS)
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data as unknown as FollowupSyncDispatchResult;
  }
}
