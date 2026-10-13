/**
 * 两段式翻译的接线自检：**直接驱动真的 `src/background.js`**。
 *
 * 为什么要有这一层（而不是只靠 e2e 或单测）：
 *   - `fastbase.test.mjs` 只测底座模块本身，测不到「谁先谁后、谁进缓存」；
 *   - e2e 用的是「页面侧桩」，那段桩自己重写了一遍 translate 流程 —— 真 background 的
 *     编排逻辑根本不在它的覆盖范围内；
 *   - 而这段编排恰好是本轮最容易静默出错的地方：
 *     ① 机译**不许**进缓存（进了就把"机译"永久钉在这句话上）；
 *     ② 精修结果必须经 `tabs.sendMessage` 推回页面（否则用户永远停在机译）；
 *     ③ 底座挂了必须**静默回退**到 AI，而不是把错误抛给用户。
 *
 * 做法：先铺一套 `chrome.*` 薄桩与 `fetch` 路由桩，再 `import` 真的 background.js，
 * 然后从它注册的 onMessage 监听器上直接调用 —— 走的是产品代码，不是复刻。
 *
 * 跑法：node tests/twotier.test.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
};

/* ---------------- chrome.* 薄桩 ---------------- */

const store = {};              // chrome.storage.local
const messageListeners = [];   // background 注册的 onMessage
const tabMessages = [];        // 推给页面的消息（精修就靠这里被观察到）

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onSuspend: { addListener: () => {} },
    openOptionsPage: async () => {},
    getURL: (value) => value,
    lastError: null
  },
  storage: {
    local: {
      get: async (key) => (typeof key === "string" ? (key in store ? { [key]: store[key] } : {}) : { ...store }),
      set: async (patch) => void Object.assign(store, patch),
      remove: async (key) => void delete store[key]
    },
    onChanged: { addListener: () => {} }
  },
  tabs: {
    query: (_query, callback) => {
      if (typeof callback === "function") callback([]);
      return Promise.resolve([]);
    },
    sendMessage: (tabId, message, callback) => {
      tabMessages.push({ tabId, message });
      if (typeof callback === "function") callback();
      return Promise.resolve();
    }
  },
  permissions: { contains: async () => true, request: async () => true }
};

/* ---------------- fetch 路由桩 ---------------- */

const MT_URL = "https://api.mymemory.translated.net/get";
const AI_URL = "https://api.example.com/v1/chat/completions";

let mtMode = "ok";      // ok | quota | boom
let mtCalls = 0;
let aiCalls = 0;
/**
 * AI 响应闸门：不放开它就一直是 pending —— 这样才能稳定地观察"精修还没回来"时的状态。
 *
 * ⚠️ 闸门必须是**一个共享 promise**，不能每次调用新造一个：
 * 第一版里两次精修各造各的闸门，后一个把前一个的 resolver 覆盖掉了，
 * 于是 `openGate()` 只放行了最后一个 —— 表现成"怎么只推了一条"，
 * 看起来像产品漏推，其实是自检自己把前一个承诺弄丢了。
 */
let aiGate = null;
let aiRelease = null;
let aiGateOpen = false;

function armGate() {
  aiGate = new Promise((resolve) => {
    aiRelease = resolve;
  });
  aiGateOpen = false;
}

function openGate() {
  aiGateOpen = true;
  if (aiRelease) aiRelease();
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.startsWith(MT_URL)) {
    mtCalls += 1;
    if (mtMode === "boom") throw new Error("底座连不上");
    if (mtMode === "quota") {
      return jsonResponse({
        responseStatus: 403,
        quotaFinished: true,
        responseDetails: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY"
      });
    }
    return jsonResponse({ responseStatus: 200, responseData: { translatedText: `机译：${new URL(target).searchParams.get("q")}` } });
  }
  if (target === AI_URL) {
    aiCalls += 1;
    if (!aiGateOpen) await aiGate;
    return jsonResponse({
      choices: [{ message: { content: `AI 译文（第 ${aiCalls} 次）` } }],
      usage: { total_tokens: 42 }
    });
  }
  throw new Error(`未预期的请求：${target}`);
};

/* ---------------- 载入真的 background.js ---------------- */

await import(path.join(here, "../src/background.js"));

const call = (message, sender = { tab: { id: 77 } }) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("background 没有回调")), 8000);
    messageListeners[0](message, sender, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

const waitFor = async (probe, timeoutMs = 4000) => {
  const startedAt = Date.now();
  for (;;) {
    if (await probe()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const TEXT = "Hola, nos interesan 500 unidades. Podrían compartir el precio FOB?";

function setSettings(patch) {
  store.gj_translator_settings = {
    enabled: true,
    targetLang: "zh-CN",
    apiBase: "https://api.example.com/v1",
    apiKey: "test-key",
    model: "gpt-5.6-sol",
    stream: false,
    timeoutMs: 8000,
    firstTokenMs: 8000,
    ...patch
  };
}

/**
 * 段间归零。
 *
 * ⚠️ 光清 `store` 不够 —— background 有一份**内存**缓存（`cacheEntries`），
 * 只清 storage 的话下一段会命中上一段的缓存，测出来的全是假的
 * （第一版就是这么错的：所有"回退 AI"的断言都拿到 cached 的旧结果）。
 * 所以必须走产品自己的 `clearCache` 指令，两条路一起清。
 */
const reset = async () => {
  await call({ type: "clearCache" });
  mtCalls = 0;
  aiCalls = 0;
  armGate();
  mtMode = "ok";
  tabMessages.length = 0;
};

/* ================= 1. 两段式：先机译、后精修 ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL });
const first = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN", refineToken: "tok-1" });

check("先返回的是机译", first.ok === true && first.tier === "mt", JSON.stringify(first).slice(0, 120));
check("机译带底座名与耗时", first.base === "mymemory" && Number(first.totalMs) >= 0, String(first.base));
check("机译带「正在精修」标记（AI 可用时）", first.refining === true, String(first.refining));
check("机译文本来自底座", String(first.text).startsWith("机译："), String(first.text));
check("此时还没打过 AI", aiCalls === 1, `aiCalls=${aiCalls}`);

/**
 * ⚠️ 关键断言：**机译不进缓存**。
 * 再翻一次同一句话，如果返回 `cached` 就说明机译被写进缓存了 ——
 * 后果是精修一旦失败，这句话就永久停在机译上，用户再没有机会看到 AI 版本。
 */
const second = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN", refineToken: "tok-2" });
check("机译不进缓存（第二次仍走底座，不是 cached）", !second.cached && second.tier === "mt", JSON.stringify(second).slice(0, 120));
check("底座被真的问了两次", mtCalls === 2, `mtCalls=${mtCalls}`);

// 放开 AI 闸门，等精修回来
const gated = await waitFor(() => Promise.resolve(aiCalls >= 1), 1500);
check("精修请求已经发出（且不阻塞初译）", gated);
openGate();
const refined = await waitFor(() => Promise.resolve(tabMessages.some((item) => item.message?.type === "translateRefined")), 4000);
check("精修结果被推回页面（tabs.sendMessage）", refined, JSON.stringify(tabMessages).slice(0, 200));
const pushes = tabMessages.filter((item) => item.message?.type === "translateRefined");
const tokens = [...new Set(pushes.map((item) => item.message.token))].sort();
check(
  "每次请求的精修推的都是**它自己**的令牌（靠文本匹配会在「客户连发两条一样的话」时认错行）",
  tokens.join(",") === "tok-1,tok-2",
  tokens.join(",")
);
check("推送里是 AI 译文", String(pushes[0]?.message?.text || "").startsWith("AI 译文"), String(pushes[0]?.message?.text));
check("推给了发起翻译的那个标签页", pushes.every((item) => item.tabId === 77), JSON.stringify(pushes.map((i) => i.tabId)));

// 精修落缓存后，同一句话应该直接命中缓存
const cachedAi = await waitFor(async () => {
  const again = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
  return again.cached === true && String(again.text).startsWith("AI 译文");
}, 4000);
check("精修结果落进缓存，再翻同一句直接命中", cachedAi, "");

/* ================= 2. 底座额度用完 → 静默回退 AI ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, timeoutMs: 8000 });
mtMode = "quota";
aiGateOpen = true;
const fallback = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check("额度用完时不报错，直接由 AI 出译文", fallback.ok === true && fallback.tier === "ai", JSON.stringify(fallback).slice(0, 140));
check("回退后返回的是 AI 译文", String(fallback.text).startsWith("AI 译文"), String(fallback.text));
check("回退路径真的调了 AI", aiCalls === 1, `aiCalls=${aiCalls}`);

/* ================= 3. 底座连不上 → 同样回退 ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL });
mtMode = "boom";
aiGateOpen = true;
const fallback2 = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check("底座连不上也回退 AI，不把错误甩给用户", fallback2.ok === true && fallback2.tier === "ai", JSON.stringify(fallback2).slice(0, 140));
const status = await call({ type: "status" });
check("但失败原因留在自检里（否则「为什么这次慢」答不上来）", String(status.lastFastBaseError || "").includes("连不上"), String(status.lastFastBaseError));

/* ================= 4. 底座关掉 → 只有 AI 一条路 ================= */

await reset();
setSettings({ fastBase: "off" });
aiGateOpen = true;
const aiOnly = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check("底座关掉后不再碰第三方", mtCalls === 0, `mtCalls=${mtCalls}`);
check("仍然正常出 AI 译文", aiOnly.ok === true && aiOnly.tier === "ai", JSON.stringify(aiOnly).slice(0, 120));
check("关掉时不承诺「精修中」", aiOnly.refining === undefined && aiOnly.refineToken === undefined, JSON.stringify(aiOnly).slice(0, 120));

/* ================= 5. 只有底座、没配 AI → 仍然可用 ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, apiKey: "", model: "" });
const mtOnly = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check("没配 AI Key 也能翻（底座兜底）", mtOnly.ok === true && mtOnly.tier === "mt", JSON.stringify(mtOnly).slice(0, 140));
check("没配 AI 时不谎称「精修中」（否则界面上挂一个永远不来的状态）", mtOnly.refining === false, String(mtOnly.refining));
check("没配 AI 时不会去打 AI", aiCalls === 0, `aiCalls=${aiCalls}`);

/* ================= 6. 两边都不可用 → 说清楚是底座先失败 ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, apiKey: "", model: "" });
mtMode = "boom";
const neither = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check(
  "两边都不可用时给出**可行动**的提示（说清是哪一层失败 + 下一步做什么）",
  neither.ok === false &&
    String(neither.error).includes("底座") &&
    String(neither.error).includes("打开设置"),
  String(neither.error)
);

/* ================= 7. 中文不翻 / 空文本 ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL });
const empty = await call({ type: "translate", text: "   ", targetLang: "zh-CN" });
check("空文本直接拒绝", empty.ok === false && String(empty.error).includes("没有"), String(empty.error));

/* ================= 8. 精修**永不代发** ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL });
aiGateOpen = true;
await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN", refineToken: "tok-x" });
await waitFor(() => Promise.resolve(tabMessages.some((item) => item.message?.type === "translateRefined")), 2000);
const kinds = [...new Set(tabMessages.map((item) => item.message?.type))];
check(
  "精修只推 translateRefined 这一种消息（不存在任何「发送」动作）",
  kinds.every((kind) => kind === "translateRefined"),
  JSON.stringify(kinds)
);

/* ================= 9. 引擎三选一（0.7.0：只用机译 / 只用 AI） ================= */

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, engineMode: "mt" });
const engineMt = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN", refineToken: "tok-mt" });
check("只用机译：出的还是机译", engineMt.ok === true && engineMt.tier === "mt", JSON.stringify(engineMt).slice(0, 120));
check("只用机译：不承诺精修（AI 这条路被关了）", engineMt.refining === false, String(engineMt.refining));
await waitFor(() => Promise.resolve(aiCalls >= 1), 1200);
check("只用机译：AI 一次都没被打（没有偷偷精修）", aiCalls === 0, `aiCalls=${aiCalls}`);

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, engineMode: "mt" });
mtMode = "boom";
const engineMtFail = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check(
  "只用机译 + 底座挂：照实报错并指出当前引擎（绝不悄悄改走 AI）",
  engineMtFail.ok === false && String(engineMtFail.error).includes("只用机译"),
  String(engineMtFail.error)
);
check("只用机译 + 底座挂：AI 依然没被打", aiCalls === 0, `aiCalls=${aiCalls}`);

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, engineMode: "ai" });
aiGateOpen = true;
const engineAi = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check("只用 AI：直接出 AI 译文（tier=ai）", engineAi.ok === true && engineAi.tier === "ai", JSON.stringify(engineAi).slice(0, 120));
check("只用 AI：底座一次都没被打（跳过机译打底）", mtCalls === 0, `mtCalls=${mtCalls}`);

await reset();
setSettings({ fastBase: "mymemory", fastBaseUrl: MT_URL, engineMode: "bogus" });
const engineBogus = await call({ type: "translate", text: TEXT, sourceLang: "es", targetLang: "zh-CN" });
check("engineMode 是乱值时按默认混合走（先机译后精修）", engineBogus.ok === true && engineBogus.tier === "mt" && engineBogus.refining === true, JSON.stringify(engineBogus).slice(0, 120));

/* ---------------- 汇总 ---------------- */

if (failures.length) {
  console.error(`\n✗ twotier 自检失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ twotier 两段式接线自检全通过（${passed} 项）`);
process.exit(0);
