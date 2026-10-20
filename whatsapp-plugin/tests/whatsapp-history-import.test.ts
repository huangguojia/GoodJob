import { describe, expect, it } from "vitest";
import { historyMessageId, parseWhatsAppHistory, previewWhatsAppHistory } from "../src/server/services/whatsapp-history-import";

describe("WhatsApp history import parser", () => {
  it("parses bracket and dash exports with multiline messages", () => {
    const content = [
      "[08/08/2026, 23:33:00] Maria Garcia: Please send your best FOB price.",
      "This is still part of the same message.",
      "[08/08/2026, 23:34:00] Messages and calls are end-to-end encrypted.",
      "09/08/2026, 00:33 - Admin: I will prepare the quotation."
    ].join("\n");
    const parsed = parseWhatsAppHistory(content, "dmy");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({ sender: "Maria Garcia", occurredAt: "2026-08-08T23:33:00.000Z" });
    expect(parsed.messages[0].body).toContain("same message");
    expect(parsed.messages[1]).toMatchObject({ sender: "Admin", occurredAt: "2026-08-09T00:33:00.000Z" });
    expect(parsed.skippedLines).toBe(1);
  });

  it("supports month-first exports and returns participants", () => {
    const content = "[8/9/26, 3:15 PM] Buyer: Can we meet tomorrow?\n[8/9/26, 3:16 PM] Sales: Yes.";
    const preview = previewWhatsAppHistory(content, "mdy");
    expect(preview).toMatchObject({ messageCount: 2, participants: ["Buyer", "Sales"] });
    expect(preview.firstMessageAt).toBe("2026-08-09T15:15:00.000Z");
  });

  // 中文区域导出是「年在前」格式：按日月年在前解析会把 2026 错切成 2015（「26/10/15」）。
  it("parses year-first exports without corrupting the year", () => {
    const content = [
      "[2026/10/15, 08:55] +86 181 6320 1984: 你好",
      "[2026/10/15, 20:05] +86 181 6320 1984: 下午好"
    ].join("\n");
    const parsed = parseWhatsAppHistory(content);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({ sender: "+86 181 6320 1984", occurredAt: "2026-10-15T08:55:00.000Z" });
    expect(parsed.messages[1]).toMatchObject({ occurredAt: "2026-10-15T20:05:00.000Z" });
  });

  // 中文时段可以写在时间前后（「上午8:55」「8:55 下午」都出现在真机导出里）。
  it("understands Chinese day-period markers", () => {
    const content = [
      "[上午8:55, 15/10/2026] Buyer: hi",
      "[2026/10/15, 下午12:30] Buyer: noon",
      "[2026/10/15, 上午12:30] Buyer: midnight"
    ].join("\n");
    const parsed = parseWhatsAppHistory(content);
    expect(parsed.messages.map((message) => message.occurredAt)).toEqual([
      "2026-10-15T08:55:00.000Z",
      "2026-10-15T12:30:00.000Z",
      "2026-10-15T00:30:00.000Z"
    ]);
  });

  it("creates stable idempotency keys", () => {
    const message = { occurredAt: "2026-08-09T15:15:00.000Z", sender: "Buyer", body: "Hello" };
    const first = historyMessageId({ accountId: "account", phone: "+491234567890", message });
    const second = historyMessageId({ accountId: "account", phone: "+491234567890", message });
    expect(first).toBe(second);
    expect(first).toMatch(/^history:[a-f0-9]{64}$/u);
  });
});
