import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/shared/types";
import { isSummarizable, selectDayMessages } from "../src/server/services/followup-sync";

/**
 * 插件侧剩余职责的自测（2026-10-15 起「结论在 CRM 做」）：
 * 插件只负责扫描会话库、按时区挑出当天的消息、打包推给 CRM。
 * 内容生成/客户匹配/写跟进的判据测试在 `backend/src/whatsapp-followup-sync-test.ts`。
 */

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? "m1",
    accountId: "a1",
    conversationId: "v1",
    providerMessageId: null,
    clientMessageId: null,
    direction: overrides.direction ?? "inbound",
    messageType: overrides.messageType ?? "text",
    body: overrides.body ?? "hello",
    status: "delivered",
    sourceLanguage: null,
    occurredAt: overrides.occurredAt ?? "2026-08-09T01:05:00.000Z",
    createdAt: overrides.occurredAt ?? "2026-08-09T01:05:00.000Z",
    revokedAt: overrides.revokedAt ?? null,
    media: null,
    translations: []
  };
}

describe("哪些消息不该进摘要", () => {
  it("系统消息与已撤回消息不算「聊了什么」", () => {
    expect(isSummarizable(message({ messageType: "system", body: "加入了群组" }))).toBe(false);
    expect(isSummarizable(message({ revokedAt: "2026-08-09T02:00:00.000Z" }))).toBe(false);
    expect(isSummarizable(message({ body: "   " }))).toBe(false);
    expect(isSummarizable(message({ body: "Please quote 500 pcs" }))).toBe(true);
  });
});

describe("按业务员时区挑当天消息", () => {
  it("UTC 的 8月9日 15:30 在上海已是 8月9日 23:30，但在纽约还是 8月9日 11:30", () => {
    const messages = [
      message({ id: "m1", occurredAt: "2026-08-09T15:30:00.000Z" }),
      // UTC 8月9日 16:30 = 上海 8月10日 00:30 → 属于 8月10日
      message({ id: "m2", occurredAt: "2026-08-09T16:30:00.000Z" })
    ];
    expect(selectDayMessages(messages, "Asia/Shanghai", "2026-08-09").map((item) => item.id)).toEqual(["m1"]);
    expect(selectDayMessages(messages, "Asia/Shanghai", "2026-08-10").map((item) => item.id)).toEqual(["m2"]);
  });

  it("系统消息与撤回的消息在按时区挑选时一并剔除", () => {
    const messages = [
      message({ id: "m1", body: "请报价" }),
      message({ id: "m2", messageType: "system", body: "加入了群组" }),
      message({ id: "m3", revokedAt: "2026-08-09T02:00:00.000Z", body: "撤回的消息" })
    ];
    expect(selectDayMessages(messages, "Asia/Shanghai", "2026-08-09").map((item) => item.id)).toEqual(["m1"]);
  });
});
