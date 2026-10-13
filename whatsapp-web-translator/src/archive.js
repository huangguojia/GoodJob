/**
 * 对话归档：把网页版 WhatsApp 的会话读成结构化归档，并导出成三种格式。
 *
 * 其中两种格式刻意与 CRM 插件（`whatsapp-plugin`）的训练管线**逐字段同口径**，
 * 这样归档文件既能在这儿本地训练，也能原样喂给插件已有的训练链路，不用再写一个转换器：
 *
 *   jsonl        = 插件 `training-service.ts::renderTrainingExport`（format=jsonl）的形状
 *   whatsapp-txt = 插件 `renderWhatsAppText` 的形状，可直接被
 *                  `POST /api/v1/imports/whatsapp-text` 解析导入
 *   markdown     = 给人看的归档 + 训练素材
 *
 * 时间戳从 `data-pre-plain-text` 取（WhatsApp 自己的「[HH:MM, DD/MM/YYYY] 发送人: 」），
 * 这是它复制文本功能依赖的属性，比那些每次发版都变的 hash 类名稳得多。
 */

export const ARCHIVE_VERSION = 1;

/** 非文本消息在归档里保留成占位符，而不是丢掉上下文 —— 与插件侧 MEDIA_TYPE_LABELS 同口径。 */
export const MEDIA_LABELS = {
  image: "[图片]",
  video: "[视频]",
  audio: "[语音]",
  file: "[文件]",
  sticker: "[贴纸]",
  system: "[系统消息]"
};

/** 归档里代表"我方"的展示名：txt 导出要写发送人。 */
export const OUTBOUND_LABEL = "我方";

export function normalizeBody(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * 消息正文的归一化：**保留换行**，只折叠行内的连续空白、去掉空行。
 *
 * 为什么不能跟名字一样压成一行：插件的 WhatsApp TXT 格式本来就能往返多行
 * （解析器会把没有时间戳前缀的行并回上一条正文），把 `\n` 提前压掉等于在导出时就丢了段落结构，
 * 客户写的「1) ... 2) ...」会变成一坨。匹配用的折叠在 trainer 的 `cleanText` 里单独做，不靠这里。
 */
export function normalizeMessageBody(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 解析 `[14:32, 11/10/2026] Miguel Santos: `。
 *
 * 三种真实写法都要吃下（地区设置不同）：
 *   `[14:32, 11/10/2026] Name: `（英式，时间在前）
 *   `[11/10/2026, 2:32:45 PM] Name: `（美式，日期在前）
 *   `[11.10.2026, 14:32] Name: `（点分隔）
 *
 * 日月顺序无法从样本本身确定时会冲突，此时按 `dmy` 兜底（与插件 `parseWhatsAppHistory` 的默认一致），
 * 并且**只在第一个数 >12 或第二个数 >12 时才敢确定**，两个都 ≤12 就老老实实用默认值 ——
 * 猜错会把 10/11 变成 11 月 10 日，宁可沿用插件的默认口径。
 */
export function parsePrePlainText(raw, dateOrder = "dmy") {
  const text = String(raw ?? "").trim();
  const bracket = text.match(/^\[([^\]]*)\]\s*([^:]*):\s?/u);
  if (!bracket) return null;
  const [, stamp, rawSender] = bracket;

  const timeMatch = stamp.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/iu);
  const dateMatch = stamp.match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/u);
  if (!timeMatch || !dateMatch) return { occurredAt: null, sender: rawSender.trim() };

  const first = Number(dateMatch[1]);
  const second = Number(dateMatch[2]);
  const year = Number(dateMatch[3]) < 100 ? 2000 + Number(dateMatch[3]) : Number(dateMatch[3]);
  const order = first > 12 ? "dmy" : second > 12 ? "mdy" : dateOrder;
  const day = order === "mdy" ? second : first;
  const month = order === "mdy" ? first : second;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const secondValue = Number(timeMatch[3] ?? 0);
  const meridiem = String(timeMatch[4] ?? "").toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { occurredAt: null, sender: rawSender.trim() };
  }

  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, secondValue));
  // 与插件同款回读校验：二月三十号这种非法日期必须被拒，而不是被 Date 悄悄进位。
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return { occurredAt: null, sender: rawSender.trim() };
  }
  return { occurredAt: at.toISOString(), sender: rawSender.trim() };
}

/** 把一行 DOM 读到的原始数据整理成归档里的消息对象（纯函数，便于单测）。 */
export function buildMessage(input = {}, dateOrder = "dmy") {
  const parsed = input.prePlainText ? parsePrePlainText(input.prePlainText, dateOrder) : null;
  // 正文用**保留换行**的归一化：插件 TXT 解析器会把没有时间戳前缀的行并回上一条，
  // 客户写的"1) ... 2) ..."必须原样带过去。名字/号码这类单行字段仍用 normalizeBody。
  const body = normalizeMessageBody(input.body);
  const messageType = input.messageType || "text";
  const label = MEDIA_LABELS[messageType];
  return {
    id: String(input.id ?? ""),
    direction: input.direction === "outbound" ? "outbound" : "inbound",
    sender: parsed?.sender ?? "",
    occurredAt: input.occurredAt ?? parsed?.occurredAt ?? null,
    messageType,
    // 媒体消息正文空时补占位符，让归档里还看得见"这里有过一张图"。
    body: body || (label && messageType !== "text" ? label : "")
  };
}

/** 是否值得进归档：系统消息和空消息没有训练价值。 */
export function isArchivable(message) {
  if (!message) return false;
  if (message.messageType === "system") return false;
  return Boolean(normalizeBody(message.body));
}

/**
 * 组装一个会话的归档。
 * `meta` 里的字段由调用方从页面读（联系人名、号码、会话 id）。
 */
export function buildArchive({ meta = {}, messages = [], now = new Date() } = {}) {
  const list = messages.filter(isArchivable);
  const times = list.map((message) => message.occurredAt).filter(Boolean).sort();
  const inbound = list.filter((message) => message.direction === "inbound").length;
  return {
    version: ARCHIVE_VERSION,
    archivedAt: new Date(now).toISOString(),
    source: "web.whatsapp.com",
    conversation: {
      id: String(meta.id ?? ""),
      contactName: normalizeBody(meta.contactName) || "未命名联系人",
      contactPhone: String(meta.contactPhone ?? "").trim(),
      messageCount: list.length,
      inboundCount: inbound,
      outboundCount: list.length - inbound,
      firstMessageAt: times[0] ?? null,
      lastMessageAt: times.at(-1) ?? null
    },
    messages: list
  };
}

/** 多会话合并成一个归档：`conversations` 是若干 buildArchive 的产物。 */
export function mergeArchives(archives = [], now = new Date()) {
  const list = archives.filter((archive) => archive?.conversation?.messageCount);
  const allTimes = list
    .flatMap((archive) => [archive.conversation.firstMessageAt, archive.conversation.lastMessageAt])
    .filter(Boolean)
    .sort();
  return {
    version: ARCHIVE_VERSION,
    archivedAt: new Date(now).toISOString(),
    source: "web.whatsapp.com",
    conversations: list,
    stats: {
      conversationCount: list.length,
      messageCount: list.reduce((total, archive) => total + archive.conversation.messageCount, 0),
      inboundCount: list.reduce((total, archive) => total + archive.conversation.inboundCount, 0),
      characters: list.reduce(
        (total, archive) => total + archive.messages.reduce((sum, message) => sum + message.body.length, 0),
        0
      ),
      firstMessageAt: allTimes[0] ?? null,
      lastMessageAt: allTimes.at(-1) ?? null
    }
  };
}

/* ------------------------------------------------------------------ 导出格式 */

/** 与插件 jsonl 导出同形状：一行一个会话，字段名逐个对齐。 */
export function renderJsonl(bundle) {
  return asConversationList(bundle)
    .map((archive) =>
      JSON.stringify({
        conversationId: archive.conversation.id,
        accountId: "",
        accountName: "WhatsApp Web",
        contactName: archive.conversation.contactName,
        contactPhone: archive.conversation.contactPhone,
        messageCount: archive.conversation.messageCount,
        messages: archive.messages.map((message) => ({
          role: message.direction === "inbound" ? "customer" : "agent",
          at: message.occurredAt,
          type: message.messageType,
          content: message.body
        }))
      })
    )
    .join("\n");
}

function two(value) {
  return String(value).padStart(2, "0");
}

/**
 * 与插件 `renderWhatsAppText` 同形状（含 UTC 时间、`[DD/MM/YYYY, HH:MM] 发送人: 正文`）。
 * 这个格式能被插件的 `parseWhatsAppHistory` 原样解析 —— 归档文件可以直接导入 CRM 训练。
 */
export function renderWhatsAppTxt(bundle) {
  return asConversationList(bundle)
    .map((archive) => {
      const lines = [
        `# ${archive.conversation.contactName} (${archive.conversation.contactPhone || "未知号码"})`,
        `# 会话 ${archive.conversation.id || "未命名"}`,
        ""
      ];
      for (const message of archive.messages) {
        const at = message.occurredAt ? new Date(message.occurredAt) : null;
        const date = at ? `${two(at.getUTCDate())}/${two(at.getUTCMonth() + 1)}/${at.getUTCFullYear()}` : "--/--/----";
        const time = at ? `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}` : "--:--";
        const who = message.direction === "inbound" ? archive.conversation.contactName : OUTBOUND_LABEL;
        lines.push(`[${date}, ${time}] ${who}: ${message.body}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** 人读的归档：统计 + 每个会话的完整对白。 */
export function renderArchiveMarkdown(bundle) {
  const bundleObj = bundle?.conversations ? bundle : mergeArchives([bundle].filter(Boolean));
  const lines = [
    "# WhatsApp 对话归档",
    "",
    `> 归档时间：${bundleObj.archivedAt}`,
    `> 来源：${bundleObj.source}`,
    `> 会话 ${bundleObj.stats.conversationCount} 个 · 消息 ${bundleObj.stats.messageCount} 条` +
      `（客户 ${bundleObj.stats.inboundCount} / 我方 ${bundleObj.stats.messageCount - bundleObj.stats.inboundCount}）· ` +
      `${bundleObj.stats.characters} 字`,
    "",
    "本文件由「GoodJob WhatsApp 助手」浏览器扩展在网页版 WhatsApp 上抓取生成，未经过任何第三方服务器。",
    ""
  ];
  for (const archive of bundleObj.conversations) {
    const { conversation } = archive;
    lines.push(
      `## ${conversation.contactName}${conversation.contactPhone ? ` (${conversation.contactPhone})` : ""}`,
      "",
      `- 会话 ID：${conversation.id || "——"}`,
      `- 消息数：${conversation.messageCount}（客户 ${conversation.inboundCount} / 我方 ${conversation.outboundCount}）`,
      `- 时间范围：${conversation.firstMessageAt ?? "——"} ~ ${conversation.lastMessageAt ?? "——"}`,
      ""
    );
    for (const message of archive.messages) {
      const who = message.direction === "inbound" ? "客户" : "我方";
      const at = message.occurredAt ? message.occurredAt.replace("T", " ").slice(0, 16) : "-------- --:--";
      // 多行正文的后续行缩进两格，否则会被 markdown 当成新的列表项。
      const [first = "", ...rest] = message.body.split("\n");
      lines.push(`- **${who}** \`${at}\` ${first}`);
      for (const line of rest) lines.push(`  ${line}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function asConversationList(bundle) {
  if (!bundle) return [];
  return Array.isArray(bundle.conversations) ? bundle.conversations : [bundle];
}

export function archiveStamp(now = new Date()) {
  const at = new Date(now);
  return (
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}`
  );
}

/** 文件名统一在这里生成，避免各处拼错格式后缀。 */
export function archiveFileName(format, label, now = new Date()) {
  const safe = normalizeBody(label).replace(/[\\/:*?"<>|]/gu, "").slice(0, 24) || "全部会话";
  const extension = format === "txt" ? "txt" : format === "md" ? "md" : "jsonl";
  return `goodjob-whatsapp-归档-${safe}-${archiveStamp(now)}.${extension}`;
}

/** 按格式产出 `{ fileName, content }`，调用方只管下载。 */
export function renderArchive(bundle, format, label, now = new Date()) {
  const content =
    format === "txt" ? renderWhatsAppTxt(bundle) : format === "md" ? renderArchiveMarkdown(bundle) : renderJsonl(bundle);
  return { fileName: archiveFileName(format, label, now), content };
}

/* ------------------------------------------------------------------ DOM 读取层 */

/**
 * 消息行定位，两层 —— 与 content.js 的 messageRows **同策略**（那份是内容脚本副本，不能用 ESM 共享）：
 * ① 老选择器 `div.message-in / div.message-out`（多年稳定，mock 也用它）；
 * ② 改版兜底：新版把行类名整批换掉，气泡本体是 `[data-testid="msg-container"]`，
 *    往上找带 `data-id` 的行元素。0.6.6 哨兵诊断单实锤过这种改版（类名 0 命中、气泡还在）。
 */
export function messageRows(container) {
  if (!container) return [];
  const legacy = Array.from(container.querySelectorAll("div.message-in, div.message-out"));
  if (legacy.length) return legacy;
  const seen = new Set();
  const rows = [];
  for (const bubble of container.querySelectorAll('[data-testid="msg-container"]')) {
    const row = bubble.closest("[data-id]") || bubble;
    if (seen.has(row)) continue;
    seen.add(row);
    rows.push(row);
  }
  return rows;
}

/**
 * 方向判据，与 content.js 的 rowDirection 同策略，四层：类名 → `data-id` 首段
 * （`false_` = 来信 / `true_` = 我方）→ 发送状态图标（只在我方）→ 几何对齐。
 * 四层全认不出**当来信**——归档宁可多记一条，也不该把客户的话悄悄归到我方头上
 * （与翻译层"宁可不翻"相反：翻错方向浪费钱又添乱，归错方向是丢客户的记录）。
 */
export function isIncomingRow(row) {
  if (!row) return false;
  if (row.classList.contains("message-in")) return true;
  if (row.classList.contains("message-out")) return false;
  const id = row.getAttribute("data-id") || "";
  if (id.startsWith("false_")) return true;
  if (id.startsWith("true_")) return false;
  try {
    const statusMark = row.querySelector(
      '[data-testid="msg-clock"], [data-testid="msg-check"], [data-testid="msg-dblcheck"]'
    );
    if (statusMark) return false;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.width) {
      const bubble =
        row.querySelector('[data-testid="msg-container"]') ||
        row.querySelector("span.selectable-text") ||
        row.firstElementChild;
      const bubbleRect = bubble ? bubble.getBoundingClientRect() : rowRect;
      const refRect =
        bubble && bubble !== row ? rowRect : row.parentElement?.getBoundingClientRect() || rowRect;
      if (refRect.width) {
        const span = refRect.width;
        const leftGap = bubbleRect.left - refRect.left;
        const rightGap = refRect.right - bubbleRect.right;
        if (rightGap < span * 0.15 && leftGap > span * 0.35) return false;
        if (leftGap < span * 0.15 && rightGap > span * 0.35) return true;
      }
    }
  } catch {
    /* 隐藏节点等场景几何不可测 —— 落到下面的默认值 */
  }
  return true;
}

export function messagesContainer() {
  const panel = document.querySelector('#main [data-testid="conversation-panel-messages"]');
  if (panel) return panel;
  // 改版兜底（与 content.js 的 messagesContainer 同策略）：面板 testid 被换掉时，
  // 用气泡自己反推容器（第一个气泡的父层）。落到 .copyable-area 多半是输入框，行匹配必败。
  const bubble = document.querySelector(
    '#main [data-testid="msg-container"], #main div.message-in, #main div.message-out'
  );
  if (bubble?.parentElement) return bubble.parentElement;
  return document.querySelector("#main .copyable-area") || document.querySelector("#main");
}

/**
 * 一条消息的纯文本：优先 `span.selectable-text`，避免把时间戳吃进来。
 *
 * 多行还原的两条路径：
 * ① 新版 WhatsApp 把整段包在**一个** `.selectable-text` 里，换行是里面的 `<br>`，
 *    `innerText` 本身就带 `\n`，靠 `normalizeMessageBody` 保住即可；
 * ② 老版结构会把每一行拆成**兄弟** `.selectable-text`，此时只能按行拼 —— 这也是
 *    这里用 `\n`（而不是空格）连接多个 part 的原因：它们本就代表不同的行。
 */
export function extractMessageText(row) {
  if (!row) return "";
  const parts = Array.from(row.querySelectorAll("span.selectable-text"))
    .map((node) => node.innerText || node.textContent || "")
    .map(normalizeMessageBody)
    .filter(Boolean);
  if (parts.length) return parts.join("\n").trim();

  const plain = row.querySelector("[data-pre-plain-text]");
  if (plain) {
    const raw = (plain.innerText || plain.textContent || "").trim();
    // 兜底路径会把「[12:03, 11/10/2026] 张三: 」也带进来，这里只取冒号后的正文。
    const cut = raw.replace(/^\[[^\]]*\]\s*[^:]*:\s?/u, "");
    return normalizeMessageBody(cut);
  }
  const fallback = (row.innerText || "").trim();
  // 最后兜底：`row.innerText` 连时间戳行一起带进来，能剥就剥（括号式 → 裸时间），剥不掉就照原样。
  const stripped = fallback
    .replace(/^\[[^\]]*\]\s*[^:]*:\s?/u, "")
    .replace(/^\d{1,2}:\d{2}(\s?(AM|PM))?\s*/iu, "");
  return normalizeMessageBody(stripped || fallback);
}

/** 非文本消息类型探测：只认 WhatsApp 有明显的媒体节点，认不出就当文本。 */
export function detectMessageType(row) {
  if (!row) return "text";
  if (row.querySelector('img[src^="blob:"], [data-testid="image-thumb"], [data-testid="media-image"]')) return "image";
  if (row.querySelector('video, [data-testid="media-video"]')) return "video";
  if (row.querySelector('audio, [data-testid="audio-player"], [data-testid="media-audio"]')) return "audio";
  if (row.querySelector('[data-testid="document-thumb"], [data-testid="media-document"]')) return "file";
  if (row.querySelector('[data-testid="sticker"]')) return "sticker";
  return "text";
}

export function readMessageRow(row) {
  const prePlain = row.getAttribute("data-pre-plain-text") || row.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "";
  return buildMessage({
    id: row.getAttribute("data-id") || row.dataset.id || "",
    direction: isIncomingRow(row) ? "inbound" : "outbound",
    body: extractMessageText(row),
    prePlainText: prePlain || undefined,
    messageType: detectMessageType(row)
  });
}

/** 读当前打开会话的全部消息。 */
export function readConversationMessages() {
  const container = messagesContainer();
  return messageRows(container).map(readMessageRow);
}

/** 从任意 `data-id` 里抠出会话号：形如 `false_34600123456@c.us_3A1F2B`、`34600123456@c.us`。 */
const CHAT_ID_PATTERN = /(\d{6,15})@([cg])\.us/u;

export function chatIdFrom(value) {
  const match = String(value ?? "").match(CHAT_ID_PATTERN);
  return match ? `${match[1]}@${match[2]}.us` : "";
}

/**
 * 读当前会话的联系人信息。
 *
 * 号码从 `data-id` 反推（消息行里夹着会话号），头部未必带号码；名字优先取标题节点。
 * 拿不到就留空 —— 空号码比编一个假号码安全。
 */
export function readContact(root = document) {
  const header = root.querySelector("#main header");
  const nameNode =
    header?.querySelector('[data-testid="conversation-info-header-chat-title"]') ||
    header?.querySelector("span[title]") ||
    header?.querySelector('[dir="auto"]');
  const contactName = normalizeBody(nameNode?.getAttribute("title") || nameNode?.textContent || "");

  let contactPhone = "";
  for (const node of root.querySelectorAll("#main [data-id], [data-testid='conversation-info-header'] a")) {
    const raw = node.getAttribute("data-id") || node.getAttribute("href") || "";
    const id = chatIdFrom(raw) || chatIdFrom(decodeURIComponent(raw));
    if (id) {
      contactPhone = `+${id.split("@")[0]}`;
      break;
    }
  }
  if (!contactPhone) {
    // 群聊没有号码；退而求其次认一下标题或副标题里的 +86… 之类。
    const found = `${contactName} ${header?.textContent || ""}`.match(/\+?\d[\d\s-]{7,}\d/u);
    if (found) contactPhone = found[0].replace(/[\s-]/gu, "");
  }
  return { contactName, contactPhone };
}

export function conversationIdOf(root = document) {
  for (const node of root.querySelectorAll("#main [data-id]")) {
    const id = chatIdFrom(node.getAttribute("data-id"));
    if (id) return `wa:${id}`;
  }
  const name = readContact(root).contactName;
  return name ? `wa:${name}` : "";
}

/** 抓取当前打开的会话 → 一个归档对象。 */
export function readCurrentConversation(root = document, now = new Date()) {
  const contact = readContact(root);
  return buildArchive({
    meta: { id: conversationIdOf(root), contactName: contact.contactName, contactPhone: contact.contactPhone },
    messages: readConversationMessages(),
    now
  });
}

/** 左侧会话列表的行（用于「归档全部会话」）。 */
export function chatListRows(root = document) {
  const pane = root.querySelector("#pane-side") || root.querySelector('[data-testid="chat-list"]') || root;
  return Array.from(pane.querySelectorAll('div[role="listitem"], [data-testid="cell-frame-container"]')).filter(
    (row) => row.querySelector("span[title]")
  );
}

export function chatRowTitle(row) {
  const title = row.querySelector('span[title]') || row.querySelector('[dir="auto"]');
  return normalizeBody(title?.getAttribute("title") || title?.textContent || "");
}

export function chatRowId(row) {
  const id = chatIdFrom(row?.getAttribute("data-id"));
  if (id) return `wa:${id}`;
  for (const node of row?.querySelectorAll("[data-id]") ?? []) {
    const nested = chatIdFrom(node.getAttribute("data-id"));
    if (nested) return `wa:${nested}`;
  }
  return "";
}
