/**
 * 训练层单测：特征切分、问答对抽取、风格分析、语料合并、档案构建、检索与护栏。
 * 纯函数，不碰浏览器、不连网络。跑法：node tests/trainer.test.mjs
 */

import {
  MAX_EXAMPLES,
  analyzeStyle,
  applyGuardrails,
  bestExample,
  buildExchanges,
  buildProfile,
  buildProfileFromCorpus,
  containsPhrase,
  coverage,
  emptyCorpus,
  escalateMatch,
  exportTrainingKit,
  extractCorpus,
  fingerprint,
  isTrainable,
  mergeCorpus,
  profileFileName,
  resolveReply,
  sharedTokens,
  tokenize
} from "../src/trainer.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

function msg(direction, body, at = null, messageType = "text") {
  return { direction, body, occurredAt: at, messageType };
}

/* ---------- 特征切分 ---------- */

check("拉丁词长度不足 3 不算特征", tokenize("to be or").length === 0, JSON.stringify(tokenize("to be or")));
check("刚好 3 个字母算特征", tokenize("to be or not").includes("not"));
check("拉丁长词算特征", tokenize("delivery").includes("delivery"));
check(
  "中文按相邻两字切",
  JSON.stringify(tokenize("交期确认")) === JSON.stringify(["交期", "期确", "确认"]),
  JSON.stringify(tokenize("交期确认"))
);
check("中文单字自成特征", tokenize("价").includes("价"));
check("大小写不敏感", tokenize("Delivery").includes("delivery"));
check("混合文本两侧都切", tokenize("交期 delivery 45").includes("delivery") && tokenize("交期 delivery 45").includes("交期"));
check("标点被当分隔符", tokenize("a,b;c").length === 0);

check("共同特征计数", sharedTokens(["a", "b", "c"], ["b", "c", "d"]) === 2);
check("空集合得 0", sharedTokens([], ["a"]) === 0);
check("覆盖率用较短一侧", coverage(2, 2, 10) === 1, String(coverage(2, 2, 10)));
check("覆盖率不超过 1", coverage(5, 3, 10) === 1);
check("零长度得 0", coverage(0, 0, 5) === 0);

check("短语包含忽略大小写", containsPhrase("Best Regards", "best regards") === true);
check("短语包含折叠空白", containsPhrase("best   regards", "best regards") === true);
check("短语包含不忽略词内空格差异", containsPhrase("freeshipping", "e shi") === false);
check("空短语不命中", containsPhrase("anything", "") === false);

/* ---------- 可训练判定 ---------- */

check("系统消息不可训练", isTrainable(msg("inbound", "x", null, "system")) === false);
check("空正文不可训练", isTrainable(msg("inbound", "  ")) === false);
check("媒体占位符不可训练", isTrainable(msg("inbound", "[图片]")) === false);
check("带说明的媒体可训练", isTrainable(msg("inbound", "[图片] 见附件")) === true);
check("普通文本可训练", isTrainable(msg("inbound", "请问交期")) === true);

/* ---------- 问答对抽取 ---------- */

const pairing = [
  msg("inbound", "请问 SQC-300 的交期是多久？", "2026-10-01T10:00:00.000Z"),
  msg("inbound", "另外 MOQ 是多少？", "2026-10-01T10:01:00.000Z"),
  msg("outbound", "交期 45 天。", "2026-10-01T10:05:00.000Z"),
  msg("outbound", "MOQ 是 10 台。", "2026-10-01T10:06:00.000Z"),
  msg("inbound", "价格呢？", "2026-10-01T10:10:00.000Z"),
  msg("outbound", "稍后报价。", "2026-10-01T10:12:00.000Z")
];
const exchanges = buildExchanges(pairing);
check("连续入站合并成一次提问", exchanges.length === 2, String(exchanges.length));
check("两问合成一条 inbound", exchanges[0].inbound.includes("交期") && exchanges[0].inbound.includes("MOQ"), exchanges[0].inbound);
check("两答合成一条 reply", exchanges[0].reply.includes("45 天") && exchanges[0].reply.includes("10 台"), exchanges[0].reply);
check("用最早一条入站的时间戳", exchanges[0].occurredAt === "2026-10-01T10:00:00.000Z");
check("第二组是价格问答", exchanges[1].inbound.includes("价格"));

const orphan = buildExchanges([msg("outbound", "在的，请问需要什么？"), msg("inbound", "询价"), msg("outbound", "好的")]);
check("先发消息不会凭空成组", orphan.length === 1, String(orphan.length));
check("先发的消息不混进问答", orphan[0].reply === "好的", orphan[0].reply);

const scored = buildExchanges([msg("inbound", "请问交期？"), msg("outbound", "45 天")]);
check("过短回复被降权", scored[0].score < 0, String(scored[0].score));
const scoredLong = buildExchanges([
  msg("inbound", "请问交期和价格？"),
  msg("outbound", "交期 45 天，FOB 上海 USD 285/台。请问需要多少台？")
]);
check("信息完整的回复得正分", scoredLong[0].score > 0, String(scoredLong[0].score));
const scoredUrl = buildExchanges([msg("inbound", "请问交期？"), msg("outbound", "请见 https://example.com/a.pdf 的第 3 页说明")]);
check("含链接的回复扣分", scoredUrl[0].score < scoredLong[0].score);

/* ---------- 风格分析 ---------- */

const style = analyzeStyle(
  ["Hello, thanks for your inquiry. Could you confirm the quantity?", "Best regards, Anna"],
  ["Hi, we need 500 pcs"]
);
check("量出平均长度", style.averageLength > 0, String(style.averageLength));
check("判定语言", style.languages.includes("en"), JSON.stringify(style.languages));
check("给出语气描述", typeof style.tone === "string" && style.tone.length > 0, style.tone);
check("给出写作准则", style.guidelines.length >= 4, String(style.guidelines.length));
check("识别出问候与收尾习惯", style.guidelines.some((line) => line.includes("问候")) && style.guidelines.some((line) => line.includes("收尾")), JSON.stringify(style.guidelines));

const shortStyle = analyzeStyle(["好的", "收到", "没问题"], ["嗯"]);
check("短回复判定为简短直接", shortStyle.tone.includes("简短"), shortStyle.tone);
const longStyle = analyzeStyle([`${"这是一段很长的商务书面说明。".repeat(20)}`], ["问"]);
check("长回复判定为书面", longStyle.tone.includes("书面"), longStyle.tone);
check("空输入不崩", analyzeStyle([], []).averageLength === 0);

/* ---------- 语料抽取与合并 ---------- */

const bundle = {
  conversations: [
    {
      conversation: { id: "wa:a", contactName: "Ana", messageCount: 3, firstMessageAt: "2026-10-01T10:00:00.000Z", lastMessageAt: "2026-10-02T10:00:00.000Z" },
      messages: [msg("inbound", "请问交期？"), msg("outbound", "45 天，FOB 上海。"), msg("inbound", "[图片]")]
    }
  ]
};
const corpus = extractCorpus(bundle);
check("抽出 1 组问答", corpus.exchanges.length === 1, String(corpus.exchanges.length));
check("统计消息数（不含占位）", corpus.messages === 2, String(corpus.messages));
check("记录会话数", corpus.conversations === 1);
check("记录时间范围", corpus.from === "2026-10-01T10:00:00.000Z" && corpus.to === "2026-10-02T10:00:00.000Z");
check("抽出我方语料用于风格", corpus.outbound.length === 1);
check("单会话归档也能吃", extractCorpus({ conversation: bundle.conversations[0].conversation, messages: bundle.conversations[0].messages }).exchanges.length === 1);

const mergedCorpus = mergeCorpus(corpus, extractCorpus(bundle));
check("重复归档同一会话去重", mergedCorpus.exchanges.length === 1, String(mergedCorpus.exchanges.length));
check("会话数仍然累加（观测数据，不去重）", mergedCorpus.conversations === 2, String(mergedCorpus.conversations));

const many = Array.from({ length: 12 }, (_, index) => ({
  conversationId: "wa:x",
  contactName: "X",
  occurredAt: null,
  inbound: `问题${index}`,
  reply: "答案",
  score: index
}));
const capped = mergeCorpus(emptyCorpus(), { exchanges: many, inbound: [], outbound: [], conversations: 0, messages: 0 }, 5);
check("超上限时裁剪", capped.exchanges.length === 5, String(capped.exchanges.length));
check("裁剪时保留高分样本", capped.exchanges.every((item) => item.score >= 7), JSON.stringify(capped.exchanges.map((item) => item.score)));
check("空语料有稳定形状", emptyCorpus().exchanges.length === 0 && emptyCorpus().conversations === 0);

/* ---------- 档案构建 ---------- */

const profile = buildProfileFromCorpus(corpus, { name: "测试档案", now: new Date("2026-10-11T00:00:00.000Z") });
check("档案就绪", profile.status === "ready", profile.status);
check("档案带名字", profile.name === "测试档案");
check("档案 id 有前缀", profile.id.startsWith("gjp_"), profile.id);
check("档案含样例", profile.examples.length === 1);
check("样例含问与答", profile.examples[0].inbound === "请问交期？" && profile.examples[0].reply === "45 天，FOB 上海。");
check("档案自带出厂护栏", profile.guardrails.length >= 4, String(profile.guardrails.length));
check("摘要含会话与消息数", profile.summary.includes("1 个会话") && profile.summary.includes("2 条消息"), profile.summary);
check("统计字段齐全", profile.stats.conversations === 1 && profile.stats.samples === 1);
check("引擎标记为 rules", profile.engine === "rules");

const emptyProfile = buildProfileFromCorpus(emptyCorpus());
check("没有语料时档案为空", emptyProfile.status === "empty" && emptyProfile.examples.length === 0);
check("空档案给出可操作提示", emptyProfile.summary.includes("建议先归档"), emptyProfile.summary);

const bigCorpus = {
  ...emptyCorpus(),
  exchanges: Array.from({ length: MAX_EXAMPLES + 20 }, (_, index) => ({
    conversationId: "wa:x",
    occurredAt: null,
    inbound: `问 ${index}`,
    reply: `答 ${index}`,
    score: index
  })),
  outbound: ["答 1"],
  conversations: 1,
  messages: 99
};
check("样例数量封顶", buildProfileFromCorpus(bigCorpus).examples.length === MAX_EXAMPLES, String(buildProfileFromCorpus(bigCorpus).examples.length));
check("封顶时保留最高分", buildProfileFromCorpus(bigCorpus).examples[0].inbound === `问 ${MAX_EXAMPLES + 19}`);

check("buildProfile 一步到位", buildProfile({ bundles: bundle }).examples.length === 1);

/* ---------- 检索与护栏 ---------- */

const searchProfile = buildProfileFromCorpus(
  {
    ...emptyCorpus(),
    outbound: ["交期 45 天，FOB 上海 USD 285/台。", "MOQ 是 10 台。"],
    inbound: ["请问交期？", "MOQ 是多少？"],
    conversations: 1,
    messages: 4,
    exchanges: [
      { conversationId: "wa:a", occurredAt: null, inbound: "请问 SQC-300 的交期是多久？", reply: "交期 45 天，FOB 上海 USD 285/台。", score: 40 },
      { conversationId: "wa:a", occurredAt: null, inbound: "MOQ 是多少？", reply: "MOQ 是 10 台。", score: 40 }
    ]
  },
  { name: "检索档案" }
);

const hit = bestExample("请问 SQC-300 的交期是多久？", searchProfile);
check("完全相同问法能命中", hit && hit.matched >= 2, JSON.stringify(hit));
check("命中给出相似度", hit && hit.similarity > 0.9, String(hit?.similarity));

check("毫不相关不命中", bestExample("你们公司在哪个城市？", searchProfile) === null);
check("空档案不命中", bestExample("任意问题", null) === null);
check("空提问不命中", bestExample("", searchProfile) === null);

// 先关掉护栏，单独验检索本身的行为
const resolved = resolveReply("请问 SQC-300 的交期是多久？", searchProfile, { guardrails: [] });
check("规则通道给出回复", resolved.reply.includes("45 天"), resolved.reply);
check("规则通道置信度在门槛区间", resolved.confidence > 0.8 && resolved.confidence <= 0.9, String(resolved.confidence));
check("规则通道标记来源", resolved.source === "profile");
check("命中说明可读", resolved.reason.includes("相似度"), resolved.reason);

/**
 * 出厂护栏会拦下「含金额的历史报价原话」—— 这条是**有意的**，不是缺陷：
 * 客户上个月问价、我们回过 USD 285，今天把同一句原话复用出去，价格可能早就变了。
 * 代价是报价类问答默认走不了规则通道（要人确认或放宽护栏），换来的是不会自动发出过期价格。
 */
const defaultGuarded = resolveReply("请问 SQC-300 的交期是多久？", searchProfile);
check("出厂护栏拦下含金额的历史原话", defaultGuarded.blocked === true, defaultGuarded.reason);
check("被拦时给出可读原因", defaultGuarded.reason.includes("护栏"), defaultGuarded.reason);

const noMatch = resolveReply("你们在哪个城市？", searchProfile);
check("无相近问法时不给编造回复", noMatch.reply === "" && noMatch.blocked === true);
check("无相近问法给出可操作提示", noMatch.reason.includes("人工回复"), noMatch.reason);

// 命中历史原话也要过护栏：以前回过报价，现在复用出去一样违规
const priced = resolveReply("请问 SQC-300 的交期是多久？", searchProfile, { guardrails: ["不承诺价格、折扣、交期或库存，除非有依据"] });
check("含金额的历史原话被护栏拦下", priced.blocked === true, priced.reason);
check("护栏拦截不给出发送内容", priced.reply.includes("45 天") && priced.blocked === true);
const noGuard = resolveReply("请问 SQC-300 的交期是多久？", searchProfile, { guardrails: [] });
check("无护栏时不拦", noGuard.blocked === false);

check("护栏命中金额", applyGuardrails("价格是 USD 285/台", ["不承诺价格"]).blocked === true);
check("护栏不误伤普通文本", applyGuardrails("交期请看说明", ["不承诺价格"]).blocked === false);
check("与价格无关的护栏条目不做金额判断", applyGuardrails("USD 285", ["保持礼貌"]).blocked === false);
check("禁止短语被拦", applyGuardrails("We offer free shipping", [], ["free shipping"]).blocked === true);
check("禁止短语不误伤", applyGuardrails("Shipping takes 45 days", [], ["free shipping"]).blocked === false);

check("转人工关键词命中中文", escalateMatch("我要投诉你们的服务") === "投诉");
check("转人工关键词命中英文", escalateMatch("I will ask my lawyer") === "lawyer");
check("普通消息不触发转人工", escalateMatch("请问交期是多少？") === "");
check("自定义关键词生效", escalateMatch("请转售后", ["售后"]) === "售后");

/* ---------- 导出与杂项 ---------- */

const kit = exportTrainingKit(profile);
check("训练包有标题", kit.includes("# 自动回复训练包"));
check("训练包含写作准则", kit.includes("## 写作准则"));
check("训练包含政策", kit.includes("## 政策（必须遵守）"));
check("训练包含问答对", kit.includes("## 标准问答对") && kit.includes("请问交期？"));
check("训练包注明样本量", kit.includes("1 组问答"), kit.split("\n").find((line) => line.includes("组问答")));

check("文件名带日期", profileFileName(profile, new Date("2026-10-11T00:00:00")) === "goodjob-whatsapp-训练包-20261011.md");
check("指纹稳定", fingerprint("abc") === fingerprint("abc"));
check("指纹区分内容", fingerprint("abc") !== fingerprint("abd"));
check("空值指纹不抛错", typeof fingerprint(null) === "string");

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error(`\n✗ trainer 单测失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ trainer 单测全通过（${passed} 项）`);
