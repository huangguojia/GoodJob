import type { CrmClient } from "./crm-client.js";
import { normalizePhone } from "./crm-client.js";

/**
 * 「结合 CRM」的那一半：把**客户往来历史**与**知识检索命中**变成模型能用的事实。
 *
 * 三条纪律：
 * 1. **只读、只取事实**。这里不生成任何文案，生成的活儿归提示词与模型。
 * 2. **任何一步失败都不许把整条回复链带下去**。CRM 没开会话、某个接口 500，结果都是
 *    「这次没有这块依据」，而不是「自动回复坏了」——错误收进 `errors[]` 如实上报。
 * 3. **上限写死**。客户可能有几百条跟进，全塞进提示词只会把真正相关的那几条挤掉、还更贵。
 */

/** 客户档案只取最近这几条跟进；再往前的对「回这条消息」没有帮助。 */
export const MAX_ACTIVITIES = 8;
export const MAX_QUOTES = 6;
export const MAX_KNOWLEDGE = 5;
/** 单条正文截断长度：报价单原文/长邮件会把提示词撑爆。 */
export const MAX_FIELD_CHARS = 400;

export interface CrmCustomerBrief {
  id: string;
  company: string;
  contact: string;
  country: string;
  stage: string;
  grade: string;
  ownerName: string;
  lifecycleStatus: string;
  pipelineStage: string;
  pipelineAmount: number;
  activeDealCount: number;
  wonDealCount: number;
  lastActivityAt: string;
}

export interface CrmActivity {
  type: string;
  content: string;
  at: string;
  operator: string;
}

export interface CrmQuote {
  documentNumber: string;
  documentType: string;
  totalAmount: number;
  currency: string;
  quotedAt: string;
  items: string[];
}

export interface CrmKnowledge {
  title: string;
  module: string;
  summary: string;
  content: string;
  score: number;
}

export interface CrmContext {
  /** 这个 WhatsApp 会话是靠什么认到 CRM 客户的 —— 认不到就**不要**硬套一个近似客户。 */
  matchedBy: "phone" | "name" | "none";
  customer: CrmCustomerBrief | null;
  activities: CrmActivity[];
  quotes: CrmQuote[];
  knowledge: CrmKnowledge[];
  errors: string[];
}

export function emptyCrmContext(reason = ""): CrmContext {
  return {
    matchedBy: "none",
    customer: null,
    activities: [],
    quotes: [],
    knowledge: [],
    errors: reason ? [reason] : []
  };
}

export interface CrmContextInput {
  phone?: string;
  displayName?: string;
  /** 知识检索用的查询词，通常是客户最新那条消息。 */
  query: string;
}

function text(value: unknown, maximum = MAX_FIELD_CHARS): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 只有客户本人（owner）才能看到号码 —— CRM 侧就是这么裁剪的，这里跟着一起裁。 */
function customerPhone(row: Record<string, unknown>): string {
  return normalizePhone(text(row.whatsappPhone) || text(row.whatsapp));
}

function briefOf(row: Record<string, unknown>): CrmCustomerBrief {
  return {
    id: text(row.id, 64),
    company: text(row.company, 120),
    contact: text(row.contact, 80),
    country: text(row.country, 80),
    stage: text(row.stage, 40),
    grade: text(row.grade, 8),
    ownerName: text(row.ownerName, 60),
    lifecycleStatus: text(row.lifecycleStatus, 20),
    pipelineStage: text(row.pipelineStage, 40),
    pipelineAmount: number(row.pipelineAmount),
    activeDealCount: number(row.activeDealCount),
    wonDealCount: number(row.wonDealCount),
    lastActivityAt: text(row.lastActivityAt, 40)
  };
}

/**
 * 认客户：**先号码、后名字**，都不中就返回 none。
 *
 * 刻意不做模糊匹配（比如公司名相似度）——把 A 客户的历史安到 B 客户头上，
 * 比"没有 CRM 依据"危险得多：模型会拿错的历史去回话，人还看不出问题在哪。
 */
export function matchCustomer(
  customers: unknown[],
  input: { phone?: string; displayName?: string }
): { row: Record<string, unknown>; matchedBy: "phone" | "name" } | null {
  const target = normalizePhone(input.phone);
  if (target) {
    for (const raw of customers) {
      const row = recordOf(raw);
      if (customerPhone(row) === target) return { row, matchedBy: "phone" };
    }
  }
  const name = text(input.displayName, 120).toLowerCase();
  if (!name) return null;
  for (const raw of customers) {
    const row = recordOf(raw);
    const candidates = [text(row.contact, 120).toLowerCase(), text(row.company, 160).toLowerCase()].filter(Boolean);
    if (candidates.includes(name)) return { row, matchedBy: "name" };
  }
  return null;
}

export function activitiesOf(row: Record<string, unknown>, limit = MAX_ACTIVITIES): CrmActivity[] {
  return arrayOf(row.activities)
    .map((raw) => {
      const item = recordOf(raw);
      return {
        type: text(item.type, 30),
        content: text(item.content),
        at: text(item.createdAt, 40),
        operator: text(item.operatorName, 60)
      };
    })
    .filter((item) => item.content)
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, limit);
}

export function quotesOf(records: unknown[], limit = MAX_QUOTES): CrmQuote[] {
  return records
    .map((raw) => {
      const item = recordOf(raw);
      return {
        documentNumber: text(item.documentNumber, 60),
        documentType: text(item.documentType, 40),
        totalAmount: number(item.totalAmount),
        currency: text(item.currency, 8),
        quotedAt: text(item.quotedAt, 40),
        items: arrayOf(item.items)
          .slice(0, 8)
          .map((entry) => {
            const line = recordOf(entry);
            const parts = [text(line.product, 80), text(line.model, 60)].filter(Boolean);
            return parts.join(" / ");
          })
          .filter(Boolean)
      };
    })
    .filter((item) => item.documentNumber || item.items.length)
    .slice(0, limit);
}

export function knowledgeOf(hits: unknown[], limit = MAX_KNOWLEDGE): CrmKnowledge[] {
  return hits
    .map((raw) => {
      const hit = recordOf(raw);
      const document = recordOf(hit.document);
      return {
        title: text(document.title, 160),
        module: text(document.module, 60),
        summary: text(document.summary, 300),
        content: text(document.content, 600),
        score: Math.round(number(hit.score) * 100) / 100
      };
    })
    .filter((item) => item.title || item.content)
    .slice(0, limit);
}

/**
 * 取齐 CRM 依据。**永不抛错**：三个数据源各自 try/catch，失败只往 `errors` 里记一笔。
 * 调用方拿到的东西一定有 `customer: null` 或几条真实记录，不会是异常。
 */
export async function buildCrmContext(
  client: CrmClient | undefined,
  ownerUserId: string,
  input: CrmContextInput
): Promise<CrmContext> {
  if (!client) return emptyCrmContext("插件未接入 CRM 通道");
  if (!client.configured) return emptyCrmContext(client.unavailableReason());

  const context = emptyCrmContext();
  const query = text(input.query, 200);

  try {
    const payload = recordOf(await client.getJson(ownerUserId, "/api/customers", { query: { scope: "mine" } }));
    const matched = matchCustomer(arrayOf(payload.customers), input);
    if (matched) {
      context.matchedBy = matched.matchedBy;
      context.customer = briefOf(matched.row);
      context.activities = activitiesOf(matched.row);
      try {
        const quotes = recordOf(
          await client.getJson(ownerUserId, "/api/quote-history", {
            query: { customerId: context.customer.id, pageSize: MAX_QUOTES }
          })
        );
        context.quotes = quotesOf(arrayOf(quotes.records));
      } catch (error) {
        context.errors.push(error instanceof Error ? error.message : "读取报价历史失败");
      }
    } else {
      context.errors.push(
        input.phone || input.displayName ? "CRM 里没有匹配到这个客户的档案" : "现场对话里没有可用来认客户的号码或名字"
      );
    }
  } catch (error) {
    context.errors.push(error instanceof Error ? error.message : "读取 CRM 客户列表失败");
  }

  if (query) {
    try {
      const payload = recordOf(
        await client.getJson(ownerUserId, "/api/agent/knowledge/search", {
          query: { query, limit: MAX_KNOWLEDGE }
        })
      );
      context.knowledge = knowledgeOf(arrayOf(payload.hits));
    } catch (error) {
      context.errors.push(error instanceof Error ? error.message : "知识检索失败");
    }
  }

  return context;
}

/** 提示词里不许出现客户看得懂之外的东西 —— 内部字段名、评分、训练库这些都不能漏出去。 */
export function crmContextSystemLines(context: CrmContext): string[] {
  if (context.matchedBy === "none" && !context.knowledge.length) return [];
  const lines = [
    "Customer facts retrieved from the team CRM and knowledge base (this is the ONLY customer history you may rely on):"
  ];
  if (context.matchedBy === "none") {
    lines.push("- No CRM record matched this contact: do NOT invent any order, quote, deadline or commitment.");
  } else {
    const customer = context.customer!;
    lines.push(
      `- Matched CRM record: ${customer.company || "(no company)"}` +
        `${customer.contact ? `, contact ${customer.contact}` : ""}` +
        `${customer.country ? `, ${customer.country}` : ""}` +
        `${customer.stage ? `, stage ${customer.stage}` : ""}` +
        `${customer.grade ? `, grade ${customer.grade}` : ""}`
    );
    if (customer.wonDealCount || customer.activeDealCount) {
      lines.push(
        `- Deals: ${customer.activeDealCount} active (${customer.pipelineStage || "unknown stage"}), ` +
          `${customer.wonDealCount} won`
      );
    }
    if (context.activities.length) {
      lines.push("- Recent follow-ups (newest first):");
      for (const activity of context.activities) {
        lines.push(`  - ${activity.at.slice(0, 10)} [${activity.type || "note"}] ${activity.content}`);
      }
    }
    if (context.quotes.length) {
      lines.push("- Quote history (the customer may refer to these):");
      for (const quote of context.quotes) {
        const items = quote.items.length ? ` — ${quote.items.join("; ")}` : "";
        lines.push(
          `  - ${quote.quotedAt.slice(0, 10)} ${quote.documentType || "quote"} ` +
            `${quote.documentNumber} ${quote.totalAmount} ${quote.currency}${items}`
        );
      }
    }
  }
  if (context.knowledge.length) {
    lines.push("- Knowledge base excerpts that may answer the question:");
    for (const hit of context.knowledge) {
      lines.push(`  - ${hit.title}: ${hit.summary || hit.content}`);
    }
  }
  lines.push(
    "Quote figures and shipment details above are history, not offers: never restate them as a new commitment",
    "and never turn a past price into a current one. If the answer is not in the facts above, say you will confirm."
  );
  return lines;
}

export interface CrmContextPayload {
  matchedBy: CrmContext["matchedBy"];
  customer: CrmCustomerBrief | null;
  recentFollowUps: Array<{ at: string; type: string; content: string }>;
  quoteHistory: Array<{ at: string; document: string; amount: string; items: string[] }>;
  knowledge: Array<{ title: string; module: string; content: string }>;
}

/** 给模型看的结构化载荷。刻意比 system 那段更"干"：这里是数据，那里是规矩。 */
export function crmContextPayload(context: CrmContext): CrmContextPayload | null {
  if (context.matchedBy === "none" && !context.knowledge.length) return null;
  return {
    matchedBy: context.matchedBy,
    customer: context.customer,
    recentFollowUps: context.activities.map((item) => ({ at: item.at, type: item.type, content: item.content })),
    quoteHistory: context.quotes.map((item) => ({
      at: item.quotedAt,
      document: [item.documentType, item.documentNumber].filter(Boolean).join(" "),
      amount: `${item.totalAmount} ${item.currency}`.trim(),
      items: item.items
    })),
    knowledge: context.knowledge.map((item) => ({
      title: item.title,
      module: item.module,
      content: item.summary || item.content
    }))
  };
}
