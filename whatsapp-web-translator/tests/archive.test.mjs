/**
 * 归档层单测：时间戳解析、消息归一化、组装与三种导出格式。
 * 纯函数，不碰浏览器、不连网络。跑法：node tests/archive.test.mjs
 */

import {
  ARCHIVE_VERSION,
  archiveFileName,
  buildArchive,
  buildMessage,
  extractMessageText,
  isArchivable,
  mergeArchives,
  parsePrePlainText,
  renderArchive,
  renderArchiveMarkdown,
  renderJsonl,
  renderWhatsAppTxt
} from "../src/archive.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

/* ---------- 时间戳解析 ---------- */

// 英式：时间在前（WhatsApp Web 最常见）
check(
  "英式 [HH:MM, DD/MM/YYYY]",
  parsePrePlainText("[14:32, 11/10/2026] Miguel Santos: ")?.occurredAt === "2026-10-11T14:32:00.000Z",
  JSON.stringify(parsePrePlainText("[14:32, 11/10/2026] Miguel Santos: "))
);
check("英式能取出发送人", parsePrePlainText("[14:32, 11/10/2026] Miguel Santos: ")?.sender === "Miguel Santos");

// 美式：日期在前 + 12 小时制
check(
  "美式 [MM/DD/YYYY, h:mm:ss AM/PM]",
  parsePrePlainText("[11/10/2026, 2:32:45 PM] Ana: ")?.occurredAt === "2026-10-11T14:32:45.000Z",
  JSON.stringify(parsePrePlainText("[11/10/2026, 2:32:45 PM] Ana: "))
);
check(
  "美式 12:05 AM → 00:05",
  parsePrePlainText("[11/10/2026, 12:05 AM] Ana: ")?.occurredAt === "2026-10-11T00:05:00.000Z",
  JSON.stringify(parsePrePlainText("[11/10/2026, 12:05 AM] Ana: "))
);
check(
  "美式 12:30 PM → 12:30",
  parsePrePlainText("[11/10/2026, 12:30 PM] Ana: ")?.occurredAt === "2026-10-11T12:30:00.000Z"
);

// 点分隔
check(
  "点分隔 [DD.MM.YYYY, HH:MM]",
  parsePrePlainText("[11.10.2026, 14:32] Ana: ")?.occurredAt === "2026-10-11T14:32:00.000Z"
);

// 第一个数 >12 时必须判成「日在前」，否则会算成 11 月 25 日
check(
  "首位 >12 自动判 dmy（25/10）",
  parsePrePlainText("[09:00, 25/10/2026] Ana: ")?.occurredAt === "2026-10-25T09:00:00.000Z",
  JSON.stringify(parsePrePlainText("[09:00, 25/10/2026] Ana: "))
);
// 第二个数 >12 时必须判成「月在前」，否则会算成非法日期
check(
  "次位 >12 自动判 mdy（10/25）",
  parsePrePlainText("[09:00, 10/25/2026] Ana: ")?.occurredAt === "2026-10-25T09:00:00.000Z",
  JSON.stringify(parsePrePlainText("[09:00, 10/25/2026] Ana: "))
);
// 两个都 ≤12 时无法确定，用默认值，但绝不能让 Date 把 2 月 31 日悄悄进位
check("非法日期被拒（31/02）", parsePrePlainText("[14:32, 31/02/2026] Ana: ")?.occurredAt === null);
check("无法解析的戳不抛错", parsePrePlainText("完全没有时间戳") === null);
check("空值返回 null", parsePrePlainText(null) === null);
check(
  "两位年份补成 20xx",
  parsePrePlainText("[14:32, 11/10/26] Ana: ")?.occurredAt === "2026-10-11T14:32:00.000Z"
);

/* ---------- 消息归一化 ---------- */

const inbound = buildMessage({
  id: "false_346@c.us_AAA",
  direction: "inbound",
  body: "  Hola,\n  precio FOB  ",
  prePlainText: "[14:32, 11/10/2026] Miguel Santos: "
});
// 行内空白折叠，但**换行必须留下** —— 归档是喂给训练和人工看的，段落结构不能丢。
check("正文折叠行内空白", inbound.body === "Hola,\nprecio FOB", JSON.stringify(inbound.body));
check("方向保留", inbound.direction === "inbound");
check("关联到发送人与时间", inbound.sender === "Miguel Santos" && inbound.occurredAt === "2026-10-11T14:32:00.000Z");
check(
  "多行正文去掉空行、行首尾空白",
  buildMessage({ direction: "inbound", body: "1) 数量\n\n  2) 交期  \n" }).body === "1) 数量\n2) 交期",
  JSON.stringify(buildMessage({ direction: "inbound", body: "1) 数量\n\n  2) 交期  \n" }).body)
);
check("单行正文不受影响", buildMessage({ direction: "inbound", body: "  hello world  " }).body === "hello world");
check(
  "只有换行的正文等于空（不进归档）",
  isArchivable(buildMessage({ direction: "inbound", body: "\n\n   \n" })) === false
);

check(
  "空正文的图片消息补占位符",
  buildMessage({ direction: "inbound", body: "", messageType: "image" }).body === "[图片]"
);
check(
  "带说明的图片保留说明",
  buildMessage({ direction: "inbound", body: "见附件", messageType: "image" }).body === "见附件"
);
check("方向缺省即入站", buildMessage({ body: "hi" }).direction === "inbound");

check("系统消息不进归档", isArchivable(buildMessage({ body: "x", messageType: "system" })) === false);
check("空消息不进归档", isArchivable(buildMessage({ body: "   " })) === false);
// 图片/语音要留在归档里（"这里有过一张图"是上下文），只有训练层才把它当占位符剔除。
check("图片占位符保留在归档里", isArchivable(buildMessage({ body: "", messageType: "image" })) === true);
check("正常消息进归档", isArchivable(inbound) === true);

/* ---------- 组装 ---------- */

const messages = [
  buildMessage({ id: "a1", direction: "inbound", body: "询价", prePlainText: "[10:00, 10/10/2026] Ana: " }),
  buildMessage({ id: "a2", direction: "outbound", body: "报价在附件", prePlainText: "[10:05, 10/10/2026] 我方: " }),
  buildMessage({ id: "a3", direction: "inbound", body: "  ", prePlainText: "[10:06, 10/10/2026] Ana: " })
];
const archive = buildArchive({
  meta: { id: "wa:346@c.us", contactName: "Ana", contactPhone: "+34600123456" },
  messages,
  now: new Date("2026-10-11T00:00:00.000Z")
});
check("归档版本号写入", archive.version === ARCHIVE_VERSION);
check("空消息被剔除", archive.conversation.messageCount === 2, String(archive.conversation.messageCount));
check("入站/出站分别计数", archive.conversation.inboundCount === 1 && archive.conversation.outboundCount === 1);
check("时间范围取首尾", archive.conversation.firstMessageAt === "2026-10-10T10:00:00.000Z");
check("时间范围取末位", archive.conversation.lastMessageAt === "2026-10-10T10:05:00.000Z");
check("联系人缺失时给默认名", buildArchive({ meta: {}, messages }).conversation.contactName === "未命名联系人");

const merged = mergeArchives([archive, buildArchive({ meta: { contactName: "Bob" }, messages: [messages[0]] })]);
check("合并后统计两个会话", merged.stats.conversationCount === 2, String(merged.stats.conversationCount));
check("合并后消息数累加", merged.stats.messageCount === 3, String(merged.stats.messageCount));
check("合并后字符数累加", merged.stats.characters === "询价报价在附件询价".length, String(merged.stats.characters));

/* ---------- 导出：与 CRM 插件同口径 ---------- */

const jsonl = renderJsonl(archive);
const lines = jsonl.split("\n");
check("jsonl 一行一个会话", lines.length === 1, String(lines.length));
const parsedLine = JSON.parse(lines[0]);
check("jsonl 字段名与插件一致", ["conversationId", "accountId", "accountName", "contactName", "contactPhone", "messageCount", "messages"].every((key) => key in parsedLine), Object.keys(parsedLine).join(","));
check("jsonl 客户角色写作 customer", parsedLine.messages[0].role === "customer", parsedLine.messages[0].role);
check("jsonl 我方角色写作 agent", parsedLine.messages[1].role === "agent", parsedLine.messages[1].role);
check(
  "jsonl 消息字段是 at/type/content",
  parsedLine.messages[0].at === "2026-10-10T10:00:00.000Z" && parsedLine.messages[0].type === "text" && parsedLine.messages[0].content === "询价",
  JSON.stringify(parsedLine.messages[0])
);

const txt = renderWhatsAppTxt(archive);
const txtLines = txt.split("\n");
check("txt 首行是联系人标题", txtLines[0] === "# Ana (+34600123456)", txtLines[0]);
check("txt 第二行是会话 id", txtLines[1] === "# 会话 wa:346@c.us", txtLines[1]);
// 这一行必须能被插件 parseWhatsAppHistory 的 `[dd/mm/yyyy, hh:mm] 发送人: 正文` 规则吃掉
check(
  "txt 消息行符合插件解析格式",
  txtLines[3] === "[10/10/2026, 10:00] Ana: 询价",
  txtLines[3]
);
check("txt 我方行写「我方」", txtLines[4] === "[10/10/2026, 10:05] 我方: 报价在附件", txtLines[4]);
check(
  "txt 用 UTC 与插件一致",
  renderWhatsAppTxt(buildArchive({ meta: { contactName: "T" }, messages: [buildMessage({ direction: "inbound", body: "x", prePlainText: "[23:30, 10/10/2026] T: " })] })).includes("[10/10/2026, 23:30]")
);

const markdown = renderArchiveMarkdown(archive);
check("markdown 有标题与统计", markdown.includes("# WhatsApp 对话归档") && markdown.includes("会话 1 个"));
check("markdown 含联系人小节", markdown.includes("## Ana (+34600123456)"));
check("markdown 标注客户/我方", markdown.includes("**客户**") && markdown.includes("**我方**"));
check("markdown 标明来源与本地性", markdown.includes("web.whatsapp.com") && markdown.includes("未经过任何第三方服务器"));
check(
  "mergeArchives 结果也能直接渲染 markdown",
  renderArchiveMarkdown(merged).includes("会话 2 个")
);

/* ---------- 多行正文的保真（归档 → 导出 → CRM 插件解析） ---------- */

/**
 * 插件 `whatsapp-plugin/src/server/services/whatsapp-history-import.ts` 里
 * `parseWhatsAppHistory` 的最小复刻：只保留决定归档 TXT 能否被吃下的两条规则 ——
 * ① 消息行必须匹配 `[dd/mm/yyyy, hh:mm] 发送人: 正文`；
 * ② 不匹配的行（除"像时间戳但非法"的）并回**上一条**正文，用 `\n` 连接。
 * 复刻在这里是为了让"扩展导出 → 插件导入"的口径有一份可回归的断言。
 */
const PLUGIN_LINE = /^\[(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\]\s*([^:]+):\s?(.*)$/iu;

function pluginParseWhatsAppHistory(content) {
  const messages = [];
  for (const rawLine of content.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const match = line.match(PLUGIN_LINE);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
      const minute = Number(match[5]);
      const meridiem = String(match[7] || "").toUpperCase();
      let hour = Number(match[4]);
      if (meridiem === "PM" && hour < 12) hour += 12;
      if (meridiem === "AM" && hour === 12) hour = 0;
      messages.push({
        occurredAt: new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString(),
        sender: match[8].trim(),
        body: String(match[9] || "").trim()
      });
      continue;
    }
    if (/^\[?\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}/u.test(line)) continue;
    const previous = messages.at(-1);
    if (previous) previous.body = `${previous.body}\n${line}`.trim();
  }
  return { messages };
}

const multilineBundle = buildArchive({
  meta: { id: "wa:492222333@c.us", contactName: "Ana Torres", contactPhone: "+492222333" },
  messages: [
    buildMessage({
      direction: "inbound",
      body: "Hola, ¿podrían confirmar el plazo?\n1) 500 pcs\n2) entrega en octubre",
      prePlainText: "[09:10, 08/10/2026] Ana Torres: "
    }),
    buildMessage({
      direction: "outbound",
      body: "Claro:\n- Plazo: 45 días\n- MOQ: 10 pcs",
      prePlainText: "[09:20, 08/10/2026] 我方: "
    })
  ],
  now: new Date("2026-10-11T00:00:00.000Z")
});

const multilineTxt = renderWhatsAppTxt(multilineBundle);
const roundTripped = pluginParseWhatsAppHistory(multilineTxt).messages;
check("多行：TXT 往返后消息条数不变", roundTripped.length === 2, String(roundTripped.length));
check(
  "多行：客户正文原样还原",
  roundTripped[0]?.body === "Hola, ¿podrían confirmar el plazo?\n1) 500 pcs\n2) entrega en octubre",
  JSON.stringify(roundTripped[0]?.body)
);
check(
  "多行：我方正文原样还原",
  roundTripped[1]?.body === "Claro:\n- Plazo: 45 días\n- MOQ: 10 pcs",
  JSON.stringify(roundTripped[1]?.body)
);
check("多行：时间戳未被后续行破坏", roundTripped[0]?.occurredAt === "2026-10-08T09:10:00.000Z", roundTripped[0]?.occurredAt);
check(
  "多行：正文里的 `[..]` 与冒号不会把行拆开",
  roundTripped[1]?.sender === "我方",
  roundTripped[1]?.sender
);

// jsonl 里 content 带 `\n`，但 JSON.stringify 会转义它 —— 一行一个会话的约定不能被破坏。
const multilineJsonl = renderJsonl(multilineBundle);
check("多行：jsonl 仍然只有一行", multilineJsonl.split("\n").length === 1, String(multilineJsonl.split("\n").length));
check(
  "多行：jsonl content 里换行被转义而非丢失",
  JSON.parse(multilineJsonl).messages[1].content === "Claro:\n- Plazo: 45 días\n- MOQ: 10 pcs",
  JSON.stringify(JSON.parse(multilineJsonl).messages[1].content)
);

const multilineMd = renderArchiveMarkdown(multilineBundle);
check(
  "多行：markdown 后续行缩进两格（不会被当成新列表项）",
  multilineMd.includes("- **我方** `2026-10-08 09:20` Claro:\n  - Plazo: 45 días\n  - MOQ: 10 pcs"),
  multilineMd.split("\n").find((line) => line.includes("Claro:"))
);

/* ---------- 文件名与调度 ---------- */

check("jsonl 文件名带扩展名", archiveFileName("jsonl", "Ana", new Date("2026-10-11T08:09:00")) === "goodjob-whatsapp-归档-Ana-20261011-0809.jsonl");
check("txt 后缀正确", archiveFileName("txt", "Ana").endsWith(".txt"));
check("md 后缀正确", archiveFileName("md", "Ana").endsWith(".md"));
check("非法字符被清掉", !archiveFileName("jsonl", "a/b:c*d?e").includes("/"), archiveFileName("jsonl", "a/b:c*d?e"));
check("空标签回落到全部会话", archiveFileName("jsonl", "").includes("全部会话"));
check(
  "renderArchive 按格式分派",
  renderArchive(archive, "txt", "Ana").content.includes("# Ana") &&
    renderArchive(archive, "jsonl", "Ana").content.startsWith("{") &&
    renderArchive(archive, "md", "Ana").content.includes("# WhatsApp 对话归档")
);

/* ---------- DOM 读取层的纯逻辑 ---------- */

check("没有行时返回空串", extractMessageText(null) === "");

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error(`\n✗ archive 单测失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ archive 单测全通过（${passed} 项）`);
