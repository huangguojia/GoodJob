/**
 * 快速底座单测：不碰浏览器、不连网络（fetch 全部注入桩）。
 *
 * 这一层值得单测的原因 —— 它有两个"静默出错"的坑，错了界面上看不出来：
 *   1. 底座**不一定改 HTTP 状态码**。额度用完时它回 200，然后把一句英文警告
 *      (`MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS TODAY`) 塞进
 *      `responseData.translatedText`。只看状态码的话，**这句警告会原样出现在客户消息下面**。
 *   2. 它接不了的语向会**原样回吐原文**。当译文显示等于原文的长消息，用户会以为扩展坏了。
 *
 * 跑法：node tests/fastbase.test.mjs
 */

import {
  FAST_BASE_MYMEMORY,
  FAST_BASE_QUOTA_CODE,
  FAST_BASE_TIMEOUT_CODE,
  fastBaseEndpoint,
  fastBaseLabel,
  fastTranslate,
  isFastBaseEnabled,
  pickFastTranslation,
  probeFastBase,
  splitForBase,
  toBaseLang
} from "../src/fast-base.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

/** 记下每次请求的 URL，并回一个固定响应 */
function stubFetch(payload, capture = [], status = 200) {
  return async (url) => {
    capture.push(String(url));
    return jsonResponse(payload, status);
  };
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload
  };
}

function ok(text) {
  return { responseStatus: 200, responseData: { translatedText: text } };
}

const settings = { fastBase: FAST_BASE_MYMEMORY, fastBaseTimeoutMs: 6000 };

/* ---------- 开关与地址 ---------- */

check("默认（mymemory）算打开", isFastBaseEnabled({ fastBase: "mymemory" }) === true);
check("off 算关闭", isFastBaseEnabled({ fastBase: "off" }) === false);
check("空值算关闭", isFastBaseEnabled({ fastBase: "" }) === false);
check("缺字段算关闭", isFastBaseEnabled({}) === false);
check(
  "地址默认落到 MyMemory",
  fastBaseEndpoint({ fastBase: "mymemory" }).startsWith("https://api.mymemory.translated.net/"),
  fastBaseEndpoint({ fastBase: "mymemory" })
);
check(
  "显式配的地址优先（自检要能把它指到本地 mock）",
  fastBaseEndpoint({ fastBase: "mymemory", fastBaseUrl: "http://127.0.0.1:9/x" }) === "http://127.0.0.1:9/x"
);
check("标签里带「无需 Key」提示", fastBaseLabel("mymemory").includes("无需 Key"), fastBaseLabel("mymemory"));

/* ---------- 语言码 ---------- */

check("中文要写成 zh-CN（只给 zh 会落到繁体）", toBaseLang("zh-CN") === "zh-CN");
check("zh_Hans 归一成 zh-CN", toBaseLang("zh_Hans") === "zh-CN");
check("zh-Hant 也归到 zh-CN（我们不区分繁简，但必须给出确定值）", toBaseLang("zh-Hant") === "zh-CN");
check("普通语种原样", toBaseLang("es") === "es");
check("大写归一", toBaseLang("EN") === "en");
check("空值给空串（调用方据此判失败）", toBaseLang("") === "");

/* ---------- 分片 ---------- */

check("单行短句 → 一片", splitForBase("Hola, precio FOB?").length === 1);
check(
  "多行短句**必须攒成一片**（一行一请求的话，5 行消息就是 5 次往返，秒出就白做了）",
  splitForBase("Hola\nGracias\nPrecio FOB?").length === 1,
  JSON.stringify(splitForBase("Hola\nGracias\nPrecio FOB?"))
);
check("攒片时保留换行", splitForBase("Hola\nGracias")[0] === "Hola\nGracias");
check("空文本 → 零片", splitForBase("   ").length === 0);
const long = splitForBase("a".repeat(1200));
check("超长文本会分片", long.length === 3, String(long.length));
check("每片不超预算", long.every((chunk) => chunk.length <= 450), long.map((c) => c.length).join(","));
// 12 行 × 约 52 字符 = 约 640 字符，必然超一片的预算
const manyLines = splitForBase(Array.from({ length: 12 }, (_, i) => `line ${i} ${"x".repeat(44)}`).join("\n"));
check("多行累积超预算也会分片", manyLines.length === 2, String(manyLines.length));
check(
  "分片后内容一字不丢（去掉换行差异后相等）",
  manyLines.join("\n").replace(/\s+/gu, "") ===
    Array.from({ length: 12 }, (_, i) => `line ${i} ${"x".repeat(44)}`)
      .join("\n")
      .replace(/\s+/gu, "")
);

/* ---------- 错误判据（这几条是防"警告文案被当译文显示"） ---------- */

function rejected(payload, original) {
  try {
    pickFastTranslation(payload, original);
    return "";
  } catch (error) {
    return error?.code ? `${error.code}:${error.message}` : error.message;
  }
}

check(
  "额度用完（HTTP 200 + quotaFinished）→ 拒",
  rejected({ responseStatus: 200, quotaFinished: true, responseData: { translatedText: "x" } }).includes("额度")
);
check(
  "额度用完（403 + responseDetails 警告）→ 带 QUOTA 判据",
  rejected({
    responseStatus: 403,
    responseDetails: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY"
  }).includes(FAST_BASE_QUOTA_CODE)
);
check(
  "警告文本被塞进 translatedText（200）→ 必须拒，绝不能显示在客户消息下面",
  rejected(ok("MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY")).includes("MYMEMORY WARNING")
);
check(
  "语向不支持（QUERY LENGTH LIMIT）→ 拒",
  rejected(ok("QUERY LENGTH LIMIT EXCEEDED")).includes("QUERY LENGTH")
);
check(
  "原样回吐原文（长文本）→ 拒",
  rejected(ok("Hola, nos interesan 500 unidades."), "Hola, nos interesan 500 unidades.").includes("原样返回")
);
check(
  "短词原样保留是**正常**的（FOB? 不该被当成失败）",
  pickFastTranslation(ok("FOB?"), "FOB?") === "FOB?"
);
check("空译文 → 拒", rejected(ok("")).includes("没有返回译文"));
check("正常译文放行", pickFastTranslation(ok("您好，我们对 500 个单位感兴趣。")) === "您好，我们对 500 个单位感兴趣。");
check("HTML 实体解码", pickFastTranslation(ok("A &amp; B &#39;x&#39;")) === "A & B 'x'");

/* ---------- 真实调用路径（stub） ---------- */

const capture = [];
const result = await fastTranslate(settings, { text: "Hola", sourceLang: "es", targetLang: "zh-CN" }, {
  fetchImpl: stubFetch(ok("你好"), capture)
});
check("返回译文", result.text === "你好", result.text);
check("返回底座名", result.base === FAST_BASE_MYMEMORY, result.base);
check("带耗时", Number(result.totalMs) >= 0);
check("URL 用 langpair=es|zh-CN", capture[0].includes("langpair=es%7Czh-CN"), capture[0]);
check("URL 带 q 参数", capture[0].includes("q=Hola"), capture[0]);

const withEmail = [];
await fastTranslate({ ...settings, fastBaseEmail: "me@example.com" }, { text: "Hola", sourceLang: "es", targetLang: "zh-CN" }, {
  fetchImpl: stubFetch(ok("你好"), withEmail)
});
check("填了邮箱会带 de 参数（额度提到 10 倍）", withEmail[0].includes("de=me"), withEmail[0]);

const noEmail = [];
await fastTranslate(settings, { text: "Hola", sourceLang: "es", targetLang: "zh-CN" }, {
  fetchImpl: stubFetch(ok("你好"), noEmail)
});
check("没填邮箱就不带 de", !noEmail[0].includes("de="), noEmail[0]);

// 多片：验证按顺序拼回来、并各发一次请求
// 600 字符 > 450 预算 → 每行再切成 450 + 150，两行共 4 片
const chunks = [];
const joined = await fastTranslate(settings, { text: `${"a".repeat(600)}\n${"b".repeat(600)}`, sourceLang: "en", targetLang: "zh-CN" }, {
  fetchImpl: async (url) => {
    chunks.push(String(url));
    return jsonResponse(ok(`片段${chunks.length}`));
  }
});
check("长文本按片发多次请求", chunks.length === 4, String(chunks.length));
check(
  "按顺序拼回（片数与返回行数一致、且顺序不颠倒）",
  joined.text.split("\n").join("|") === chunks.map((_, i) => `片段${i + 1}`).join("|"),
  joined.text.split("\n").join("|")
);

/* ---------- 失败要抛，且带判据（调用方据此回退 AI） ---------- */

async function rejectedCall(settingsArg, input, fetchImpl) {
  try {
    await fastTranslate(settingsArg, input, { fetchImpl });
    return "";
  } catch (error) {
    return `${error?.code || "no-code"}:${error.message}`;
  }
}

check(
  "连不上要抛",
  (await rejectedCall(settings, { text: "hi", sourceLang: "en", targetLang: "zh-CN" }, async () => {
    throw new Error("boom");
  })).includes("连不上")
);
check(
  "上游 5xx 要抛",
  (await rejectedCall(settings, { text: "hi", sourceLang: "en", targetLang: "zh-CN" }, stubFetch({}, [], 503))).includes("503")
);
check(
  "没配地址要抛",
  (await rejectedCall({ fastBase: "off" }, { text: "hi", sourceLang: "en", targetLang: "zh-CN" }, stubFetch(ok("x")))).includes("没有配置")
);
check(
  "太长（片数超上限）要抛 —— 交给 AI，不做半截翻译",
  (await rejectedCall(settings, { text: "a".repeat(6000), sourceLang: "en", targetLang: "zh-CN" }, stubFetch(ok("x")))).includes("太长")
);

/* ---------- 超时判据 ---------- */

const timeoutError = await rejectedCall(
  { ...settings, fastBaseTimeoutMs: 60 },
  { text: "hi", sourceLang: "en", targetLang: "zh-CN" },
  (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
);
check("超时要带 FAST_BASE_TIMEOUT_CODE（调用方靠 code 判，不靠文案）", timeoutError.includes(FAST_BASE_TIMEOUT_CODE), timeoutError);

/* ---------- 设置页的「测一次」 ---------- */

const probeOk = await probeFastBase(settings, { fetchImpl: stubFetch(ok("你好，我们对 500 个单位感兴趣。")) });
check("测速：成功时 ok=true 并报耗时", probeOk.ok === true && Number(probeOk.totalMs) >= 0);
check("测速：带上译文样本，方便用户判断质量", probeOk.text.includes("500"), probeOk.text);
const probeBad = await probeFastBase(settings, { fetchImpl: async () => { throw new Error("nope"); } });
check("测速：失败时 ok=false 且报原因（而不是抛出去把设置页搞崩）", probeBad.ok === false && probeBad.error.includes("nope"), probeBad.error);

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error(`\n✗ fastbase 单测失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ fastbase 单测全通过（${passed} 项）`);
