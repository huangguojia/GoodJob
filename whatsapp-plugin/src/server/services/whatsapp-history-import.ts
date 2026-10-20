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

/**
 * 两种行框架 + 戳内顺序无关的抠取：
 *   括号式：`[<戳>] 发送人: 正文` —— WhatsApp Web/手机导出；戳里时间与日期的先后、
 *           日期的年月日顺序、时段标记的位置（「上午8:55」「8:55 AM」「下午 12:30」）都可能不同；
 *   破折号式：`DD/MM/YYYY, HH:MM - 发送人: 正文` —— 安卓导出。
 *
 * 抠取顺序有讲究：先试「年在前」（`\d{4}[/.]…`），否则「2026/10/15」会被切成
 * 「26/10/15」—— 2026 年静默变成 2015 年。时钟不含 [/. ] 分隔符、日期不含冒号，
 * 两者互不误伤，顺序天然可分。
 */
function year(value: number): number {
  return value < 100 ? 2000 + value : value;
}

/** 「下午/PM」→ pm，「上午/AM」→ am，其它 → ""。 */
function dayPeriod(value: unknown): "am" | "pm" | "" {
  const text = String(value ?? "").toUpperCase();
  if (text === "PM" || text === "下午") return "pm";
  if (text === "AM" || text === "上午") return "am";
  return "";
}

/** 日月都 ≤12 时无法确定顺序，沿用 dateOrder 默认口径；>12 的那个暴露真实顺序。 */
function resolveDayMonth(first: number, second: number, dateOrder: WhatsAppDateOrder): { day: number; month: number } {
  const order = first > 12 ? "dmy" : second > 12 ? "mdy" : dateOrder;
  return { day: order === "mdy" ? second : first, month: order === "mdy" ? first : second };
}

function parseLine(line: string, dateOrder: WhatsAppDateOrder): ParsedWhatsAppMessage | null {
  const bracket = line.match(/^\[([^\]]+)\]\s*([^:]+):\s?(.*)$/u);
  const dash = bracket ? null : line.match(/^(\d{1,4}[/.]\d{1,2}[/.]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?)\s*[-–]\s*([^:]+):\s?(.*)$/u);
  if (!bracket && !dash) return null;
  const stamp = String((bracket ? bracket[1] : dash![1]) || "").trim();
  const sender = String(bracket ? bracket[2] : dash![2] || "").trim();
  const body = String(bracket ? bracket[3] : dash![3] || "").trim();

  const clock = stamp.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/u);
  if (!clock) return null;
  const period = dayPeriod(/(AM|PM|上午|下午)/iu.exec(stamp)?.[1]);

  let day: number;
  let month: number;
  let parsedYear: number;
  const ymd = stamp.match(/(\d{4})[/.](\d{1,2})[/.](\d{1,2})/u);
  if (ymd) {
    parsedYear = Number(ymd[1]);
    month = Number(ymd[2]);
    day = Number(ymd[3]);
  } else {
    const dmy = stamp.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/u);
    if (!dmy) return null;
    const resolved = resolveDayMonth(Number(dmy[1]), Number(dmy[2]), dateOrder);
    day = resolved.day;
    month = resolved.month;
    parsedYear = year(Number(dmy[3]));
  }

  let hour = Number(clock[1]);
  const minute = Number(clock[2]);
  const secondValue = Number(clock[3] || 0);
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const occurred = new Date(Date.UTC(parsedYear, month - 1, day, hour, minute, secondValue));
  if (occurred.getUTCFullYear() !== parsedYear || occurred.getUTCMonth() !== month - 1 || occurred.getUTCDate() !== day) return null;
  if (!sender) return null;
  return { occurredAt: occurred.toISOString(), sender, body };
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
    if (/^\[?\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}/u.test(line) || /^\[?\d{4}[/.]\d{1,2}[/.]\d{1,2},?\s+\d{1,2}:\d{2}/u.test(line)) {
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
