/**
 * 本地训练：把归档的聊天记录变成一份「自动回复档案」。
 *
 * 判定与检索口径刻意与 CRM 插件保持一致（`text-match.ts` / `training-service.ts`），
 * 这样浏览器里训出来的档案语义和 CRM 里那套是同一个东西，不会出现"两边答得不一样"：
 *   - 特征切分：中文按**相邻两字**切（中文没词边界，按空格切会让整句变成一个 token）；
 *   - 相似度：用「较短一侧被覆盖率」而不是对称 Dice（客户一句话常比标准问法短得多）；
 *   - 问答对抽取：连续入站合并成一次提问、连续出站合并成一次回复；
 *   - 打分：太短学不到、太长多半是报价单原文，两者都降权。
 *
 * 与插件不同的是执行位置：这里全部是纯函数、在浏览器里跑，不依赖数据库，
 * 也不需要 CRM 登录态 —— 装完扩展、点一次「学习」就能得到可用的话术库。
 */

import { detectLanguage } from "./settings.js";

export const PROFILE_VERSION = 1;
/** 进档案的样板上限：够学会语感，又不会把提示词撑爆。 */
export const MAX_EXAMPLES = 40;
export const MAX_EXAMPLE_CHARS = 600;
/** 检索门槛：只重合一个词不算同一个问法。 */
export const MIN_MATCHED_TOKENS = 2;
/** 模板置信度上限：模板是历史原话复用，设到 0.9 以上等于关掉它。 */
export const MAX_RULE_CONFIDENCE = 0.9;
export const MIN_CONFIDENCE = 0.1;

export const DEFAULT_GUARDRAILS = [
  "不承诺价格、折扣、交期或库存，除非训练样本或 CRM 数据里有明确依据",
  "不编造公司资质、认证、证书、客户名单或成功案例",
  "不发送合同、付款账户、银行信息或任何敏感财务信息",
  "客户要求转人工、投诉、退款或涉及法律问题时，立即停止自动回复并提醒人工介入",
  "回复保持与训练档案一致的语言和语气，一次不超过 2 条短消息"
];

export const DEFAULT_ESCALATE_KEYWORDS = [
  "投诉", "退款", "律师", "法务", "起诉", "假冒", "假货", "骗子",
  "complaint", "refund", "lawyer", "lawsuit", "legal", "fraud", "scam"
];

/** 媒体占位符（`[图片]` 这类）不算可训练内容，与插件 `PLACEHOLDER_PATTERN` 同口径。 */
const PLACEHOLDER_PATTERN = /^\[[^\]]{1,20}\]$/u;

/* ------------------------------------------------------- 文本匹配原语（同插件口径） */

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_LATIN_TOKEN_LENGTH = 3;

export function tokenize(value) {
  const result = new Set();
  for (const segment of String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!segment) continue;
    if (CJK_PATTERN.test(segment)) {
      const characters = [...segment];
      if (characters.length === 1) {
        result.add(characters[0]);
        continue;
      }
      for (let index = 0; index + 1 < characters.length; index += 1) {
        result.add(characters[index] + characters[index + 1]);
      }
      continue;
    }
    if (segment.length >= MIN_LATIN_TOKEN_LENGTH) result.add(segment);
  }
  return [...result];
}

export function sharedTokens(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

export function coverage(matched, leftSize, rightSize) {
  const shortest = Math.min(leftSize, rightSize);
  return shortest ? Math.min(1, matched / shortest) : 0;
}

/** 短语包含：忽略大小写、折叠空白，但**不**把空白整体删掉（避免 `e shi` 命中 `freeshipping`）。 */
export function containsPhrase(haystack, needle) {
  const normalized = String(needle ?? "").toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalized) return false;
  return String(haystack ?? "").toLowerCase().replace(/\s+/gu, " ").includes(normalized);
}

/* ------------------------------------------------------- 档案构建 */

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function isTrainable(message) {
  if (!message) return false;
  if (message.messageType === "system") return false;
  const body = cleanText(message.body);
  if (!body) return false;
  return !PLACEHOLDER_PATTERN.test(body);
}

/**
 * 把消息序列还原成「客户问 → 我方答」。
 * 连续多条我方消息合并成一次回复，贴近真实对话节奏；一条回复之后再来的提问算新的一组。
 */
export function buildExchanges(messages = []) {
  const exchanges = [];
  let pendingInbound = [];
  let pendingInboundAt = null;
  let open = null;

  for (const message of messages) {
    if (message.direction === "inbound") {
      if (!isTrainable(message)) continue;
      if (open) {
        exchanges.push(open);
        open = null;
      }
      pendingInbound.push(cleanText(message.body));
      if (!pendingInboundAt) pendingInboundAt = message.occurredAt ?? null;
      continue;
    }
    if (!isTrainable(message)) continue;
    const reply = cleanText(message.body);
    if (!pendingInbound.length) {
      // 客户还没说话我们就先发了 —— 并到上一组回复里，别丢掉上下文。
      if (open) open.reply = `${open.reply}\n${reply}`.trim();
      continue;
    }
    open = {
      inbound: pendingInbound.join("\n"),
      reply,
      occurredAt: pendingInboundAt ?? message.occurredAt ?? null,
      score: 0
    };
    pendingInbound = [];
    pendingInboundAt = null;
  }
  if (open) exchanges.push(open);
  return exchanges.map(withScore);
}

function withScore(exchange) {
  const replyLength = exchange.reply.length;
  const lengthScore = replyLength < 12 ? -30 : replyLength <= 420 ? 30 : 6;
  const score =
    lengthScore +
    (/[?？]/u.test(exchange.reply) ? 8 : 0) +
    (/\d/u.test(exchange.reply) ? 6 : 0) +
    (/https?:\/\//iu.test(exchange.reply) ? -4 : 0) +
    (exchange.inbound.length >= 6 ? 6 : -6) +
    (exchange.reply.split("\n").length <= 3 ? 4 : -4);
  return { ...exchange, score };
}

const GREETING_PATTERN = /^(hi|hello|hey|dear|greetings|good (morning|afternoon|evening)|你好|您好|亲爱的)/iu;
const CLOSING_PATTERN = /(best regards|kind regards|regards|sincerely|thanks|thank you|此致|祝好|谢谢|感谢)/iu;

/** 从真实回复里量出语气、长度习惯与高频表达 —— 这些是"像不像我们"的来源。 */
export function analyzeStyle(outbound = [], inbound = []) {
  const languageCounts = new Map();
  for (const text of [...inbound, ...outbound]) {
    const language = detectLanguage(text);
    if (!language || language === "unknown") continue;
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).map(([language]) => language).slice(0, 4);

  const nonEmpty = outbound.filter((text) => text.length > 0);
  const averageLength = nonEmpty.length
    ? Math.round(nonEmpty.reduce((total, text) => total + text.length, 0) / nonEmpty.length)
    : 0;
  const emojiRate = nonEmpty.length
    ? nonEmpty.filter((text) => /\p{Extended_Pictographic}/u.test(text)).length / nonEmpty.length
    : 0;
  const greetingRate = nonEmpty.length ? nonEmpty.filter((text) => GREETING_PATTERN.test(text)).length / nonEmpty.length : 0;
  const closingRate = nonEmpty.length ? nonEmpty.filter((text) => CLOSING_PATTERN.test(text)).length / nonEmpty.length : 0;
  const questionRate = nonEmpty.length ? nonEmpty.filter((text) => /[?？]/u.test(text)).length / nonEmpty.length : 0;

  const tone = (() => {
    if (averageLength <= 60 && emojiRate >= 0.15) return "简短热情，带少量表情";
    if (averageLength <= 60) return "简短直接";
    if (emojiRate >= 0.15) return "友好详细，带少量表情";
    if (averageLength >= 220) return "正式详尽，偏商务书面";
    return "专业友好，以信息为主";
  })();

  const phraseCounts = new Map();
  for (const text of nonEmpty.slice(0, 200)) {
    const opening = cleanText(text).slice(0, 48).replace(/[，。,.!！:：]/gu, " ").trim();
    const tokens = opening.split(" ").filter(Boolean).slice(0, 5).join(" ");
    if (tokens.length < 6) continue;
    phraseCounts.set(tokens, (phraseCounts.get(tokens) ?? 0) + 1);
  }
  const signaturePhrases = [...phraseCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([phrase]) => phrase);

  const guidelines = [
    `回复长度参考训练样本，平均约 ${averageLength || 40} 字，避免长篇大论`,
    greetingRate > 0.3 ? "开头保留固定的问候语习惯" : "直接进入正题，不额外寒暄",
    closingRate > 0.2 ? "结尾保留固定的收尾与署名习惯" : "结尾简短，不重复客套",
    questionRate > 0.3 ? "每条回复以一个明确的下一步问题收尾" : "给出明确结论后再补充必要信息",
    languages.length ? `客户主要使用 ${languages.join(" / ")}，沿用同一语言回复` : "按客户来信语言回复"
  ];
  if (signaturePhrases.length) guidelines.push(`优先复用训练样本中的高频表达，例如「${signaturePhrases[0]}」`);

  return { tone, guidelines, signaturePhrases, languages, averageLength, emojiRate, sampleSize: nonEmpty.length };
}

/** 稳定短哈希（不依赖 crypto，纯函数可测）。 */
export function fingerprint(value) {
  let hash = 5381;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function asConversationList(bundle) {
  if (!bundle) return [];
  return Array.isArray(bundle.conversations) ? bundle.conversations : [bundle];
}

/**
 * 从归档里抽出**可累积的语料摘要**。
 *
 * 为什么要这一层：归档全文可能有几 MB，塞进 `chrome.storage.local` 很快会顶到配额；
 * 而训练真正需要的只有「问答对 + 风格统计」。所以本地只留这份摘要（几百 KB 以内封顶），
 * 全文只出现在下载的归档文件里。也让"再学一次"变成追加而不是重抓。
 */
export function extractCorpus(bundles = []) {
  const archives = (Array.isArray(bundles) ? bundles : [bundles]).flatMap(asConversationList);
  const exchanges = [];
  const inbound = [];
  const outbound = [];
  let messageCount = 0;

  for (const archive of archives) {
    if (!archive?.conversation) continue;
    for (const message of archive.messages ?? []) {
      if (!isTrainable(message)) continue;
      messageCount += 1;
      const body = cleanText(message.body);
      if (message.direction === "inbound") inbound.push(body);
      else outbound.push(body);
    }
    for (const exchange of buildExchanges(archive.messages ?? [])) {
      exchanges.push({
        conversationId: archive.conversation.id || "",
        contactName: archive.conversation.contactName || "",
        occurredAt: exchange.occurredAt,
        inbound: exchange.inbound.slice(0, MAX_EXAMPLE_CHARS),
        reply: exchange.reply.slice(0, MAX_EXAMPLE_CHARS),
        score: exchange.score
      });
    }
  }

  const times = archives
    .flatMap((archive) => [archive.conversation.firstMessageAt, archive.conversation.lastMessageAt])
    .filter(Boolean)
    .sort();

  return {
    version: PROFILE_VERSION,
    exchanges,
    // 风格统计需要的是"我方说过的话"，只留最近 400 条就够量语气，不必留全量。
    inbound: inbound.slice(-400),
    outbound: outbound.slice(-400),
    conversations: archives.filter((archive) => archive?.conversation?.messageCount).length,
    messages: messageCount,
    from: times[0] ?? null,
    to: times.at(-1) ?? null
  };
}

/** 语料条数上限：再多也学不动，只会把本地存储和提示词一起撑爆。 */
export const MAX_CORPUS_EXCHANGES = 600;

/**
 * 追加式合并两份语料，按「问 + 答」去重。
 * 反复归档同一个会话是很自然的操作（客户今天又多聊了几句），不该让语料无限膨胀。
 */
export function mergeCorpus(base, incoming, limit = MAX_CORPUS_EXCHANGES) {
  const seen = new Set();
  const merged = [];
  for (const item of [...(base?.exchanges ?? []), ...(incoming?.exchanges ?? [])]) {
    const key = fingerprint(`${cleanText(item.inbound)}\u0000${cleanText(item.reply)}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  // 超限时优先淘汰低分样本（太短/太长/纯链接的那些），保住真正有语感的。
  const kept = merged.length > limit ? merged.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit) : merged;
  return {
    version: PROFILE_VERSION,
    exchanges: kept,
    inbound: [...(base?.inbound ?? []), ...(incoming?.inbound ?? [])].slice(-400),
    outbound: [...(base?.outbound ?? []), ...(incoming?.outbound ?? [])].slice(-400),
    conversations: (base?.conversations ?? 0) + (incoming?.conversations ?? 0),
    messages: (base?.messages ?? 0) + (incoming?.messages ?? 0),
    from: [base?.from, incoming?.from].filter(Boolean).sort()[0] ?? null,
    to: [base?.to, incoming?.to].filter(Boolean).sort().at(-1) ?? null,
    updatedAt: new Date().toISOString()
  };
}

export function emptyCorpus() {
  return { version: PROFILE_VERSION, exchanges: [], inbound: [], outbound: [], conversations: 0, messages: 0, from: null, to: null };
}

/** 用一份语料训练出档案（纯函数，不碰存储）。 */
export function buildProfileFromCorpus(corpus, { name = "Web 会话档案", now = new Date() } = {}) {
  const exchanges = corpus?.exchanges ?? [];
  const style = analyzeStyle(corpus?.outbound ?? [], corpus?.inbound ?? []);
  const ranked = exchanges
    .slice()
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || String(left.occurredAt ?? "").localeCompare(String(right.occurredAt ?? "")));
  const examples = ranked.slice(0, MAX_EXAMPLES).map((exchange) => ({
    conversationId: exchange.conversationId,
    occurredAt: exchange.occurredAt,
    inbound: exchange.inbound,
    reply: exchange.reply,
    score: exchange.score
  }));

  const timestamp = new Date(now).toISOString();
  const status = examples.length && (corpus?.outbound?.length ?? 0) ? "ready" : "empty";
  return {
    id: `gjp_${fingerprint(`${name}:${timestamp}:${examples.length}`)}`,
    version: PROFILE_VERSION,
    name: cleanText(name) || "Web 会话档案",
    status,
    engine: "rules",
    tone: style.tone,
    summary:
      `基于 ${corpus?.conversations ?? 0} 个会话、${corpus?.messages ?? 0} 条消息、${exchanges.length} 组问答提炼。` +
      `语气判定：${style.tone}；我方回复平均 ${style.averageLength} 字。` +
      (examples.length
        ? `已选出 ${examples.length} 组高质量问答作为话术样板。`
        : "暂时没有足够完整的一问一答，建议先归档包含我方回复的会话。"),
    guidelines: style.guidelines,
    signaturePhrases: style.signaturePhrases,
    guardrails: DEFAULT_GUARDRAILS,
    languages: style.languages,
    examples,
    stats: {
      conversations: corpus?.conversations ?? 0,
      messages: corpus?.messages ?? 0,
      exchanges: exchanges.length,
      samples: examples.length,
      averageReplyLength: style.averageLength,
      emojiRate: Number(style.emojiRate.toFixed(2))
    },
    source: { from: corpus?.from ?? null, to: corpus?.to ?? null },
    trainedAt: timestamp
  };
}

/** 一步到位：归档 → 语料 → 档案。 */
export function buildProfile({ bundles = [], name = "Web 会话档案", now = new Date() } = {}) {
  return buildProfileFromCorpus(extractCorpus(bundles), { name, now });
}

/* ------------------------------------------------------- 检索与护栏 */

/** 从档案里找与客户这句话最接近的一组问答。 */
export function bestExample(inboundBody, profile) {
  const queryTokens = tokenize(inboundBody);
  if (!queryTokens.length || !profile?.examples?.length) return null;
  let best = null;
  for (const example of profile.examples) {
    const exampleTokens = tokenize(example.inbound);
    const matched = sharedTokens(queryTokens, exampleTokens);
    if (matched < MIN_MATCHED_TOKENS) continue;
    const similarity = coverage(matched, queryTokens.length, exampleTokens.length);
    if (!best || similarity > best.similarity) best = { similarity, matched, reply: example.reply, inbound: example.inbound };
  }
  return best;
}

/**
 * 生成之后（以及复用历史原话之前）的统一闸门。
 * 只拦**机器能判定**的硬约束 —— 误拦比漏拦更容易让人直接关掉功能，模糊判断交给人工。
 */
export function applyGuardrails(reply, guardrails = [], forbiddenPhrases = []) {
  const violations = guardrails.filter((rule) => violatesGuardrail(reply, rule));
  if (violations.length) return { blocked: true, reason: `可能触碰护栏：${violations[0]}` };
  const forbidden = forbiddenPhrases.filter((phrase) => containsPhrase(reply, phrase));
  if (forbidden.length) return { blocked: true, reason: `回复含禁用语「${forbidden[0]}」` };
  return { blocked: false, reason: "" };
}

/** 护栏里提到价格/折扣/交期/库存时，回复出现任何金额字样就拦。 */
function violatesGuardrail(reply, rule) {
  if (!/价格|折扣|交期|库存/u.test(rule)) return false;
  return /(?:USD|EUR|CNY|RMB|\$|￥|€)\s?\d/iu.test(reply);
}

/**
 * 规则通道：直接用历史原话回答。
 * 这是「操作最少」的关键 —— 不花钱、不依赖外部接口，训练完立刻可用。
 */
export function resolveReply(inboundBody, profile, options = {}) {
  const guardrails = options.guardrails ?? profile?.guardrails ?? DEFAULT_GUARDRAILS;
  const forbiddenPhrases = options.forbiddenPhrases ?? [];
  const hit = bestExample(inboundBody, profile);
  if (!hit || !hit.reply) {
    return {
      reply: "",
      confidence: MIN_CONFIDENCE,
      matched: 0,
      similarity: 0,
      blocked: true,
      source: "none",
      reason: "话术库里没有相近问法，请人工回复；把这条问答补进档案后下次就能自动回"
    };
  }
  const confidence = Math.min(MAX_RULE_CONFIDENCE, Math.round((0.25 + 0.65 * hit.similarity) * 100) / 100);
  const gate = applyGuardrails(hit.reply, guardrails, forbiddenPhrases);
  return {
    reply: hit.reply,
    confidence,
    matched: hit.matched,
    similarity: hit.similarity,
    blocked: gate.blocked,
    source: "profile",
    reason: gate.blocked ? gate.reason : `与训练档案匹配（相似度 ${hit.similarity.toFixed(2)}，${hit.matched} 个共同特征）`
  };
}

/** 客户这句话是否命中"该转人工"的场景。 */
export function escalateMatch(inboundBody, keywords = DEFAULT_ESCALATE_KEYWORDS) {
  const text = String(inboundBody ?? "").toLowerCase();
  return keywords.find((keyword) => keyword && text.includes(String(keyword).toLowerCase())) ?? "";
}

/* ------------------------------------------------------- 导出 */

/**
 * 导成 Markdown 训练包，章节与插件 `training-library-service.ts::exportMarkdown` 对齐：
 * 政策（护栏）/ 标准问答对。可以直接给人审阅，也可以当成交付物。
 */
export function exportTrainingKit(profile) {
  const lines = [
    `# 自动回复训练包（浏览器归档）`,
    "",
    `> 档案名：${profile.name}`,
    `> 训练时间：${profile.trainedAt}`,
    `> 样本：${profile.stats.conversations} 个会话 / ${profile.stats.messages} 条消息 / ${profile.examples.length} 组问答`,
    `> 语气：${profile.tone}`,
    `> 主营语言：${profile.languages.join(" / ") || "未判定"}`,
    "",
    profile.summary,
    "",
    "## 写作准则",
    ""
  ];
  for (const guideline of profile.guidelines) lines.push(`- ${guideline}`);
  lines.push("", "## 政策（必须遵守）", "");
  for (const rule of profile.guardrails) lines.push(`- ${rule}`);
  lines.push("", "## 标准问答对", "");
  profile.examples.forEach((example, index) => {
    lines.push(`### ${index + 1}. 客户问`, "", example.inbound, "", example.reply, "");
  });
  if (profile.signaturePhrases.length) {
    lines.push("## 高频表达", "");
    for (const phrase of profile.signaturePhrases) lines.push(`- ${phrase}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function profileFileName(profile, now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `goodjob-whatsapp-训练包-${stamp}.md`;
}
