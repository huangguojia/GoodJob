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

  it("creates stable idempotency keys", () => {
    const message = { occurredAt: "2026-08-09T15:15:00.000Z", sender: "Buyer", body: "Hello" };
    const first = historyMessageId({ accountId: "account", phone: "+491234567890", message });
    const second = historyMessageId({ accountId: "account", phone: "+491234567890", message });
    expect(first).toBe(second);
    expect(first).toMatch(/^history:[a-f0-9]{64}$/u);
  });
});
