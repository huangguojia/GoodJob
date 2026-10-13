/**
 * 草稿翻译的方向判定与自动闸门单测。
 *
 * 这两个函数决定"打了中文之后会发生什么"：
 *   draftTarget          —— 该译成哪种语言
 *   shouldAutoTranslate  —— 这一轮到底该不该发请求
 * 都是纯函数，不碰浏览器、不连网络。跑法：node tests/draft.test.mjs
 */

import { DEFAULT_SETTINGS, draftTarget, isChineseText, shouldAutoTranslate } from "../src/settings.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

const settings = { ...DEFAULT_SETTINGS, targetLang: "zh-CN", replyLang: "en" };

/* ---------- 方向：中文草稿出去要变外文 ---------- */

const cn = draftTarget("帮我算一下 500 件的 FOB 价格", settings);
check("中文草稿判为中文", cn.chinese === true);
check("中文草稿译成 replyLang", cn.targetLang === "en", cn.targetLang);
check("中文草稿源语言写 zh-CN", cn.sourceLang === "zh-CN", cn.sourceLang);

const cnEs = draftTarget("谢谢，请尽快确认", { ...settings, replyLang: "es" });
check("replyLang 改成西语就译西语", cnEs.targetLang === "es", cnEs.targetLang);

/* ---------- 方向：外文草稿是"看意思"，走 targetLang ---------- */

const en = draftTarget("Thanks, please confirm the PI.", settings);
check("英文草稿不算中文", en.chinese === false);
check("英文草稿译成 targetLang", en.targetLang === "zh-CN", en.targetLang);
check("英文草稿源语言判为 en", en.sourceLang === "en", en.sourceLang);

const es = draftTarget("Hola, gracias por su pedido", { ...settings, targetLang: "fr" });
check("西语草稿源语言判为 es", es.sourceLang === "es", es.sourceLang);
check("非中文草稿走自定义 targetLang", es.targetLang === "fr", es.targetLang);

/* ---------- 方向：日语带汉字，不能被当成中文 ---------- */

const ja = draftTarget("ありがとうございます。納期を教えてください", settings);
check("日语草稿不算中文（否则会「中文译中文」）", ja.chinese === false, JSON.stringify(ja));

/* ---------- 方向：没读到设置时也要有可用默认值 ---------- */

const fallback = draftTarget("你好", null);
check("settings 为 null 时中文仍译英语", fallback.targetLang === "en", fallback.targetLang);
check("settings 为 null 时判中文仍正确", fallback.chinese === true);

/* ---------- 闸门：逐条挡掉不该发的请求 ---------- */

const base = { text: "请报 500 件的价格", lastText: "", enabled: true, now: 1000, guardUntil: 0 };

check("中文新草稿 → 该翻", shouldAutoTranslate(base).run === true);
check("返回的 reason 是 ok", shouldAutoTranslate(base).reason === "ok");

check("开关关掉 → 不翻", shouldAutoTranslate({ ...base, enabled: false }).reason === "disabled");
check("空草稿 → 不翻", shouldAutoTranslate({ ...base, text: "" }).reason === "empty");
check("纯空白 → 不翻", shouldAutoTranslate({ ...base, text: "   \n  " }).reason === "empty");
check("英文草稿 → 不翻", shouldAutoTranslate({ ...base, text: "Could you quote 500 pcs?" }).reason === "not-chinese");
check(
  "同一份草稿 → 不重复翻（打字过程中 input 会连续触发）",
  shouldAutoTranslate({ ...base, lastText: base.text }).reason === "already"
);

/* 抑制窗口：刚点过「替换到输入框」，那一次内容变化是我们自己造成的 */
const guarded = shouldAutoTranslate({ ...base, text: "Please quote 500 pcs FOB", guardUntil: 2000, now: 1500 });
check("抑制窗口内的变化 → 不翻", guarded.reason === "guarded", guarded.reason);
check(
  "抑制窗口过后照常翻",
  shouldAutoTranslate({ ...base, text: "再补一句", guardUntil: 2000, now: 2100 }).run === true
);

/* 优先级：用户把自动翻译整个关掉时，不该因为别的原因去修浮框 */
check(
  "disabled 优先级高于其它判定",
  shouldAutoTranslate({ text: "", enabled: false }).reason === "disabled"
);
check(
  "guarded 优先于 not-chinese（替换后输入框已经变成英文了）",
  shouldAutoTranslate({ text: "Quoted 500 pcs", enabled: true, guardUntil: 2000, now: 1500 }).reason === "guarded"
);

/* ---------- 与草稿相关的 isChineseText 边界 ---------- */

check("两个汉字算中文（阈值是 2）", isChineseText("好的") === true);
check("单字不算（避免短词误判）", isChineseText("好") === false);
check("中文夹英文报价仍算中文", isChineseText("这批 500 pcs 的价格是多少") === true);
check("纯英文不算中文", isChineseText("Please confirm the order") === false);

/* ---------- 输出 ---------- */

console.log(`\n草稿翻译单测：通过 ${passed} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
