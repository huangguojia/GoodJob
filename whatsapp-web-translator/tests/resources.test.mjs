/**
 * 右侧整列的纯逻辑单测。
 *
 * 这一层测的不是"画得好看"，而是三件会让用户实际踩坑的事：
 *   1. **宽度与布局**：拖到多宽算合法、什么时候必须退化成覆盖式（不然聊天区被挤到不能用）；
 *   2. **状态机**：拿到一半、什么都没拿到、没登录 —— 界面分别该说什么（说错了用户就以为坏了）；
 *   3. **展示口径**：「为什么推荐」到底取自哪个字段、徽章从哪来、什么时候不许给「复制链接」。
 *
 * 跑法：node tests/resources.test.mjs
 */

import {
  COLUMN_DEFAULTS,
  COLUMN_LIMITS,
  COLUMN_KEY,
  CONVERSATION_DEBOUNCE_MS,
  MAX_TRANSCRIPT_MESSAGES,
  RESOURCE_TYPE_LABELS,
  SOURCE_LABELS,
  buildSuggestPayload,
  clampColumnWidth,
  columnPrefsPatch,
  columnState,
  conversationKeyOf,
  describeResource,
  normalizeResource,
  normalizeSuggestion,
  readColumnPrefs,
  refreshDecision,
  resolveLayout,
  revealOutcome,
  sourceBadges,
  warningsSummary
} from "../src/resources.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

/* ---------- 一、宽度与布局 ---------- */

check("宽度夹在 320–720 之间", clampColumnWidth(200) === COLUMN_LIMITS.min && clampColumnWidth(9999) === COLUMN_LIMITS.max);
check("非数字回落默认宽度", clampColumnWidth("abc") === COLUMN_DEFAULTS.width && clampColumnWidth(undefined) === COLUMN_DEFAULTS.width);
check("宽度取整（拖拽出来的是小数）", clampColumnWidth(412.7) === 413);

check(
  "宽视口推窄：push 等于列宽（这是「一整列」与「浮层」的本质区别）",
  (() => {
    const layout = resolveLayout({ width: 420, collapsed: false, viewportWidth: 1440 });
    return layout.mode === "push" && layout.push === 420 && layout.columnWidth === 420;
  })()
);
check(
  "窄视口退化成覆盖式：push 必须是 0（再推聊天区就没法用了）",
  (() => {
    const layout = resolveLayout({ width: 420, collapsed: false, viewportWidth: 900 });
    return layout.mode === "overlay" && layout.push === 0;
  })()
);
check(
  "折叠态只占 44px 且什么都不推",
  (() => {
    const layout = resolveLayout({ width: 420, collapsed: true, viewportWidth: 1440 });
    return layout.mode === "rail" && layout.columnWidth === COLUMN_LIMITS.collapsed && layout.push === 0;
  })()
);

check(
  "storage 里的东西一律当不可信：脏数据回落默认值",
  (() => {
    const prefs = readColumnPrefs("garbage");
    return prefs.width === COLUMN_DEFAULTS.width && prefs.collapsed === false;
  })() &&
    readColumnPrefs({ width: 120 }).width === COLUMN_LIMITS.min &&
    readColumnPrefs({ width: 5000 }).width === COLUMN_LIMITS.max &&
    readColumnPrefs({ width: 500, collapsed: 1 }).collapsed === true
);

check(
  "写回 storage 的键与形状固定（下次打开还记得）",
  (() => {
    const patch = columnPrefsPatch({ width: 512, collapsed: true });
    return COLUMN_KEY in patch && patch[COLUMN_KEY].width === 512 && patch[COLUMN_KEY].collapsed === true;
  })()
);

/* ---------- 二、会话身份与 payload ---------- */

check("会话键优先用号码（与 CRM 认客户同一口径）", conversationKeyOf({ contactPhone: "+49 1234 567890", contactName: "Ann" }) === "wa:+491234567890");
check("没号码才退回名字", conversationKeyOf({ contactPhone: "", contactName: "Ann Weber" }) === "wa:name:Ann Weber");
check("都没有才用兜底键", conversationKeyOf({}, "wa:492222333@c.us") === "wa:492222333@c.us");
check(
  "同一个客户改了备注名，会话键不变（否则改名会白跑一次几十秒的生成）",
  conversationKeyOf({ contactPhone: "+492222333", contactName: "Ana" }) === conversationKeyOf({ contactPhone: "+492222333", contactName: "Ana Torres" })
);

{
  const payload = buildSuggestPayload({
    messages: [
      { direction: "inbound", body: "hi" },
      { direction: "outbound", body: "  " },
      { direction: "weird", body: "?" }
    ],
    contact: { contactPhone: "+49 1", contactName: "Ann" },
    withAi: false,
    limit: 99
  });
  check("空正文被丢掉，方向非法一律当 inbound", payload.messages.length === 2 && payload.messages[1].direction === "inbound");
  check("联系人字段名对齐服务端的 contactPhone/contactName", payload.contact.phone === "+49 1" && payload.contact.name === "Ann");
  check("withAi:false 显式下发（快速路径）", payload.withAi === false);
  check("limit 被夹到 20 以内", payload.limit === 20, String(payload.limit));
}

{
  const many = Array.from({ length: 40 }, (_, index) => ({ direction: "inbound", body: `m${index}` }));
  const payload = buildSuggestPayload({ messages: many, contact: {} });
  check("转写截到最近 20 条（与服务端上限对齐）", payload.messages.length === MAX_TRANSCRIPT_MESSAGES && payload.messages.at(-1).body === "m39");
  check("默认不加 withAi 键（服务端默认就是要 AI）", !("withAi" in payload));
}

/* ---------- 三、徽章与资料展示 ---------- */

check(
  "来源徽章按固定顺序给中文标签",
  (() => {
    const badges = sourceBadges({ sources: ["profile", "crm_followup", "knowledge"] });
    return badges.map((item) => item.key).join(",") === "profile,crm_followup,knowledge" && badges[0].label === SOURCE_LABELS.profile;
  })()
);
check("认不出的来源被丢掉（不显示空白徽章）", sourceBadges({ sources: ["nope", "library"] }).length === 1);
check("没有 sources 字段时不炸", sourceBadges(null).length === 0 && sourceBadges({}).length === 0);

check(
  "「为什么推荐」优先取 AI 复排的 why，没有才退到算法的 headline",
  (() => {
    const withWhy = describeResource({ why: "客户点名要规格书", headline: "「led」对上了", sourceType: "file", fileType: "pdf" });
    const without = describeResource({ why: "  ", headline: "「led」对上了", sourceType: "file", fileType: "pdf" });
    return withWhy.why === "客户点名要规格书" && withWhy.whyIsAi === true && without.why === "「led」对上了" && without.whyIsAi === false;
  })()
);
check(
  "类型徽章：有文件类型用大写后缀，没有就用中文类目",
  (() => {
    const a = describeResource({ sourceType: "file", fileType: "pdf", score: 12.345 });
    const b = describeResource({ sourceType: "knowledge", fileType: "" });
    return a.fileLabel === "PDF" && a.scoreText === "12.3" && b.fileLabel === RESOURCE_TYPE_LABELS.knowledge;
  })()
);
check(
  "只有真有外链的才给「复制链接」（知识条目是内联正文，点了也没链接）",
  describeResource({ hasExternalLink: true }).canReveal === true && describeResource({ hasExternalLink: false }).canReveal === false
);

/* ---------- 四、六态状态机 ---------- */

check("没登录 CRM → blocked，并说清去哪儿登录", (() => {
  const state = columnState({ loggedIn: false, hasConversation: true });
  return state.state === "blocked" && state.hint.includes("设置");
})());
check("没会话 → idle 引导", (() => {
  const state = columnState({ loggedIn: true, hasConversation: false });
  return state.state === "idle" && state.title.includes("切到一个会话");
})());
check("请求中 → scanning（界面出骨架屏）", columnState({ loggedIn: true, hasConversation: true, busy: true }).state === "scanning");
check("取数失败 → error，并且把原始原因带出来", (() => {
  const state = columnState({ loggedIn: true, hasConversation: true, error: "连不上插件（http://127.0.0.1:3100）" });
  return state.state === "error" && state.hint.includes("127.0.0.1:3100");
})());
check("还没分析过 → idle", columnState({ loggedIn: true, hasConversation: true, result: null }).state === "idle");

const readyResult = {
  reply: { action: "reply", reply: "Here you go." },
  resources: [{ id: "r1" }],
  warnings: [],
  curated: true
};
check("拿到回复 + 资料且无警告 → ready", columnState({ loggedIn: true, hasConversation: true, result: readyResult, cliAvailable: true }).state === "ready");

check(
  "有折损（warnings 非空）→ partial，并把第一条原因写进提示",
  (() => {
    const state = columnState({
      loggedIn: true,
      hasConversation: true,
      result: { ...readyResult, warnings: ["向量库为空（未启用）"] },
      cliAvailable: true
    });
    return state.state === "partial" && state.hint === "向量库为空（未启用）";
  })()
);

check(
  "CLI 不可用不算 blocked，只算 partial —— 资料照样取得到（刻意与设计稿不同的地方）",
  (() => {
    const state = columnState({
      loggedIn: true,
      hasConversation: true,
      result: { ...readyResult, curated: false, warnings: [] },
      cliAvailable: false
    });
    return state.state === "partial" && state.hint.includes("CLI");
  })()
);

check(
  "两边都空 → partial，并说明为什么没有东西可发",
  (() => {
    const state = columnState({
      loggedIn: true,
      hasConversation: true,
      result: { reply: { action: "skip", reply: "", reason: "客户最后一条是媒体占位" }, resources: [], warnings: [], curated: false },
      cliAvailable: true
    });
    return state.state === "partial" && state.hint.includes("媒体占位");
  })()
);

/* ---------- 五、响应归一与 reveal ---------- */

check(
  "服务端少给字段时界面读到的是默认值，不是 undefined",
  (() => {
    const normalized = normalizeSuggestion({});
    return (
      normalized.reply === null &&
      Array.isArray(normalized.resources) &&
      normalized.resources.length === 0 &&
      normalized.curatorNote === "" &&
      normalized.warnings.length === 0 &&
      normalized.curated === false
    );
  })()
);
check(
  "warnings 里的空串被剔掉（否则界面会出现一行空白折损）",
  normalizeSuggestion({ warnings: ["", "真的原因", null] }).warnings.length === 1
);

check("reveal 返回 ok:false 时给一句可直接显示的原因", (() => {
  const outcome = revealOutcome({ ok: false, reason: "CRM 返回 HTTP 404" });
  return outcome.ok === false && outcome.reason.includes("404");
})());
check("没给原因也要有兜底文案", revealOutcome({ ok: false }).reason.length > 0);
check(
  "外链与提取码分开取（提取码要显示给用户，不能吞掉）",
  (() => {
    const outcome = revealOutcome({ ok: true, access: { kind: "external", url: "https://x/y", shareCode: "x7k2" } });
    return outcome.ok && outcome.kind === "external" && outcome.url === "https://x/y" && outcome.shareCode === "x7k2";
  })()
);
check(
  "内联正文走另一条分支（知识条目没有链接）",
  (() => {
    const outcome = revealOutcome({ ok: true, access: { kind: "inline", content: "正文" } });
    return outcome.ok && outcome.kind === "inline" && outcome.content === "正文";
  })()
);

/* ---------- 六、资料的字段白名单：界面手里不许有任何链接 ---------- */

/*
 * 「真实外链只在用户点了 reveal 之后才存在」是全系统的硬纪律。
 * 服务端（以及将来的某次改动）万一在列表里带上地址，界面手里有它就迟早会渲染出来 ——
 * 所以这里按白名单投影，多余字段一律丢掉。这几条断言盯的就是"丢掉"。
 */
check(
  "资料对象里的链接字段一律被丢掉（sourceUrl / downloadUrl / shareCode / url）",
  (() => {
    const normalized = normalizeResource({
      id: "11",
      sourceType: "file",
      title: "规格书",
      sourceUrl: "https://leak.example.test/a.pdf",
      downloadUrl: "https://leak.example.test/b.pdf",
      shareCode: "a1b2",
      url: "https://leak.example.test/c.pdf"
    });
    return !("sourceUrl" in normalized) && !("downloadUrl" in normalized) && !("shareCode" in normalized) && !("url" in normalized);
  })()
);
check(
  "真链路上整条 suggest 响应里的地址也进不来（不是只挡住了单份资料）",
  (() => {
    const normalized = normalizeSuggestion({
      resources: [{ id: "11", sourceType: "file", sourceUrl: "https://leak.example.test/a.pdf" }]
    });
    return normalized.resources.length === 1 && !("sourceUrl" in normalized.resources[0]);
  })()
);
check(
  "白名单里该留的字段一个不少（otherwise 界面会读不到标题/相关度）",
  (() => {
    const normalized = normalizeResource({
      id: "11",
      sourceType: "file",
      title: "规格书",
      fileType: "pdf",
      summary: "摘要",
      why: "客户问的就是它",
      headline: "命中 MOQ",
      suggestedLine: "Our MOQ is 10 pcs.",
      score: 92.5,
      hasExternalLink: true,
      hitTerms: ["MOQ"],
      reasons: ["客户问到起订量"]
    });
    return (
      normalized.title === "规格书" &&
      normalized.fileType === "pdf" &&
      normalized.why === "客户问的就是它" &&
      normalized.headline === "命中 MOQ" &&
      normalized.suggestedLine === "Our MOQ is 10 pcs." &&
      normalized.score === 92.5 &&
      normalized.hasExternalLink === true &&
      normalized.hitTerms.length === 1
    );
  })()
);
check(
  "key 缺失时按 sourceType:id 兜底（面板靠它去重与记忆「已复制」）",
  normalizeResource({ sourceType: "file", id: "11" }).key === "file:11"
);
check(
  "score 不是数字时给 null 而不是 NaN（NaN 会渲染成「相关度 NaN」）",
  (() => {
    const normalized = normalizeResource({ id: "1", sourceType: "file", score: "很高" });
    return normalized.score === null && !Number.isNaN(normalized.score);
  })()
);
check(
  "传给 normalizeResource 的不是对象也不炸（服务端永远可能给 null）",
  normalizeResource(null).title === "" && normalizeResource(undefined).reasons.length === 0
);

/* ---------- 七、什么时候该自动重刷 ---------- */

const now = 1_000_000;
check("换了会话且过了防抖 → 刷", refreshDecision({ previousKey: "wa:+1", nextKey: "wa:+2", lastAt: now - CONVERSATION_DEBOUNCE_MS - 1, now }).refresh === true);
check("同一个会话 → 不刷（防抖窗口内来回切不该打请求）", refreshDecision({ previousKey: "wa:+1", nextKey: "wa:+1", lastAt: now - 99_999, now }).refresh === false);
check("刚分析完就切走 → 仍然防抖住", refreshDecision({ previousKey: "wa:+1", nextKey: "wa:+2", lastAt: now - 200, now }).refresh === false);
check("从没有会话变成有会话 → 刷", refreshDecision({ previousKey: "", nextKey: "wa:+1", lastAt: 0, now }).refresh === true);
check("没会话 → 不刷", refreshDecision({ previousKey: "wa:+1", nextKey: "", lastAt: 0, now }).refresh === false);

check(
  "折损摘要最多两条（面板不刷屏）",
  (() => {
    const one = warningsSummary({ warnings: ["甲"] });
    const many = warningsSummary({ warnings: ["甲", "乙", "丙", "丁"] });
    return one === "甲" && many.startsWith("甲；乙") && many.includes("另有 2 条");
  })()
);
check("没有折损时给空串，界面据此不渲染那一行", warningsSummary({ warnings: [] }) === "" && warningsSummary(null) === "");

/* ---------- 输出 ---------- */

console.log(`\n右侧整列纯逻辑单测：通过 ${passed} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
