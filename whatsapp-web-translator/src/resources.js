/**
 * 右侧整列：纯逻辑层（无 DOM、无 chrome.*，可在 Node 里直接回测）。
 *
 * 为什么把这一层单独抠出来：整列里真正容易出错的不是"画得好看"，而是这几件事 ——
 * 宽度怎么夹、什么时候该刷新、状态该落在哪一档、界面上的「为什么推荐」到底取自哪个字段。
 * 这些全是纯函数，能被 300 条断言摁住；留在 `agent.js` 里就只能靠人眼看截图。
 *
 * DOM 与拖拽在 `agent.js`，样式在 `agent.css`。
 */

/** 宽度与折叠状态存在这里。**不存任何 token、不存任何外链**。 */
export const COLUMN_KEY = "gj_panel_prefs";

export const COLUMN_LIMITS = {
  /** 低于这个宽度，资料标题就会被挤成一列竖字。 */
  min: 320,
  /** 高于这个宽度，WhatsApp 自己就没法用了。 */
  max: 720,
  /** 折叠后只剩一条竖条（一个 GJ 标识 + 竖排文案）。 */
  collapsed: 44,
  /** 视口窄于它就不再"推窄"，改成覆盖式抽屉 —— 推窄会把聊天区挤到不可用。 */
  narrow: 1100
};

export const COLUMN_DEFAULTS = { width: 380, collapsed: false };

/**
 * 会话切换后的防抖时长。
 *
 * 1.5 秒是量出来的：点会话列表时 WhatsApp 会连续重建 DOM（先清空、再挂标题、再灌消息），
 * 太早读会读到"上一条会话的名字 + 空消息列表"这种中间态。1.5 秒能稳定等到标题与首屏消息都在。
 */
export const CONVERSATION_DEBOUNCE_MS = 1500;

/** 面板一次最多列几份资料（与服务端默认 limit 对齐）。 */
export const RESOURCE_LIMIT = 5;

/** 现场对话最多带几条上去（与服务端 `MAX_INLINE_CONTEXT_MESSAGES` 对齐）。 */
export const MAX_TRANSCRIPT_MESSAGES = 20;

export function clampColumnWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return COLUMN_DEFAULTS.width;
  return Math.round(Math.min(COLUMN_LIMITS.max, Math.max(COLUMN_LIMITS.min, number)));
}

/** 从 storage 里读出来的东西一律当**不可信**处理：手动改过、上个版本残留、写一半断电都可能。 */
export function readColumnPrefs(stored) {
  const raw = stored && typeof stored === "object" ? stored : {};
  return {
    width: clampColumnWidth(raw.width ?? COLUMN_DEFAULTS.width),
    collapsed: Boolean(raw.collapsed)
  };
}

export function columnPrefsPatch(prefs) {
  return { [COLUMN_KEY]: { width: clampColumnWidth(prefs?.width), collapsed: Boolean(prefs?.collapsed) } };
}

/**
 * 算出"这一列现在占多宽、用哪种模式"。
 *
 * 三档：
 * - `rail`：折叠状态，只占 44px，什么都不推；
 * - `push`：视口够宽，把 WhatsApp 的根容器**推窄**（这是"一整列"与"浮层"的本质区别）；
 * - `overlay`：视口窄，改成覆盖式抽屉 + 遮罩，避免把聊天区挤到不可用。
 */
export function resolveLayout({ width, collapsed, viewportWidth } = {}) {
  const resolved = clampColumnWidth(width);
  if (collapsed) return { mode: "rail", columnWidth: COLUMN_LIMITS.collapsed, push: 0 };
  const narrow = Number(viewportWidth) < COLUMN_LIMITS.narrow;
  return narrow
    ? { mode: "overlay", columnWidth: resolved, push: 0 }
    : { mode: "push", columnWidth: resolved, push: resolved };
}

/**
 * 会话的稳定键，用于「换会话了就重新推荐」的判定。
 *
 * 优先用号码（唯一），没号码才退回名字。**和 CRM 侧认客户的口径一致**：
 * 那边也是先按号码、号码对不上才按名字，两边不一致会出现"面板刷了新会话但推荐还是旧的"。
 */
export function conversationKeyOf(contact, fallback = "") {
  const phone = String(contact?.contactPhone ?? "").replace(/\D/gu, "");
  if (phone) return `wa:+${phone}`;
  const name = String(contact?.contactName ?? "").trim();
  if (name) return `wa:name:${name}`;
  return fallback;
}

/** 把页面读到的转写整理成服务端要的形状。超限在**这里**截断，而不是指望服务端兜。 */
export function buildSuggestPayload({ messages, contact, engine, model, effort, language, tone, withAi, limit } = {}) {
  const transcript = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      direction: message?.direction === "outbound" ? "outbound" : "inbound",
      body: String(message?.body ?? "").slice(0, 4_000),
      occurredAt: String(message?.occurredAt ?? "")
    }))
    .filter((message) => message.body.trim())
    .slice(-MAX_TRANSCRIPT_MESSAGES);
  return {
    messages: transcript,
    contact: {
      phone: String(contact?.contactPhone ?? "").slice(0, 32),
      name: String(contact?.contactName ?? "").slice(0, 180)
    },
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(language ? { language } : {}),
    ...(tone ? { tone } : {}),
    ...(withAi === false ? { withAi: false } : {}),
    ...(Number.isFinite(limit) ? { limit: Math.max(1, Math.min(20, Number(limit))) } : {})
  };
}

/**
 * 来源徽章。
 *
 * 「有 CRM 历史 / 命中了知识 / 用的是哪条通道」必须能一眼看出来 ——
 * 没有它，「智能回复」和瞎编在用户眼里没有任何区别。
 */
export const SOURCE_LABELS = {
  profile: "训练档案",
  library: "训练库",
  crm_followup: "CRM 跟进",
  crm_quote: "历史报价",
  knowledge: "知识库",
  resource: "资料推荐"
};

export function sourceBadges(evidence) {
  const sources = Array.isArray(evidence?.sources) ? evidence.sources : [];
  return sources
    .filter((key) => SOURCE_LABELS[key])
    .map((key) => ({ key, label: SOURCE_LABELS[key] }));
}

export const RESOURCE_TYPE_LABELS = {
  file: "文件",
  skill: "Skill",
  knowledge: "知识",
  product: "产品"
};

/**
 * 一张资料卡的展示口径。
 *
 * `why` **优先取 AI 复排的理由，没有才退到 CRM 给的 `headline`**。
 * 这个顺序不能反：headline 是算法说"词对上了"，why 是"这次对话为什么该发它"——
 * 用户要的是后者，前者只在没有后者时用来避免空白。
 */
export function describeResource(resource) {
  const why = String(resource?.why ?? "").trim() || String(resource?.headline ?? "").trim();
  const typeLabel = RESOURCE_TYPE_LABELS[resource?.sourceType] ?? "资料";
  const fileType = String(resource?.fileType ?? "").trim().toUpperCase();
  const score = Number(resource?.score);
  return {
    typeLabel,
    fileLabel: fileType || typeLabel,
    why,
    whyIsAi: Boolean(String(resource?.why ?? "").trim()),
    scoreText: Number.isFinite(score) ? score.toFixed(1) : "",
    /** 只有真有外链的才给「取链接」按钮：知识条目/产品是内联正文，点了也没链接可取。 */
    canReveal: Boolean(resource?.hasExternalLink),
    suggestedLine: String(resource?.suggestedLine ?? "").trim(),
    title: String(resource?.title ?? "").trim(),
    summary: String(resource?.summary ?? "").trim()
  };
}

/**
 * 整列的状态机（六档）。
 *
 * ⚠️ 与设计稿有一处**刻意的偏差**：「本机 CLI 不可用」不算 `blocked`，只算 `partial`。
 * 因为 CLI 只负责"挑得准不准"，资料本身照样取得到（退化成算法排序）。把它划进 blocked
 * 会让用户以为"整个功能不能用"，然后就不点开这一列了 —— 那才是真的不可用。
 * `blocked` 只留给"连 CRM 都没登录"这一种：那种情况下确实什么都取不到。
 */
export function columnState({ key, loggedIn, busy, result, error, cliAvailable, hasConversation } = {}) {
  if (!loggedIn) {
    return { state: "blocked", title: "还没登录 CRM", hint: "去扩展设置页的「CRM 连接」填一次账号密码" };
  }
  if (!hasConversation) {
    return { state: "idle", title: "切到一个会话就开始推荐", hint: "打开左侧任意一个客户会话" };
  }
  if (busy) {
    return { state: "scanning", title: "正在分析这段对话…", hint: "本机模型出稿通常要几十秒，别关页面" };
  }
  if (error) {
    return { state: "error", title: "这次没取到", hint: String(error) };
  }
  if (!result) {
    return { state: "idle", title: "还没分析这个会话", hint: "点「分析这个会话」开始" };
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
  const hasReply = Boolean(String(result.reply?.reply ?? "").trim()) && result.reply?.action === "reply";
  const resources = Array.isArray(result.resources) ? result.resources : [];
  if (!hasReply && !resources.length) {
    return {
      state: "partial",
      title: "这一轮没有可发的东西",
      hint: warnings[0] || String(result.reply?.reason ?? "模型认为这轮不需要回复，也没有对得上的资料")
    };
  }
  if (warnings.length || (cliAvailable === false && !result.curated)) {
    return {
      state: "partial",
      title: "拿到了，但有折损",
      hint: warnings[0] || "本机 CLI 不可用，资料按算法排序给出（没经模型复排）"
    };
  }
  return { state: "ready", title: `已分析（${key || "当前会话"}）`, hint: "" };
}

/**
 * 资料卡只认这些字段。
 *
 * 这是**白名单投影**，不是"挑几个字段用"。全系统的纪律是「真实外链只在用户点了
 * `reveal` 之后才存在」，那界面手里就**不该有**任何链接字段 —— 有它，早晚会有一个
 * "顺手渲染出来"的改动把它漏到页面上。服务端现在确实不下发，但这条防线要在这里。
 */
const RESOURCE_FIELDS = [
  "key",
  "sourceType",
  "id",
  "title",
  "fileType",
  "summary",
  "match",
  "reasons",
  "hitTerms",
  "why",
  "headline",
  "suggestedLine",
  "score",
  "hasExternalLink"
];

export function normalizeResource(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const field of RESOURCE_FIELDS) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  out.sourceType = String(out.sourceType ?? "");
  out.id = String(out.id ?? "");
  out.key = String(out.key ?? "") || `${out.sourceType}:${out.id}`;
  out.title = String(out.title ?? "");
  out.why = String(out.why ?? "");
  out.headline = String(out.headline ?? "");
  out.summary = String(out.summary ?? "");
  out.suggestedLine = String(out.suggestedLine ?? "");
  out.reasons = Array.isArray(out.reasons) ? out.reasons.filter(Boolean).map(String) : [];
  out.hitTerms = Array.isArray(out.hitTerms) ? out.hitTerms.filter(Boolean).map(String) : [];
  out.hasExternalLink = Boolean(out.hasExternalLink);
  const score = Number(out.score);
  out.score = Number.isFinite(score) ? score : null;
  return out;
}

/** 把 `/auto-chat/suggest` 的响应归一成界面直接能用的形状。字段缺了就补默认值，绝不让界面读 undefined。 */
export function normalizeSuggestion(body) {
  const raw = body && typeof body === "object" ? body : {};
  return {
    reply: raw.reply && typeof raw.reply === "object" ? raw.reply : null,
    resources: (Array.isArray(raw.resources) ? raw.resources : []).map(normalizeResource),
    curatorNote: String(raw.curatorNote ?? ""),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean).map(String) : [],
    curated: Boolean(raw.curated),
    model: raw.model ?? null,
    tookMs: Number(raw.tookMs) || 0
  };
}

/** reveal 的返回：要么一个真实链接，要么一段内联正文，要么一句原因。 */
export function revealOutcome(body) {
  if (!body?.ok) return { ok: false, reason: String(body?.reason ?? "暂时取不到链接") };
  const access = body.access ?? {};
  if (access.kind === "external") {
    return { ok: true, kind: "external", url: String(access.url ?? ""), shareCode: String(access.shareCode ?? "") };
  }
  return { ok: true, kind: "inline", content: String(access.content ?? "") };
}

/**
 * 「现在该不该重新分析」。
 *
 * 两个条件缺一不可：**会话变了**，且**距上次分析超过了防抖时长**。
 * 只看会话变会在一串会话里来回点的时候把请求打成一串；只看时间则换会话后永远不刷。
 */
export function refreshDecision({ previousKey, nextKey, lastAt, now = Date.now(), minIntervalMs = CONVERSATION_DEBOUNCE_MS } = {}) {
  if (!nextKey) return { refresh: false, reason: "no-conversation" };
  if (previousKey === nextKey) return { refresh: false, reason: "same-conversation" };
  const elapsed = Number(now) - Number(lastAt || 0);
  if (lastAt && elapsed < minIntervalMs) return { refresh: false, reason: "debounced" };
  return { refresh: true, reason: "conversation-changed" };
}

/** 面板顶部那一行状态摘要（把 warnings 压成一句人话，最多两条，不刷屏）。 */
export function warningsSummary(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
  if (!warnings.length) return "";
  const head = warnings.slice(0, 2).join("；");
  return warnings.length > 2 ? `${head}（另有 ${warnings.length - 2} 条）` : head;
}
