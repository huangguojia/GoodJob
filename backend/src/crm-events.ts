/**
 * 进程内业务事件总线：开发信被打开 / 点击 / 回复、广告表单线索入库……
 * 产生事件的地方只管 emit，不关心谁在听（企业微信推送、以后的钉钉 / 飞书 / 站内信都挂在这里）。
 * 监听器出错不能影响主流程：一律吞掉并打日志。
 */
export type CrmEvent =
  | { type: "email.opened"; teamId: string; ownerId: string; logId: string; messageId: string; to: string; subject: string; company: string; openCount: number; occurredAt: string }
  | { type: "email.clicked"; teamId: string; ownerId: string; logId: string; messageId: string; to: string; subject: string; company: string; url: string; occurredAt: string }
  | { type: "email.replied"; teamId: string; ownerId: string; logId: string; messageId: string; to: string; subject: string; company: string; from: string; replySubject: string; snippet: string; occurredAt: string }
  | { type: "mail.inbound"; teamId: string; ownerId: string; messageId: string; inReplyTo: string; from: string; subject: string; snippet: string; occurredAt: string }
  | { type: "lead.ads"; teamId: string; ownerId: string; leadId: string; company: string; contact: string; email: string; phone: string; campaign: string; channel: string; occurredAt: string }
  /** 一轮开发信发完，按发件邮箱生成的总结 Excel 已经发回各自邮箱 */
  | { type: "outreach.summary"; teamId: string; ownerId: string; batchId: string; batchLabel: string; deliveries: number; sentEmails: number; failedEmails: number; customers: number; letters: number; occurredAt: string }
  /** 自动流一轮真的把信发完了（不依赖总结邮件是否寄出，先给一个明确结论） */
  | { type: "outreach.round"; teamId: string; ownerId: string; batchId: string; batchLabel: string; sent: number; failed: number; customers: number; senders: number; occurredAt: string };

type Listener = (event: CrmEvent) => void | Promise<void>;
const listeners = new Set<Listener>();

export function onCrmEvent(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitCrmEvent(event: CrmEvent) {
  for (const listener of listeners) {
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error) => console.warn(`[crm-events] ${event.type} 监听器失败：${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      console.warn(`[crm-events] ${event.type} 监听器失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
