/**
 * CRM 通道单测。
 *
 * 这一层是扩展里唯一会**主动出站**的地方（登录 CRM、读插件引擎、换一条草稿），所以这里只测两类事：
 *   1. 纯函数：地址归一、令牌过期判定、把「依据」写成一句人话；
 *   2. 请求本身：URL 拼对没有、Bearer 带没带、超限的转写截断没有、401 有没有被识别成"要重登"。
 *
 * fetch 用桩替换（`globalThis.fetch`），断言比的是**实际发出去的请求**而不是返回值——
 * 只测返回值的话，地址取错层级的 bug 会照样全绿（它回落到一个同样合法的默认地址）。
 * 跑法：node tests/crm.test.mjs
 */

import {
  MAX_TRANSCRIPT_MESSAGES,
  RESOURCE_LIMIT,
  baseUrlOf,
  composeFromCrm,
  decodeJwtExpiry,
  describeEngine,
  describeEvidence,
  importTrainingProfile,
  loginToCrm,
  readResourceStats,
  normalizeTranscript,
  readEngineStatus,
  readSessionState,
  recordResourceFeedback,
  revealResource,
  searchResources,
  suggestForConversation
} from "../src/crm.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

/** 造一枚能被解出来的 JWT（签名是假的，这一层从不验签）。 */
function jwt(expSeconds, extra = {}) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "u1", exp: expSeconds, ...extra })}.not-a-real-signature`;
}

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const minutesFromNow = (minutes) => Math.floor(NOW / 1000) + minutes * 60;

/** 换掉全局 fetch，把每次调用原样记下来。 */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const settingsWith = (crm) => ({
  crm: { crmBaseUrl: "http://127.0.0.1:4188", pluginBaseUrl: "http://127.0.0.1:3100", email: "", ...crm }
});

/* ---------- 一、地址归一 ---------- */

check("http 回环可用", baseUrlOf("http://127.0.0.1:4188/") === "http://127.0.0.1:4188");
check("尾部斜杠全部去掉", baseUrlOf("http://localhost:3100///") === "http://localhost:3100");
check("https 远端可用", baseUrlOf("https://crm.example.com") === "https://crm.example.com");
check("空值走 fallback", baseUrlOf("", "http://127.0.0.1:4188") === "http://127.0.0.1:4188");

let threw = null;
try {
  baseUrlOf("http://crm.example.com");
} catch (error) {
  threw = error.message;
}
check("明文 http 的远端地址被拒（与翻译端点同一姿态）", Boolean(threw && threw.includes("https")), String(threw));

threw = null;
try {
  baseUrlOf("");
} catch (error) {
  threw = error.message;
}
check("既空又没 fallback 要报错而不是拼出 /api/...", Boolean(threw), String(threw));

/* ---------- 二、令牌过期判定 ---------- */

check("解得出 exp", decodeJwtExpiry(jwt(minutesFromNow(30))) === minutesFromNow(30) * 1000);
check("不是 JWT 就返回 null", decodeJwtExpiry("abc") === null);
check("空值返回 null", decodeJwtExpiry("") === null);
check("payload 不是 JSON 也返回 null", decodeJwtExpiry("a.!!!!.c") === null);

const none = readSessionState(null, NOW);
check("没有令牌就是未登录", none.loggedIn === false && none.expired === false);

const fresh = readSessionState({ token: jwt(minutesFromNow(30)), email: "a@b.com" }, NOW);
check("30 分钟有效期算已登录", fresh.loggedIn === true);
check("剩余分钟数报给界面", fresh.expiresInMinutes === 30, String(fresh.expiresInMinutes));
check("邮箱一并带出来", fresh.email === "a@b.com");

// 提前 5 分钟判过期：等 401 回来才知道，用户已经点过按钮、白等一轮了。
const nearly = readSessionState({ token: jwt(minutesFromNow(3)) }, NOW);
check("只剩 3 分钟就当失效（提前量 5 分钟）", nearly.loggedIn === false);
check("但还没真的过期，不谎报 expired", nearly.expired === false, String(nearly.expired));

const dead = readSessionState({ token: jwt(minutesFromNow(-10)) }, NOW);
check("已过期时 expired 为真（界面据此说「重新登录」）", dead.expired === true && dead.loggedIn === false);

check("解不出 exp 时不当作已登录", readSessionState({ token: "garbage" }, NOW).loggedIn === false);

/* ---------- 三、依据写成人话 ---------- */

check("没有依据时如实说没有", describeEvidence(null).includes("无"));

const onlyProfile = describeEvidence({ profile: { name: "报价常用", examples: 42 } });
check("训练档案进依据", onlyProfile.includes("报价常用") && onlyProfile.includes("42 组问答"), onlyProfile);

const withLibrary = describeEvidence({ library: { qa: 3, snippets: 2, policies: 1, forbidden: 4 } });
check("训练库命中分类计数进依据", withLibrary.includes("命中 3 条") && withLibrary.includes("禁用 4"), withLibrary);

const matched = describeEvidence({
  crm: {
    matchedBy: "phone",
    customer: "Acme Trading",
    followUps: 5,
    quotes: 2,
    knowledge: [{ title: "MOQ 政策" }, { title: "交期说明" }],
    errors: []
  }
});
check("按号码匹配要说清楚匹配方式", matched.includes("按号码"), matched);
check("跟进/报价条数进依据", matched.includes("5 条") && matched.includes("2 条"), matched);
check("知识命中列出标题", matched.includes("MOQ 政策") && matched.includes("交期说明"), matched);

const unmatched = describeEvidence({ crm: { matchedBy: "none", followUps: 0, quotes: 0, knowledge: [], errors: [] } });
check("没匹配到客户要明说（而不是假装有依据）", unmatched.includes("未匹配到客户"), unmatched);

const partial = describeEvidence({
  crm: { matchedBy: "phone", customer: "Acme", followUps: 1, quotes: 0, knowledge: [], errors: ["报价：HTTP 500"] }
});
check("取不到的来源如实列出（不许吞掉）", partial.includes("未取到") && partial.includes("HTTP 500"), partial);

/* ---------- 四、引擎状态写成人话 ---------- */

check("未检测不说成故障", describeEngine(null).state === "unknown");
check("插件探测失败是 err", describeEngine({ ok: false, error: "连不上插件" }).state === "err");
check("CLI 不可用是 warn 且带原因", describeEngine({ ok: true, engine: { available: false, reason: "未找到可执行文件" } }).text.includes("未找到可执行文件"));

const skillOk = describeEngine({
  ok: true,
  engine: { available: true, version: "1.2.3", defaultModel: "m1", autoReplySkill: "goodjob-auto-reply", skills: ["goodjob-auto-reply"] }
});
check("技能在列表里才是 ok", skillOk.state === "ok", skillOk.text);
check("ok 时把版本与技能名说出来", skillOk.text.includes("1.2.3") && skillOk.text.includes("goodjob-auto-reply"));

// 技能没扫到 = 插件的**静默降档**，出稿照出、不报错；不点破用户只会以为"模型变笨了"。
const skillMissing = describeEngine({
  ok: true,
  engine: { available: true, version: "1.2.3", defaultModel: "m1", autoReplySkill: "goodjob-auto-reply", skills: [] }
});
check("技能没扫到要降档告警", skillMissing.state === "warn", skillMissing.text);
check("告警里点名缺哪个技能", skillMissing.text.includes("goodjob-auto-reply"), skillMissing.text);

/* ---------- 五、登录 ---------- */

const noCreds = await loginToCrm(settingsWith(), { email: "", password: "" });
check("缺账号密码直接返回、不发请求", noCreds.ok === false && noCreds.error.includes("都要填"), JSON.stringify(noCreds));

{
  const stub = stubFetch(() => jsonResponse(200, { token: jwt(minutesFromNow(720)), user: { id: "u-9", name: "老陈" } }));
  const result = await loginToCrm(settingsWith({ crmBaseUrl: "https://crm.example.com/" }), { email: "a@b.com", password: "pw" });
  stub.restore();
  check("登录成功", result.ok === true, JSON.stringify(result));
  check("打到配置的 CRM 地址上（不是回落到回环）", stub.calls[0].url === "https://crm.example.com/api/auth/login", stub.calls[0].url);
  check("用 POST", stub.calls[0].init.method === "POST");
  check("请求体只带 email 与 password", stub.calls[0].init.body === JSON.stringify({ email: "a@b.com", password: "pw" }), stub.calls[0].init.body);
  check("会话里带上 userId / 邮箱", result.session.userId === "u-9" && result.session.email === "a@b.com");
  check("会话里存下 token", Boolean(result.session.token));
  check("**不**把密码带进会话", !JSON.stringify(result.session).includes("pw"));
}

{
  const stub = stubFetch(() => jsonResponse(401, { message: "invalid credentials" }));
  const result = await loginToCrm(settingsWith(), { email: "a@b.com", password: "bad" });
  stub.restore();
  check("401 标成 needsLogin 而不是「网络错误」", result.needsLogin === true, JSON.stringify(result));
  check("401 提示里说清是登录问题", result.error.includes("登录"), result.error);
}

{
  const stub = stubFetch(() => jsonResponse(200, { user: { id: "u-9" } }));
  const result = await loginToCrm(settingsWith(), { email: "a@b.com", password: "pw" });
  stub.restore();
  check("响应里没有 token 时报版本不匹配（而不是存一个空会话）", result.ok === false && result.error.includes("令牌"), JSON.stringify(result));
}

{
  const stub = stubFetch(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const result = await loginToCrm(settingsWith(), { email: "a@b.com", password: "pw" });
  stub.restore();
  check("连不上时错误里带地址（用户一眼知道该去看什么）", result.error.includes("127.0.0.1:4188"), result.error);
}

/* ---------- 六、读插件引擎状态 ---------- */

{
  const stub = stubFetch(() => jsonResponse(200, { available: true, skills: ["goodjob-auto-reply"] }));
  const result = await readEngineStatus(settingsWith({ pluginBaseUrl: "https://plugin.example.com" }), { token: "t" });
  stub.restore();
  check("引擎状态读到", result.ok === true && result.engine.available === true, JSON.stringify(result));
  check("打到配置的插件地址上", stub.calls[0].url === "https://plugin.example.com/api/v1/auto-chat/engine", stub.calls[0].url);
  check("带上 Bearer", stub.calls[0].init.headers.authorization === "Bearer t");
}

/* ---------- 七、换草稿 ---------- */

const session = { token: "tkn" };

{
  const result = await composeFromCrm(settingsWith(), null, { messages: [{ body: "hi" }] });
  check("没登录就不发请求", result.needsLogin === true, JSON.stringify(result));
}

{
  const stub = stubFetch(() => jsonResponse(200, { action: "reply", reply: "ok" }));
  const result = await composeFromCrm(settingsWith(), session, { messages: [{ body: "   " }, { direction: "x", body: "" }] });
  stub.restore();
  check("空消息不发请求（省得白等一次几十秒的生成）", result.ok === false && stub.calls.length === 0, JSON.stringify(result));
}

{
  const messages = Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 5 }, (_, i) => ({
    direction: i % 2 ? "outbound" : "inbound",
    body: `m${i}`
  }));
  const stub = stubFetch(() => jsonResponse(200, { action: "reply", reply: "ok" }));
  const result = await composeFromCrm(settingsWith(), session, { messages, contact: { phone: "123", name: "Acme" } });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("超限的转写在扩展侧就截断（不指望服务端兜）", sent.messages.length === MAX_TRANSCRIPT_MESSAGES, String(sent.messages.length));
  check("截断保留的是**最近**的几条", sent.messages.at(-1).body === `m${MAX_TRANSCRIPT_MESSAGES + 4}`, sent.messages.at(-1).body);
  check("联系人一并发上去", sent.contact.phone === "123" && sent.contact.name === "Acme");
  check("打到插件的 compose 路径", stub.calls[0].url.endsWith("/api/v1/auto-chat/compose"), stub.calls[0].url);
  check("带上 Bearer", stub.calls[0].init.headers.authorization === "Bearer tkn");
  check("方向只允许 inbound / outbound 两档", sent.messages.every((m) => m.direction === "inbound" || m.direction === "outbound"));
  check("结果原样带回", result.ok === true && result.result.reply === "ok");
}

{
  const stub = stubFetch(() => jsonResponse(200, {}));
  await composeFromCrm(settingsWith(), session, {
    messages: [{ body: "x".repeat(9000) }],
    engine: "cli",
    model: "m1",
    effort: "high"
  });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("单条正文超长要截断", sent.messages[0].body.length === 4000, String(sent.messages[0].body.length));
  check("引擎/模型偏好透传", sent.engine === "cli" && sent.model === "m1" && sent.effort === "high");
}

{
  const stub = stubFetch(() => jsonResponse(200, {}));
  await composeFromCrm(settingsWith(), session, { messages: [{ body: "x" }] });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("没指定引擎时**不**塞空字段（避免服务端拿空串当真的模型名）", !("engine" in sent) && !("model" in sent), JSON.stringify(sent));
}

{
  const stub = stubFetch(() => jsonResponse(401, { message: "token expired" }));
  const result = await composeFromCrm(settingsWith(), session, { messages: [{ body: "hi" }] });
  stub.restore();
  check("生成时令牌过期 → needsLogin（界面据此把人送去重登）", result.needsLogin === true, JSON.stringify(result));
}

{
  const stub = stubFetch(() => jsonResponse(400, { message: "messages 不能为空" }));
  const result = await composeFromCrm(settingsWith(), session, { messages: [{ body: "hi" }] });
  stub.restore();
  check("服务端 400 的原因要透给用户", result.ok === false && result.error.includes("不能为空"), JSON.stringify(result));
}

/* ---------- 十、资源中心四条通道 ---------- */

const conversation = { messages: [{ direction: "inbound", body: "Can you send the LED panel specification?" }], contact: { phone: "+49 1", name: "Ann" } };

{
  const stub = stubFetch(() => jsonResponse(200, { reply: null, resources: [], warnings: [] }));
  await suggestForConversation(settingsWith(), session, conversation);
  stub.restore();
  const call = stub.calls[0];
  const sent = JSON.parse(call.init.body);
  check("suggest 打到插件的 /api/v1/auto-chat/suggest", call.url === "http://127.0.0.1:3100/api/v1/auto-chat/suggest", call.url);
  check("suggest 带上 Bearer（否则插件全段 401）", String(call.init.headers.authorization) === `Bearer ${session.token}`, String(call.init.headers.authorization));
  check("suggest 默认要 AI 复排（不下发 withAi:false）", !("withAi" in sent), JSON.stringify(sent));
  check("suggest 的 limit 与服务端默认对齐", sent.limit === RESOURCE_LIMIT, String(sent.limit));
}

{
  const stub = stubFetch(() => jsonResponse(200, {}));
  await suggestForConversation(settingsWith(), session, { ...conversation, withAi: false });
  stub.restore();
  check("显式要「快」时下发 withAi:false", JSON.parse(stub.calls[0].init.body).withAi === false);
}

{
  const noSession = await suggestForConversation(settingsWith(), null, conversation);
  check("没令牌时**一个请求都不发**，直接要人去登录", noSession.ok === false && noSession.needsLogin === true, JSON.stringify(noSession));
}

{
  const empty = await suggestForConversation(settingsWith(), session, { messages: [{ direction: "inbound", body: "  " }] });
  check("空对话不发请求（省一次几十秒的 CLI）", empty.ok === false && empty.error.includes("没有可用"), JSON.stringify(empty));
}

{
  const stub = stubFetch(() => jsonResponse(200, { resources: [] }));
  await searchResources(settingsWith(), session, { q: "led panel" });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("目录检索用 q（没有对话时）", stub.calls[0].url.endsWith("/api/v1/resources/search") && sent.q === "led panel", JSON.stringify(sent));
  check("目录检索不下发空 messages（否则服务端会当成「有对话」）", !("messages" in sent), JSON.stringify(sent));
}

{
  const stub = stubFetch(() => jsonResponse(200, { resources: [] }));
  await searchResources(settingsWith(), session, { messages: conversation.messages });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("有对话时走按对话推荐，且不带 q", Array.isArray(sent.messages) && sent.messages.length === 1 && !("q" in sent), JSON.stringify(sent));
}

{
  const neither = await searchResources(settingsWith(), session, {});
  check("既没对话也没关键词 → 直接拒（不要拿空气去搜）", neither.ok === false, JSON.stringify(neither));
}

{
  const stub = stubFetch(() => jsonResponse(200, { ok: true, access: { kind: "external", url: "https://x/y", shareCode: "c" }, accessId: "rae_1" }));
  await revealResource(settingsWith(), session, { sourceType: "file", id: "res-1", conversationKey: "wa:+491" });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("reveal 打到插件代取（扩展本身没有 CRM 密钥）", stub.calls[0].url === "http://127.0.0.1:3100/api/v1/resources/reveal", stub.calls[0].url);
  check("reveal 带上 sourceType/id/会话键", sent.sourceType === "file" && sent.id === "res-1" && sent.conversationKey === "wa:+491", JSON.stringify(sent));
  check("reveal 默认 reason=manual（审计上要能区分是用户点的还是别处触发的）", sent.reason === "manual", String(sent.reason));
}

{
  const missing = await revealResource(settingsWith(), session, { sourceType: "", id: "" });
  check("缺标识时不发请求", missing.ok === false, JSON.stringify(missing));
}

{
  const stub = stubFetch(() => jsonResponse(202, { accepted: 1 }));
  await recordResourceFeedback(settingsWith(), session, {
    items: [
      { resourceId: "res-1", sourceType: "file", action: "accepted" },
      { resourceId: "res-2", sourceType: "file", action: "什么鬼" },
      { resourceId: "", sourceType: "file", action: "accepted" }
    ],
    conversationKey: "wa:+491"
  });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("埋点：无 id 的条目被剔掉", sent.items.length === 2, JSON.stringify(sent.items));
  check("埋点：认不出的 action 一律回落 accepted（不把脏值透给服务端）", sent.items[1].action === "accepted", JSON.stringify(sent.items[1]));
}

{
  const empty = await recordResourceFeedback(settingsWith(), session, { items: [] });
  check("没有条目时不发请求（埋点是旁路，不为它多打一次）", empty.ok === false, JSON.stringify(empty));
}

/* ---------- 十一、转写归一与引擎描述 ---------- */

check(
  "normalizeTranscript 截到最近 20 条（留最新、丢最旧）",
  (() => {
    const many = Array.from({ length: 30 }, (_, index) => ({ direction: "inbound", body: `m${index}` }));
    const out = normalizeTranscript(many);
    return out.length === MAX_TRANSCRIPT_MESSAGES && out.at(-1).body === "m29" && out[0].body === "m10";
  })()
);

check(
  "normalizeTranscript 剔空正文、方向非法一律当 inbound",
  (() => {
    const out = normalizeTranscript([
      { direction: "inbound", body: "真消息" },
      { direction: "outbound", body: "   " },
      { direction: 3, body: "x" }
    ]);
    return out.length === 2 && out[1].direction === "inbound" && out[1].body === "x";
  })()
);

check(
  "两个技能分开报：只装一个时必须点名缺的那个（降档是静默的）",
  (() => {
    const onlyReply = describeEngine({
      ok: true,
      engine: { available: true, version: "1", defaultModel: "m", skills: ["goodjob-auto-reply"], autoReplySkill: "goodjob-auto-reply", resourceScoutSkill: "goodjob-resource-scout" }
    });
    const both = describeEngine({
      ok: true,
      engine: { available: true, version: "1", defaultModel: "m", skills: ["goodjob-auto-reply", "goodjob-resource-scout"], autoReplySkill: "goodjob-auto-reply", resourceScoutSkill: "goodjob-resource-scout" }
    });
    return onlyReply.state === "warn" && onlyReply.text.includes("goodjob-resource-scout") && both.state === "ok" && both.text.includes("goodjob-resource-scout");
  })()
);

/* ---------- 十一、推送训练档案（归档并学习 → CRM） ---------- */

const trainingProfile = {
  name: "Web 会话档案",
  tone: "专业",
  summary: "基于 2 个会话提炼。",
  guidelines: ["回复保持英文"],
  signaturePhrases: ["Happy to help"],
  guardrails: ["不承诺交期"],
  languages: ["en"],
  examples: [
    { inbound: "What is your MOQ?", reply: "Our MOQ is 500 pieces.", score: 0.9, occurredAt: "2026-10-12T10:00:00Z", conversationId: "conv-1" }
  ],
  stats: { conversations: 2, messages: 12, exchanges: 4, samples: 1 },
  source: { from: "2026-10-01", to: "2026-10-12" }
};

{
  const result = await importTrainingProfile(settingsWith(), null, trainingProfile);
  check("推送档案：没登录就不发请求", result.needsLogin === true, JSON.stringify(result));
}

{
  const stub = stubFetch(() => jsonResponse(201, { profile: {}, library: { created: 1, skipped: 0 } }));
  await importTrainingProfile(settingsWith(), session, { ...trainingProfile, examples: [] });
  stub.restore();
  check("没有问答样本就不发请求（服务端也没东西可落）", stub.calls.length === 0);
}

{
  const stub = stubFetch(() => jsonResponse(201, { profile: { id: "trn_x" }, library: { created: 2, skipped: 0 } }));
  const result = await importTrainingProfile(settingsWith(), session, trainingProfile);
  stub.restore();
  const call = stub.calls[0];
  const sent = JSON.parse(call.init.body);
  check("打到插件的训练档案导入路径", call.url.endsWith("/api/v1/training/profiles/import"), call.url);
  check("带上 Bearer", call.init.headers.authorization === "Bearer tkn");
  check("档案名与风格字段带上去", sent.name === "Web 会话档案" && sent.tone === "专业" && sent.summary === "基于 2 个会话提炼。");
  check("问答样本原样带上去（含时间与分数）", sent.examples[0].inbound === "What is your MOQ?" && sent.examples[0].score === 0.9 && sent.examples[0].occurredAt === "2026-10-12T10:00:00Z");
  check("护栏与语言一并提供", sent.guardrails[0] === "不承诺交期" && sent.languages[0] === "en");
  check("统计与时间范围透传", sent.stats.conversations === 2 && sent.source.to === "2026-10-12");
  check("结果带回（created/skipped 给界面写 note）", result.ok === true && result.result.library.created === 2);
}

{
  const examples = Array.from({ length: 260 }, (_, index) => ({ inbound: `q${index} x`.repeat(600), reply: `r${index}` }));
  const stub = stubFetch(() => jsonResponse(201, { profile: {}, library: { created: 200, skipped: 0 } }));
  await importTrainingProfile(settingsWith(), session, { ...trainingProfile, examples, signaturePhrases: ["a".repeat(300)], guidelines: ["g".repeat(500)] });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("样本数在扩展侧就截断到服务端上限", sent.examples.length === 200, String(sent.examples.length));
  check("单条样本截断到 2000 字符", sent.examples[0].inbound.length === 2000, String(sent.examples[0].inbound.length));
  check("护栏/金句截断到各自的长度上限", sent.guidelines[0].length === 300 && sent.signaturePhrases[0].length === 120);
}

{
  const stub = stubFetch(() => jsonResponse(200, {}));
  await importTrainingProfile(settingsWith(), session, { ...trainingProfile, tone: "", summary: "", guidelines: [], stats: undefined, source: undefined });
  stub.restore();
  const sent = JSON.parse(stub.calls[0].init.body);
  check("空的可选字段不塞进请求体（别拿空串当真值）", !("tone" in sent) && !("summary" in sent) && !("guidelines" in sent) && !("stats" in sent) && !("source" in sent), JSON.stringify(sent));
}

{
  const stub = stubFetch(() => jsonResponse(401, { message: "token expired" }));
  const result = await importTrainingProfile(settingsWith(), session, trainingProfile);
  stub.restore();
  check("推送时令牌过期 → needsLogin", result.needsLogin === true, JSON.stringify(result));
}

/* ---------- 十二、推荐效果报表（只读） ---------- */

{
  const result = await readResourceStats(settingsWith(), null, {});
  check("读报表：没登录就不发请求", result.needsLogin === true, JSON.stringify(result));
}

{
  const stub = stubFetch(() => jsonResponse(200, { days: 30, totals: { exposed: 3, revealed: 2, accepted: 1, dismissed: 0, sent: 1, adoptionRate: 0.5, sendRate: 0.5 }, items: [], warnings: [] }));
  await readResourceStats(settingsWith(), session, { days: 30 });
  stub.restore();
  const call = stub.calls[0];
  check("报表是 GET 且带 days 参数", call.init.method === "GET" && call.url.includes("/api/v1/resources/stats?days=30"), `${call.init.method} ${call.url}`);
  check("带上 Bearer", call.init.headers.authorization === "Bearer tkn");
}

{
  const cases = [[0, 1], [-5, 1], [999, 90], ["abc", 30], [undefined, 30]];
  const results = [];
  const stub = stubFetch(() => jsonResponse(200, { days: 30, totals: {}, items: [], warnings: [] }));
  for (const [input] of cases) await readResourceStats(settingsWith(), session, { days: input });
  stub.restore();
  for (const [index, call] of stub.calls.entries()) {
    results.push(Number(new URL(call.url).searchParams.get("days")));
  }
  check("days 在扩展侧就夹进 [1,90]（0/-5→1，999→90，非法→30）", JSON.stringify(results) === JSON.stringify([1, 1, 90, 30, 30]), JSON.stringify(results));
}

{
  const stub = stubFetch(() => jsonResponse(502, { message: "上游不可用" }));
  const result = await readResourceStats(settingsWith(), session, {});
  stub.restore();
  check("插件透传的失败原因要能显示出来", result.ok === false && result.error.includes("上游不可用"), JSON.stringify(result));
}

/* ---------- 输出 ---------- */

console.log(`\nCRM 通道单测：通过 ${passed} 项`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
