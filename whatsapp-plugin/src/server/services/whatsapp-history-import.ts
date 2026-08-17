import { createHash } from "node:crypto";

export type WhatsAppDateOrder = "dmy" | "mdy";

export interface ParsedWhatsAppMessage {
  occurredAt: string;
  sender: string;
  body: string;
}

export interface WhatsAppHistoryPreview {
  messageCount: number;
  skippedLines: number;
  participants: string[];
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  sample: ParsedWhatsAppMessage[];
}

const linePatterns = [
  /^\[(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\]\s*([^:]+):\s?(.*)$/iu,
  /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*[-–]\s*([^:]+):\s?(.*)$/iu
];

function year(value: number): number {
  return value < 100 ? 2000 + value : value;
}

function parseLine(line: string, dateOrder: WhatsAppDateOrder): ParsedWhatsAppMessage | null {
  const match = linePatterns.map((pattern) => line.match(pattern)).find(Boolean);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const parsedYear = year(Number(match[3]));
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const secondValue = Number(match[6] || 0);
  const meridiem = String(match[7] || "").toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  const day = dateOrder === "dmy" ? first : second;
  const month = dateOrder === "dmy" ? second : first;
  const occurred = new Date(Date.UTC(parsedYear, month - 1, day, hour, minute, secondValue));
  if (occurred.getUTCFullYear() !== parsedYear || occurred.getUTCMonth() !== month - 1 || occurred.getUTCDate() !== day) return null;
  const sender = String(match[8] || "").trim();
  if (!sender) return null;
  return { occurredAt: occurred.toISOString(), sender, body: String(match[9] || "").trim() };
}

export function parseWhatsAppHistory(content: string, dateOrder: WhatsAppDateOrder = "dmy"): { messages: ParsedWhatsAppMessage[]; skippedLines: number } {
  const messages: ParsedWhatsAppMessage[] = [];
  let skippedLines = 0;
  for (const rawLine of content.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const parsed = parseLine(line, dateOrder);
    if (parsed) {
      messages.push(parsed);
      continue;
    }
    if (/^\[?\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}/u.test(line)) {
      skippedLines += 1;
      continue;
    }
    const previous = messages.at(-1);
    if (previous) previous.body = `${previous.body}\n${line}`.trim();
    else skippedLines += 1;
  }
  return { messages, skippedLines };
}

export function previewWhatsAppHistory(content: string, dateOrder: WhatsAppDateOrder = "dmy"): WhatsAppHistoryPreview {
  const { messages, skippedLines } = parseWhatsAppHistory(content, dateOrder);
  const participants = [...new Set(messages.map((message) => message.sender))];
  return {
    messageCount: messages.length,
    skippedLines,
    participants,
    firstMessageAt: messages[0]?.occurredAt ?? null,
    lastMessageAt: messages.at(-1)?.occurredAt ?? null,
    sample: messages.slice(0, 5)
  };
}

export function historyMessageId(input: { accountId: string; phone: string; message: ParsedWhatsAppMessage }): string {
  const digest = createHash("sha256")
    .update([input.accountId, input.phone, input.message.occurredAt, input.message.sender, input.message.body].join("\u0000"))
    .digest("hex");
  return `history:${digest}`;
}
