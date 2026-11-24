/**
 * 开发信发送总结：一轮开发信发完之后，按「实际发件邮箱」各生成一份 Excel，
 * 内容是这台邮箱发出去的公司清单 + 每家公司的背调 + 对应的开发信原文，
 * 再从这台邮箱发给它自己，方便每个发件箱各自对账。
 *
 * 关联口径（不新增数据库字段，历史批次也能补生成）：
 *  - 每封信的 requestId 固定为 `batch:{batchId}:{itemId}:{stepIndex}`（见 prospect-outreach-batch.ts sendItemStep）
 *  - outboundEmailLogs 按 requestId 就能拿到 senderEmail / messageId / 打开次数 / 回复时间
 *  - 背调按 (entityType, entityId) 取最新一条 background_research_records
 *
 * 本模块只做「数据整理 + Excel 渲染 + 邮件文案 + 幂等状态」，不依赖 server-core，
 * 发送动作与实体/背调查询由调用方注入，避免循环引用。
 */
import XLSX from "xlsx-js-style";
import { readJsonSetting, writeJsonSetting } from "./json-settings.js";
import type { OutboundEmailLog, ProspectOutreachBatch } from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface SummaryEntityDetail {
  company: string;
  country: string;
  website: string;
  business: string;
  contact: string;
  contactInfo: string;
  description: string;
  source: string;
}

export interface SummaryResearchFact {
  label: string;
  value: string;
  group: string;
  sourceUrl: string;
}

export interface SummaryResearch {
  score: number;
  verdict: string;
  summary: string;
  engine: string;
  createdAt: string;
  facts: SummaryResearchFact[];
  opportunities: string[];
  risks: Array<{ level: string; title: string; detail: string }>;
  keyPeople: Array<{ name: string; title: string; email: string; phone: string }>;
  sources: Array<{ title: string; url: string }>;
  nextAction: string;
  talkTracks: string[];
}

export interface SummaryLetter {
  index: number;
  subject: string;
  body: string;
  sentAt: string;
  messageId: string;
  openCount: number;
  clickCount: number;
  repliedAt: string;
  senderEmail: string;
}

export interface SummaryCustomer {
  itemId: string;
  entityId: string;
  entityKind: "candidate" | "lead" | "customer";
  company: string;
  country: string;
  website: string;
  business: string;
  contact: string;
  contactInfo: string;
  description: string;
  source: string;
  recipient: string;
  status: string;
  skipReason: string;
  letters: SummaryLetter[];
  research: SummaryResearch | null;
}

export interface OutreachSummaryGroup {
  senderEmail: string;
  mailboxLabel: string;
  customers: SummaryCustomer[];
  totals: { customers: number; letters: number; opened: number; replied: number; researched: number };
}

export interface CollectSummaryOptions {
  batch: ProspectOutreachBatch;
  logs: OutboundEmailLog[];
  primarySenderEmail: string;
  ownerName: string;
  loadEntity: (kind: "candidate" | "lead" | "customer", entityId: string) => Promise<SummaryEntityDetail | null>;
  loadResearch: (kind: "candidate" | "lead" | "customer", entityId: string) => Promise<unknown | null>;
  mailboxLabelFor?: (email: string) => string;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 单元格文本清洗：去掉控制字符、统一换行，避免 Excel 打开报错 */
function clean(value: unknown, max = 32_000): string {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
    .slice(0, max);
}

const oneLine = (value: unknown, max = 300) => clean(value, max).replace(/\s*\n+\s*/gu, " ").trim();

function timestampLabel(iso: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateStamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "00000000";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 背调载荷来自引擎，字段形态不完全稳定：能读多少读多少，读不到就当没有 */
export function normalizeResearch(raw: unknown): SummaryResearch | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const facts = Array.isArray(data.facts)
    ? data.facts.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const label = oneLine(row.label, 80);
      const value = oneLine(row.value, 600);
      if (!label && !value) return [];
      return [{ label, value, group: oneLine(row.group, 40), sourceUrl: oneLine(row.sourceUrl, 300) }];
    }).slice(0, 40)
    : [];
  const opportunities = Array.isArray(data.opportunities)
    ? data.opportunities.map((item) => oneLine(item, 400)).filter(Boolean).slice(0, 12)
    : [];
  const risks = Array.isArray(data.risks)
    ? data.risks.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const title = oneLine(row.title, 120);
      const detail = oneLine(row.detail, 600);
      if (!title && !detail) return [];
      return [{ level: oneLine(row.level, 20), title, detail }];
    }).slice(0, 12)
    : [];
  const keyPeople = Array.isArray(data.keyPeople)
    ? data.keyPeople.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const name = oneLine(row.name, 80);
      if (!name) return [];
      return [{
        name,
        title: oneLine(row.title, 120),
        email: oneLine(row.email, 160),
        phone: oneLine(row.phone, 60)
      }];
    }).slice(0, 12)
    : [];
  const sources = Array.isArray(data.sources)
    ? data.sources.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const url = oneLine(row.url, 400);
      const title = oneLine(row.title, 200);
      if (!url && !title) return [];
      return [{ title, url }];
    }).slice(0, 20)
    : [];
  const talkTracks = Array.isArray(data.talkTracks)
    ? data.talkTracks.map((item) => oneLine(item, 400)).filter(Boolean).slice(0, 10)
    : [];
  const score = Number(data.score || 0);
  const summary = clean(data.summary, 4000);
  const verdict = oneLine(data.verdict, 300);
  if (!facts.length && !opportunities.length && !summary && !verdict) return null;
  return {
    score: Number.isFinite(score) ? Math.round(score) : 0,
    verdict,
    summary,
    engine: oneLine(data.engine, 160),
    createdAt: oneLine(data.completedAt || data.createdAt, 40),
    facts,
    opportunities,
    risks,
    keyPeople,
    sources,
    nextAction: oneLine(data.nextAction, 600),
    talkTracks
  };
}

// ---------------------------------------------------------------------------
// 采集：批次 → 按发件邮箱分组
// ---------------------------------------------------------------------------

/**
 * 台账 request_id 有两种前缀：
 *  - 手工批次：batch:{batchId}:{itemId}:{stepIndex}
 *  - 自动发送方案：plan:{planId}:{itemId}:{stepIndex}（方案复用 batch 运行时分发）
 * 总结会按两种都找一次，历史数据不用改。
 */
export function summaryRequestIds(batchId: string, itemId: string, stepIndex: number) {
  return [`batch:${batchId}:${itemId}:${stepIndex}`, `plan:${batchId}:${itemId}:${stepIndex}`];
}

export async function collectOutreachSummaryGroups(options: CollectSummaryOptions): Promise<OutreachSummaryGroup[]> {
  const { batch } = options;
  const logsByRequest = new Map<string, OutboundEmailLog>();
  for (const log of options.logs) {
    if (log.requestId) logsByRequest.set(log.requestId, log);
  }

  const groups = new Map<string, OutreachSummaryGroup & { customerIds: Set<string> }>();
  const researchCache = new Map<string, SummaryResearch | null>();
  const entityCache = new Map<string, SummaryEntityDetail | null>();
  const primary = (options.primarySenderEmail || "").trim().toLowerCase();

  for (const item of batch.items) {
    const sentSteps = item.steps.filter((step) => step.status === "sent");
    if (!sentSteps.length) continue;
    const kind: "candidate" | "lead" | "customer" = item.entityType === "lead"
      ? "lead"
      : item.entityType === "customer"
        ? "customer"
        : "candidate";
    const entityId = kind === "lead" ? (item.leadId || item.candidateId) : item.candidateId;
    if (!entityId) continue;

    let detail = entityCache.get(`${kind}:${entityId}`);
    if (detail === undefined) {
      detail = await options.loadEntity(kind, entityId).catch(() => null);
      entityCache.set(`${kind}:${entityId}`, detail);
    }
    let research = researchCache.get(`${kind}:${entityId}`);
    if (research === undefined) {
      research = normalizeResearch(await options.loadResearch(kind, entityId).catch(() => null));
      researchCache.set(`${kind}:${entityId}`, research);
    }

    for (const step of sentSteps) {
      const log = summaryRequestIds(batch.id, item.id, step.index)
        .map((requestId) => logsByRequest.get(requestId))
        .find(Boolean);
      const senderEmail = (log?.senderEmail || primary || "").trim();
      const groupKey = senderEmail.toLowerCase();
      if (!groupKey) continue;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          senderEmail,
          mailboxLabel: options.mailboxLabelFor?.(senderEmail) || "",
          customers: [],
          totals: { customers: 0, letters: 0, opened: 0, replied: 0, researched: 0 },
          customerIds: new Set<string>()
        };
        groups.set(groupKey, group);
      }
      let customer = group.customers.find((row) => row.itemId === item.id);
      if (!customer) {
        customer = {
          itemId: item.id,
          entityId,
          entityKind: kind,
          company: oneLine(detail?.company || item.company, 200),
          country: oneLine(detail?.country, 80),
          website: oneLine(detail?.website, 300),
          business: oneLine(detail?.business || detail?.description, 400),
          contact: oneLine(detail?.contact, 120),
          contactInfo: oneLine(detail?.contactInfo, 300),
          description: clean(detail?.description, 2000),
          source: oneLine(detail?.source, 160),
          recipient: oneLine(item.recipient || log?.to, 200),
          status: item.status,
          skipReason: oneLine(item.skipReason, 300),
          letters: [],
          research
        };
        group.customers.push(customer);
        group.customerIds.add(item.id);
      }
      customer.letters.push({
        index: step.index,
        subject: oneLine(step.subject, 300),
        body: clean(step.body, 8000),
        sentAt: step.sentAt || log?.sentAt || "",
        messageId: log?.messageId || "",
        openCount: Number(log?.openCount || 0),
        clickCount: Number(log?.clickCount || 0),
        repliedAt: log?.repliedAt || "",
        senderEmail
      });
    }
  }

  return [...groups.values()].map((group) => {
    const customers = group.customers.sort((left, right) => {
      const a = left.letters[0]?.sentAt || "";
      const b = right.letters[0]?.sentAt || "";
      return a.localeCompare(b);
    });
    const letters = customers.reduce((sum, row) => sum + row.letters.length, 0);
    return {
      senderEmail: group.senderEmail,
      mailboxLabel: group.mailboxLabel,
      customers,
      totals: {
        customers: customers.length,
        letters,
        opened: customers.filter((row) => row.letters.some((letter) => letter.openCount > 0)).length,
        replied: customers.filter((row) => row.letters.some((letter) => letter.repliedAt)).length,
        researched: customers.filter((row) => Boolean(row.research)).length
      }
    };
  }).sort((left, right) => right.totals.letters - left.totals.letters);
}

// ---------------------------------------------------------------------------
// Excel 渲染
// ---------------------------------------------------------------------------

const BORDER_EDGE = { style: "thin", color: { rgb: "D8DEE9" } };
const CELL_BORDER = { top: BORDER_EDGE, bottom: BORDER_EDGE, left: BORDER_EDGE, right: BORDER_EDGE };
const HEADER_STYLE = {
  font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "1F4E79" } },
  alignment: { vertical: "center", horizontal: "center", wrapText: true },
  border: CELL_BORDER
};
const TITLE_STYLE = {
  font: { bold: true, sz: 14, color: { rgb: "1F4E79" } },
  alignment: { vertical: "center", horizontal: "left" }
};
const LABEL_STYLE = {
  font: { bold: true, sz: 10, color: { rgb: "44546A" } },
  fill: { fgColor: { rgb: "EAF0F7" } },
  alignment: { vertical: "center", horizontal: "left" },
  border: CELL_BORDER
};
const VALUE_STYLE = {
  font: { sz: 10, color: { rgb: "26313F" } },
  alignment: { vertical: "center", horizontal: "left", wrapText: true },
  border: CELL_BORDER
};
const BODY_STYLE = {
  font: { sz: 9, color: { rgb: "26313F" } },
  alignment: { vertical: "top", horizontal: "left", wrapText: true },
  border: CELL_BORDER
};
const NUMBER_STYLE = {
  font: { sz: 10, color: { rgb: "26313F" } },
  alignment: { vertical: "center", horizontal: "right" },
  border: CELL_BORDER
};

function put(sheet: XLSX.WorkSheet, row: number, col: number, value: string | number, style?: Record<string, unknown>) {
  const address = XLSX.utils.encode_cell({ r: row, c: col });
  const type = typeof value === "number" ? "n" : "s";
  const cell = (sheet[address] || {}) as Record<string, unknown>;
  cell.t = type;
  cell.v = value;
  if (style) cell.s = style;
  sheet[address] = cell;
}

function writeRow(sheet: XLSX.WorkSheet, row: number, values: Array<string | number>, style: Record<string, unknown>) {
  values.forEach((value, col) => put(sheet, row, col, value, style));
}

/** 表头 + 数据行：统一字体、边框、列宽、冻结首行 */
function buildTableSheet(input: {
  title: string;
  headers: string[];
  widths: number[];
  rows: Array<Array<string | number>>;
  numericCols?: number[];
}) {
  const aoa: Array<Array<string | number>> = [
    [input.title],
    input.headers,
    ...input.rows
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!cols"] = input.widths.map((wch) => ({ wch }));
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, input.headers.length - 1) } }];
  put(sheet, 0, 0, input.title, TITLE_STYLE);
  for (let col = 0; col < input.headers.length; col += 1) {
    put(sheet, 1, col, input.headers[col]!, HEADER_STYLE);
  }
  const numeric = new Set(input.numericCols || []);
  input.rows.forEach((values, index) => {
    values.forEach((value, col) => {
      put(sheet, index + 2, col, value, numeric.has(col) ? NUMBER_STYLE : BODY_STYLE);
    });
  });
  return sheet;
}

export function renderOutreachSummaryWorkbook(input: {
  batch: ProspectOutreachBatch;
  group: OutreachSummaryGroup;
  ownerName: string;
  generatedAt?: string;
}): Buffer {
  const generatedAt = input.generatedAt || new Date().toISOString();
  const { group, batch } = input;
  const workbook = XLSX.utils.book_new();

  // ── 1. 发送汇总 ──
  const overview = XLSX.utils.aoa_to_sheet([[`开发信发送总结 · ${group.senderEmail}`]]);
  overview["!cols"] = [{ wch: 20 }, { wch: 62 }];
  overview["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  put(overview, 0, 0, `开发信发送总结 · ${group.senderEmail}`, TITLE_STYLE);
  const facts: Array<[string, string | number]> = [
    ["发件邮箱", group.senderEmail],
    ["邮箱备注", group.mailboxLabel || "—"],
    ["负责人", input.ownerName || "—"],
    ["发信批次", batch.id],
    ["批次创建时间", timestampLabel(batch.createdAt)],
    ["总结生成时间", timestampLabel(generatedAt)],
    ["覆盖客户", group.totals.customers],
    ["发出信件", group.totals.letters],
    ["已打开客户", group.totals.opened],
    ["已回复客户", group.totals.replied],
    ["有背调客户", group.totals.researched]
  ];
  facts.forEach(([label, value], index) => {
    put(overview, index + 2, 0, label, LABEL_STYLE);
    put(overview, index + 2, 1, value, typeof value === "number" ? NUMBER_STYLE : VALUE_STYLE);
  });
  // aoa_to_sheet 只按初始一行算 !ref；后面逐格写入必须自己扩范围，否则 Excel 打开只显示标题。
  // 标题占第 1 行、空一行后从第 3 行写起，最后一行 = facts.length + 2（1-based）
  overview["!ref"] = `A1:B${facts.length + 2}`;
  XLSX.utils.book_append_sheet(workbook, overview, "发送汇总");

  // ── 2. 客户清单 ──
  const customerRows = group.customers.map((customer, index) => {
    const firstLetter = customer.letters[0];
    return [
      index + 1,
      customer.company || "—",
      customer.country || "—",
      customer.website || "—",
      customer.business || "—",
      customer.contact || "—",
      customer.contactInfo || "—",
      customer.recipient || "—",
      customer.source || "—",
      customer.research ? customer.research.score : "—",
      customer.research?.verdict || "—",
      customer.letters.length,
      timestampLabel(firstLetter?.sentAt || ""),
      customer.letters.reduce((sum, letter) => sum + letter.openCount, 0),
      customer.letters.some((letter) => letter.repliedAt) ? "已回复" : "未回复",
      customer.letters.map((letter) => letter.subject).filter(Boolean).join(" / ") || "—"
    ];
  });
  XLSX.utils.book_append_sheet(workbook, buildTableSheet({
    title: "客户清单（本邮箱发出的每一家）",
    headers: ["序号", "公司", "国家", "网站", "主营业务", "联系人", "联系方式", "收件邮箱", "来源", "背调评分", "背调结论", "发送封数", "首封时间", "打开次数", "回复状态", "信件主题"],
    widths: [6, 28, 12, 26, 34, 14, 26, 26, 16, 10, 36, 10, 18, 10, 10, 42],
    rows: customerRows,
    numericCols: [0, 9, 11, 13]
  }), "客户清单");

  // ── 3. 背调详情 ──
  const researchRows = group.customers.map((customer, index) => {
    const research = customer.research;
    const factText = research
      ? research.facts.map((fact) => `${fact.group ? `[${fact.group}] ` : ""}${fact.label}：${fact.value}`).join("\n")
      : "";
    const riskText = research
      ? research.risks.map((risk) => `${risk.level ? `(${risk.level}) ` : ""}${risk.title}${risk.detail ? `：${risk.detail}` : ""}`).join("\n")
      : "";
    const peopleText = research
      ? research.keyPeople.map((person) => [person.name, person.title, person.email, person.phone].filter(Boolean).join(" · ")).join("\n")
      : "";
    const sourceText = research
      ? research.sources.map((source) => [source.title, source.url].filter(Boolean).join(" — ")).join("\n")
      : "";
    return [
      index + 1,
      customer.company || "—",
      customer.country || "—",
      research ? research.score : "—",
      research?.verdict || "—",
      research?.summary || "未找到这家公司的背调留档",
      factText || "—",
      research ? research.opportunities.join("\n") || "—" : "—",
      riskText || "—",
      peopleText || "—",
      research?.nextAction || "—",
      research ? research.talkTracks.join("\n") || "—" : "—",
      sourceText || "—",
      research?.engine || "—",
      research ? timestampLabel(research.createdAt) : "—"
    ];
  });
  XLSX.utils.book_append_sheet(workbook, buildTableSheet({
    title: "背调详情（每家公司调查到了什么）",
    headers: ["序号", "公司", "国家", "评分", "结论", "摘要", "关键事实", "可用机会点", "风险", "关键人", "建议下一步", "话术切入点", "信息来源", "背调引擎", "背调时间"],
    widths: [6, 26, 12, 8, 31, 52, 56, 46, 40, 38, 40, 40, 46, 22, 18],
    rows: researchRows,
    numericCols: [0, 3]
  }), "背调详情");

  // ── 4. 开发信原文 ──
  const letterRows: Array<Array<string | number>> = [];
  let letterIndex = 0;
  for (const customer of group.customers) {
    for (const letter of customer.letters) {
      letterIndex += 1;
      letterRows.push([
        letterIndex,
        customer.company || "—",
        customer.recipient || "—",
        letter.index + 1,
        letter.subject || "—",
        timestampLabel(letter.sentAt),
        letter.openCount,
        letter.repliedAt ? "已回复" : "未回复",
        letter.body || "—"
      ]);
    }
  }
  XLSX.utils.book_append_sheet(workbook, buildTableSheet({
    title: "开发信原文（这家客户收到的那几封）",
    headers: ["序号", "公司", "收件人", "第几封", "主题", "发送时间", "打开次数", "回复状态", "正文"],
    widths: [6, 26, 26, 8, 46, 18, 10, 10, 110],
    rows: letterRows,
    numericCols: [0, 3, 6]
  }), "开发信原文");

  // xlsx 在不同运行时的 type:"buffer" 可能给 Buffer 或 Uint8Array，统一成 Buffer 再交给 nodemailer
  return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", compression: true }) as Uint8Array);
}

// ---------------------------------------------------------------------------
// 邮件内容
// ---------------------------------------------------------------------------

export function summaryFileName(senderEmail: string, batchId: string) {
  const local = (senderEmail.split("@")[0] || "mailbox").replace(/[^\w.-]+/gu, "-").slice(0, 24);
  const shortBatch = batchId.replace(/[^\w-]+/gu, "").slice(-8) || "batch";
  return `开发信发送总结_${local}_${dateStamp(new Date().toISOString())}_${shortBatch}.xlsx`;
}

export function buildOutreachSummaryEmail(input: {
  batch: ProspectOutreachBatch;
  group: OutreachSummaryGroup;
  ownerName: string;
  fileName: string;
  generatedAt?: string;
}) {
  const { group } = input;
  const generatedAt = input.generatedAt || new Date().toISOString();
  const subject = `开发信发送总结 · ${group.totals.customers} 家客户 / ${group.totals.letters} 封（${dateStamp(generatedAt).replace(/(\d{4})(\d{2})(\d{2})/u, "$1-$2-$3")}）`;
  const text = [
    `这轮开发信已发送完毕，本邮箱（${group.senderEmail}）发出 ${group.totals.letters} 封，覆盖 ${group.totals.customers} 家公司。`,
    "",
    `已打开：${group.totals.opened} 家`,
    `已回复：${group.totals.replied} 家`,
    `有背调：${group.totals.researched} 家`,
    "",
    `明细见附件「${input.fileName}」：客户清单 / 背调详情 / 开发信原文。`,
    "",
    `— GoodJob CRM 自动生成 · ${timestampLabel(generatedAt)}`
  ].join("\n");
  const rows = group.customers.slice(0, 12).map((customer) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eef1f6">${escapeHtml(customer.company || "—")}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eef1f6">${escapeHtml(customer.country || "—")}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eef1f6;text-align:center">${customer.research ? customer.research.score : "—"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eef1f6;text-align:center">${customer.letters.length}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eef1f6;text-align:center">${customer.letters.some((letter) => letter.repliedAt) ? "已回复" : customer.letters.some((letter) => letter.openCount > 0) ? "已打开" : "未读"}</td>
    </tr>`).join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#26313f;line-height:1.6;max-width:720px">
    <h2 style="margin:0 0 6px;font-size:18px;color:#1f4e79">开发信发送总结</h2>
    <p style="margin:0 0 16px;color:#66748a;font-size:13px">${escapeHtml(group.senderEmail)} · ${escapeHtml(input.ownerName || "—")} · ${escapeHtml(timestampLabel(generatedAt))}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:13px">
      <tr>
        <td style="padding:10px 12px;background:#f5f8fc;border-radius:6px 0 0 6px"><b style="font-size:18px;color:#1f4e79">${group.totals.customers}</b><br><span style="color:#66748a">家公司</span></td>
        <td style="padding:10px 12px;background:#f5f8fc"><b style="font-size:18px;color:#1f4e79">${group.totals.letters}</b><br><span style="color:#66748a">封信</span></td>
        <td style="padding:10px 12px;background:#f5f8fc"><b style="font-size:18px;color:#1f4e79">${group.totals.opened}</b><br><span style="color:#66748a">家已打开</span></td>
        <td style="padding:10px 12px;background:#f5f8fc;border-radius:0 6px 6px 0"><b style="font-size:18px;color:#b45309">${group.totals.replied}</b><br><span style="color:#66748a">家已回复</span></td>
      </tr>
    </table>
    ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
      <thead><tr style="background:#1f4e79;color:#fff">
        <th style="padding:7px 10px;text-align:left">公司</th>
        <th style="padding:7px 10px;text-align:left">国家</th>
        <th style="padding:7px 10px;text-align:center">背调</th>
        <th style="padding:7px 10px;text-align:center">信件</th>
        <th style="padding:7px 10px;text-align:center">状态</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>` : ""}
    <p style="margin:0 0 8px;font-size:13px">完整明细在附件：客户清单、背调详情、开发信原文。</p>
    <p style="margin:16px 0 0;color:#8b98ab;font-size:12px">GoodJob CRM 自动生成，不需要回复这封邮件。</p>
  </div>`;
  return { subject, text, html };
}

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

// ---------------------------------------------------------------------------
// 幂等状态：同一批次同一邮箱只成功发一次
// ---------------------------------------------------------------------------

export interface OutreachSummaryDelivery {
  senderEmail: string;
  status: "sent" | "failed";
  at: string;
  fileName: string;
  messageId: string;
  error: string;
  attempts: number;
  customers: number;
  letters: number;
}

export interface OutreachSummaryState {
  batchId: string;
  updatedAt: string;
  deliveries: OutreachSummaryDelivery[];
}

const summaryStateKey = (teamId: string, batchId: string) => `outreach.summary:${teamId}:${batchId}`;

export async function readOutreachSummaryState(teamId: string, batchId: string): Promise<OutreachSummaryState> {
  const stored = await readJsonSetting<Partial<OutreachSummaryState>>(summaryStateKey(teamId, batchId), {});
  return {
    batchId,
    updatedAt: String(stored.updatedAt || ""),
    deliveries: Array.isArray(stored.deliveries) ? stored.deliveries : []
  };
}

export async function writeOutreachSummaryState(teamId: string, batchId: string, state: OutreachSummaryState) {
  await writeJsonSetting(summaryStateKey(teamId, batchId), { ...state, batchId, updatedAt: new Date().toISOString() });
}

export function summaryMailboxSettingsKey(teamId: string) {
  return `outreach.summary.settings:${teamId}`;
}

export interface OutreachSummarySettings {
  /** 批次发完后自动给每个发件邮箱各发一份 */
  autoSend: boolean;
}

export const DEFAULT_OUTREACH_SUMMARY_SETTINGS: OutreachSummarySettings = { autoSend: true };

export async function readOutreachSummarySettings(teamId: string): Promise<OutreachSummarySettings> {
  const stored = await readJsonSetting<Partial<OutreachSummarySettings>>(summaryMailboxSettingsKey(teamId), {});
  return { ...DEFAULT_OUTREACH_SUMMARY_SETTINGS, ...(stored || {}) };
}
