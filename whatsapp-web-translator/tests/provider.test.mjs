/**
 * 翻译引擎单测：不碰浏览器、不连网络（fetch 全部注入桩）。
 * 跑法：node tests/provider.test.mjs
 */

import {
  buildUserPrompt,
  describeError,
  firstTokenMessage,
  listModels,
  pickContent,
  pickDelta,
  TRANSLATOR_SYSTEM_PROMPT,
  translateText
} from "../src/provider.js";
import { cacheKey, CACHE_LIMIT, isChineseText, isTranslatable, normalizeEndpoint, touchCache } from "../src/settings.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

function stubFetch(response, capture) {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
      capture.body = JSON.parse(init.body);
    }
    return response;
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

/* ---------- 纯函数 ---------- */

check("系统提示词点名 B2B 翻译角色", TRANSLATOR_SYSTEM_PROMPT.includes("professional B2B trade translator"));
check(
  "系统提示词明令禁止「先想想再答」（推理型模型超时的头号原因）",
  TRANSLATOR_SYSTEM_PROMPT.includes("Do not think step by step") &&
    TRANSLATOR_SYSTEM_PROMPT.includes("Translate directly")
);
check(
  "系统提示词要求只输出译文（否则模型的前言会显示在客户消息下面）",
  TRANSLATOR_SYSTEM_PROMPT.includes("no preamble") && TRANSLATOR_SYSTEM_PROMPT.includes("no original text")
);
check(
  "系统提示词要求保住数字与换行（外贸场景错一个字就是事故）",
  TRANSLATOR_SYSTEM_PROMPT.includes("numbers") && TRANSLATOR_SYSTEM_PROMPT.includes("line breaks")
);
check(
  "prompt 带上源语言与目标语言",
  buildUserPrompt("Hola", "es", "zh-CN") === "Translate from es to zh-CN:\n\nHola",
  buildUserPrompt("Hola", "es", "zh-CN")
);
check("prompt 允许省略源语言", buildUserPrompt("Hola", undefined, "zh-CN") === "Translate to zh-CN:\n\nHola");

check("取正文：字符串", pickContent({ choices: [{ message: { content: "  译文  " } }] }) === "译文");
check("取正文：分片数组", pickContent({ choices: [{ message: { content: [{ text: "甲" }, "乙"] } }] }) === "甲乙");
check("取正文：空响应返回空串", pickContent({}) === "");

check("错误映射 401 提示密钥", describeError(401, "").includes("密钥无效"));
check("错误映射 404 提示地址或模型", describeError(404, "").includes("模型名"));
check("错误映射 429 提示限流", describeError(429, "").includes("限流"));

check("端点归一化：带 /v1", normalizeEndpoint("https://api.example.com/v1") === "https://api.example.com/v1/chat/completions");
check("端点归一化：裸域名", normalizeEndpoint("https://api.example.com") === "https://api.example.com/v1/chat/completions");
check("端点归一化：已完整路径不动", normalizeEndpoint("https://api.example.com/v1/chat/completions") === "https://api.example.com/v1/chat/completions");

check("中文判定：中文为主 → true", isChineseText("你好，请确认交期") === true);
check("中文判定：英文夹中文 → false", isChineseText("Hello 你好 the lead time?") === false);
check("可译判定：纯数字跳过", isTranslatable("500") === false);
check("可译判定：纯链接跳过", isTranslatable("https://example.com/a.pdf") === false);
check("可译判定：纯表情跳过", isTranslatable("👍🎉") === false);
check("可译判定：正常句子通过", isTranslatable("Hola, nos interesan 500 unidades.") === true);

check(
  "缓存键对空白归一",
  cacheKey("Hola   nos\ninteresan", "zh-CN") === cacheKey("Hola nos interesan", "zh-CN")
);
/**
 * ⚠️ 这条断言**方向反过来了**（旧版要求「区分模型」）。
 *
 * 两段式翻译下同一条缓存会先被写成机译、再被 AI 精修覆盖。键里带模型名的话，
 * 「机译结果」和「精修结果」会落在两个不同的键上，永远互相顶不掉；
 * 而且换模型是调优动作，不该让整份缓存作废（作废一次要为所有历史消息重新付费翻译）。
 * 所以：**键只认文本 + 目标语言**，「谁翻的」作为附加信息另外记。
 */
check(
  "缓存键不再区分模型（换模型不该作废整份缓存）",
  cacheKey("hi", "zh-CN", "a") === cacheKey("hi", "zh-CN", "b")
);
check("缓存键必须区分目标语言", cacheKey("hi", "zh-CN") !== cacheKey("hi", "en"));
check(
  "缓存键与模型名无关（模型名不同也命中同一条）",
  cacheKey("hi", "zh-CN", "gpt-5.6-sol") === cacheKey("hi", "zh-CN", "whatever-else")
);

const lru = Array.from({ length: 4 }, (_, index) => [`k${index}`, index]);
check("LRU 命中把条目挪到末尾", touchCache(lru, "k1", 9).at(-1)[0] === "k1");
check("未超上限时不淘汰", touchCache(lru, "k9", 9).length === 5);
const full = Array.from({ length: CACHE_LIMIT }, (_, index) => [`k${index}`, index]);
const pruned = touchCache(full, "newest", 1);
check("超上限时淘汰最旧条目", pruned.length === CACHE_LIMIT && pruned[0][0] === "k1", `${pruned.length}/${pruned[0][0]}`);
check("淘汰后最新条目在末尾", pruned.at(-1)[0] === "newest");

/* ---------- 网络调用 ---------- */

const capture = {};
const okCase = await translateText(
  { apiBase: "https://api.example.com/v1", apiKey: "sk-test", model: "m1" },
  { text: "Hola", sourceLang: "es", targetLang: "zh-CN" },
  { fetchImpl: stubFetch(jsonResponse({ choices: [{ message: { content: " 你好 " } }], usage: { total_tokens: 7 } }), capture) }
);
check("请求打到归一化后的端点", capture.url === "https://api.example.com/v1/chat/completions", capture.url);
check("带上 Bearer 鉴权", capture.init.headers.authorization === "Bearer sk-test");
check("请求体带模型名", capture.body.model === "m1");
check("temperature=0", capture.body.temperature === 0);
check(
  "默认开流式（只为拿到「第一个字什么时候到」这个信号，见 settings.js::firstTokenMs）",
  capture.body.stream === true
);
check(
  "默认不传 reasoning_effort / max_tokens（不认这两个参数的上游会 400）",
  !("reasoning_effort" in capture.body) && !("max_tokens" in capture.body)
);
check("请求体含系统提示词", capture.body.messages[0].content.includes("B2B trade translator"));
check("请求体含用户原文", capture.body.messages[1].content.includes("Hola"));
check("返回译文已 trim", okCase.text === "你好", okCase.text);
check("回传 token 用量", okCase.tokenUsage === 7);
check(
  "回传耗时与是否真走了流式（自检要报秒数，用户靠它判断模型行不行）",
  typeof okCase.totalMs === "number" && okCase.streamed === false,
  `totalMs=${okCase.totalMs} streamed=${okCase.streamed}`
);

check("取增量：字符串", pickDelta({ choices: [{ delta: { content: "甲" } }] }) === "甲");
check("取增量：分片数组", pickDelta({ choices: [{ delta: { content: [{ text: "甲" }, "乙"] } }] }) === "甲乙");
check("取增量：非文本帧（role 帧）给空串", pickDelta({ choices: [{ delta: { role: "assistant" } }] }) === "");
check(
  "首字超时文案要点名模型、并指出出路（去设置页拉清单换一个）",
  firstTokenMessage(20000, "gpt-5.5").includes("gpt-5.5") &&
    firstTokenMessage(20000, "gpt-5.5").includes("拉取模型清单"),
  firstTokenMessage(20000, "gpt-5.5")
);
check(
  "首字超时文案按实际阈值报秒数（阈值改了文案不能还写 8 秒）",
  firstTokenMessage(20000, "m").includes("20 秒") && firstTokenMessage(5000, "m").includes("5 秒"),
  firstTokenMessage(20000, "m")
);

let httpRejected = "";
try {
  await translateText(
    { apiBase: "http://api.example.com/v1", apiKey: "k", model: "m" },
    { text: "hi", targetLang: "zh-CN" },
    { fetchImpl: stubFetch(jsonResponse({})) }
  );
} catch (error) {
  httpRejected = error.message;
}
check("远程明文 http 被拒", httpRejected.includes("https"), httpRejected);

let noKey = "";
try {
  await translateText({ apiBase: "https://a.com", apiKey: "", model: "m" }, { text: "hi", targetLang: "zh" }, {});
} catch (error) {
  noKey = error.message;
}
check("缺 Key 给出可操作提示", noKey.includes("API Key"), noKey);

/* ---------- 「对比测速」的一串名字绝不能当模型名发出去 ---------- */

// 这正是真实踩过的坑：模型框里逗号连着的多个名字被整个塞进请求的 model 字段发给上游。
// 正确行为 = 在本地拦住、一次网络都不发。
let joinedModelError = "";
let joinedModelFetches = 0;
try {
  await translateText(
    { apiBase: "https://a.com/v1", apiKey: "k", model: "gpt-a,gpt-b,gpt-c" },
    { text: "hi", targetLang: "zh-CN" },
    { fetchImpl: async () => { joinedModelFetches += 1; return jsonResponse({}); } }
  );
} catch (error) {
  joinedModelError = error.message;
}
check("逗号连着的多个模型名在本地被拦下", joinedModelError.includes("对比测速"), joinedModelError);
check("被拦下时一次网络都没发（不是发给上游等 404）", joinedModelFetches === 0, `实际发了 ${joinedModelFetches} 次`);
let fullWidthJoined = "";
try {
  await translateText(
    { apiBase: "https://a.com/v1", apiKey: "k", model: "gpt-a，gpt-b" },
    { text: "hi", targetLang: "zh-CN" },
    { fetchImpl: async () => jsonResponse({}) }
  );
} catch (error) {
  fullWidthJoined = error.message;
}
check("全角逗号连着的同样拦下", fullWidthJoined.includes("对比测速"), fullWidthJoined);

let unauthorized = "";
try {
  await translateText(
    { apiBase: "https://a.com/v1", apiKey: "bad", model: "m" },
    { text: "hi", targetLang: "zh-CN" },
    { fetchImpl: stubFetch(jsonResponse({ error: "invalid api key" }, 401)) }
  );
} catch (error) {
  unauthorized = error.message;
}
check("401 抛出密钥类错误", unauthorized.includes("密钥无效"), unauthorized);

let timeout = "";
try {
  const timeoutError = new Error("timed out");
  timeoutError.name = "TimeoutError";
  await translateText(
    { apiBase: "https://a.com/v1", apiKey: "k", model: "m" },
    { text: "hi", targetLang: "zh-CN" },
    { fetchImpl: async () => { throw timeoutError; } }
  );
} catch (error) {
  timeout = error.message;
}
check("超时给出可读提示", timeout.includes("超时"), timeout);

/* ---------- 流式与「快速失败」 ---------- */

/** 造一个 SSE 响应桩：按行喂 data: 帧，模拟真实流式响应 */
function sseResponse(lines, status = 200) {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(line));
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => "",
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          }
        };
      }
    }
  };
}

/** 一个「永远不吐字」的流：只有 abort 能结束它 —— 模拟模型陷在长时间推理里 */
function hangingStreamResponse(init) {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    body: {
      getReader() {
        return {
          read() {
            return new Promise((_, reject) => {
              init.signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            });
          }
        };
      }
    }
  };
}

const streamed = await translateText(
  { apiBase: "https://api.example.com/v1", apiKey: "sk-test", model: "m1" },
  { text: "Hola", sourceLang: "es", targetLang: "zh-CN" },
  {
    fetchImpl: async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":9}}\n\n',
        "data: [DONE]\n\n"
      ])
  }
);
check("流式：把分片拼成完整译文", streamed.text === "你好", streamed.text);
check("流式：标出确实走了流式", streamed.streamed === true);
check("流式：从末帧读回 token 用量", streamed.tokenUsage === 9, String(streamed.tokenUsage));

// 有些上游无视 stream:true 直接回一整段 JSON —— 不能因此变成「没有返回译文内容」
const ignoredStream = await translateText(
  { apiBase: "https://api.example.com/v1", apiKey: "sk-test", model: "m1" },
  { text: "Hola", targetLang: "zh-CN" },
  { fetchImpl: async () => sseResponse(['{"choices":[{"message":{"content":"你好"}}]}\n']) }
);
check("流式：上游无视 stream 回了整段 JSON 也能取到译文", ignoredStream.text === "你好", ignoredStream.text);

let firstToken = "";
try {
  await translateText(
    { apiBase: "https://api.example.com/v1", apiKey: "sk-test", model: "reasoning-model", firstTokenMs: 60 },
    { text: "Hola", targetLang: "zh-CN" },
    { fetchImpl: async (url, init) => hangingStreamResponse(init) }
  );
} catch (error) {
  firstToken = error.message;
}
check("首字超时：不吐字就判死，而不是白等整体超时", firstToken.includes("reasoning-model"), firstToken);
check("首字超时：文案告诉用户「去设置页拉清单换一个」这条出路", firstToken.includes("拉取模型清单"), firstToken);

/* ---------- 参数被上游拒绝时自动降级 ---------- */

const attempts = [];
const leanResult = await translateText(
  { apiBase: "https://api.example.com/v1", apiKey: "sk-test", model: "m1", reasoningEffort: "minimal" },
  { text: "Hola", targetLang: "zh-CN" },
  {
    fetchImpl: async (url, init) => {
      attempts.push(JSON.parse(init.body));
      if (attempts.length === 1) return jsonResponse({ error: { message: "Unknown parameter: reasoning_effort" } }, 400);
      return jsonResponse({ choices: [{ message: { content: "你好" } }] });
    }
  }
);
check("第一次带 reasoning_effort", attempts[0]?.reasoning_effort === "minimal", String(attempts[0]?.reasoning_effort));
check("被 400 拒后自动重试一次", attempts.length === 2, String(attempts.length));
check("重试时去掉 reasoning_effort", !("reasoning_effort" in (attempts[1] || {})), JSON.stringify(attempts[1]));
check(
  "重试时也关掉流式（不认参数的上游往往也不认 stream）",
  !("stream" in (attempts[1] || {})),
  JSON.stringify(attempts[1])
);
check("降级后拿到译文而不是报错", leanResult.text === "你好", leanResult.text);
check("降级重试过就标出来（自检里看得出来）", leanResult.lean === true);

/* ---------- 模型清单 ----------
 *
 * 这一组补的是「看不见真实线路」那个盲区的一半责任：模型名一直是**手输**的，
 * 而手输一个这条线路上不存在的名字 = 每次请求秒回 404（真实事故：填了 gpt-4o-mini，
 * 该线路压根没有，625 项单测全绿但用户一条译文都拿不到）。
 * 这里锁死 listModels 的行为，设置页才有可能把「手输」变成「点选」。
 */

function stubJson(payload, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(payload, status);
  };
  impl.calls = calls;
  return impl;
}

const listStub = stubJson({
  data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }, { id: "" }, { id: 42 }, null]
});
const listed = await listModels({ apiBase: "https://api.example.com/v1", apiKey: "k" }, { fetchImpl: listStub });
check("拉清单：去重 + 排序", JSON.stringify(listed.models) === JSON.stringify(["a-model", "b-model"]), JSON.stringify(listed.models));
check("拉清单：丢掉空串 / 非字符串 / 空项", listed.models.length === 2, JSON.stringify(listed.models));
check("拉清单：由 /v1 推出 /models", listStub.calls[0].url === "https://api.example.com/v1/models", listStub.calls[0].url);
check("拉清单：带 Bearer", listStub.calls[0].init.headers.authorization === "Bearer k", JSON.stringify(listStub.calls[0].init.headers));
check("拉清单：只读请求（不带 body）", listStub.calls[0].init.body === undefined, String(listStub.calls[0].init.body));

const chatPathStub = stubJson({ data: [{ id: "x" }] });
await listModels({ apiBase: "https://api.example.com/v1/chat/completions", apiKey: "k" }, { fetchImpl: chatPathStub });
check(
  "拉清单：模型框里填的是完整 chat/completions 地址时，也能推出 /models",
  chatPathStub.calls[0].url === "https://api.example.com/v1/models",
  chatPathStub.calls[0].url
);

let listNoKey = "";
try {
  await listModels({ apiBase: "https://api.example.com/v1", apiKey: "" }, { fetchImpl: stubJson({}) });
} catch (error) {
  listNoKey = error.message;
}
check("拉清单：没 Key 直接说清", listNoKey.includes("API Key"), listNoKey);

let list403 = "";
try {
  await listModels({ apiBase: "https://api.example.com/v1", apiKey: "k" }, { fetchImpl: stubJson({ error: "x" }, 403) });
} catch (error) {
  list403 = error.message;
}
check("拉清单：403 报「无权限」而不是崩（设置页要能区分「Key 坏了」和「这条路走不通」）", list403.includes("403"), list403);

let list404 = "";
try {
  await listModels({ apiBase: "https://api.example.com/v1", apiKey: "k" }, { fetchImpl: stubJson({ error: "x" }, 404) });
} catch (error) {
  list404 = error.message;
}
check("拉清单：404 把状态码带出来（不开放 /models 的站靠它识别）", list404.includes("404"), list404);

let listEmpty = "";
try {
  await listModels({ apiBase: "https://api.example.com/v1", apiKey: "k" }, { fetchImpl: stubJson({ object: "list" }) });
} catch (error) {
  listEmpty = error.message;
}
check("拉清单：返回里没有 data 时给明确原因，不当成「零个模型」", /没有返回|没返回/u.test(listEmpty), listEmpty);

let listHttp = "";
try {
  await listModels({ apiBase: "http://api.example.com/v1", apiKey: "k" }, { fetchImpl: stubJson({}) });
} catch (error) {
  listHttp = error.message;
}
check("拉清单：远程明文 http 同样被拒（与翻译共用同一套地址校验）", listHttp.includes("https"), listHttp);

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error(`\n✗ provider 单测失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ provider 单测全通过（${passed} 项）`);
