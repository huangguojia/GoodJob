/**
 * 自动回复决策层单测：时段 / 限额 / 频控 / 转人工 / 护栏 / 置信度门槛 / 三种模式。
 * 决策是纯函数，DOM 动作只在 e2e 里验。跑法：node tests/autoreply.test.mjs
 */

import {
  composer,
  createLedger,
  decideReply,
  defaultAutoReplySettings,
  fillComposer,
  localDayKey,
  recordSend,
  sentTodayOf,
  sendButton,
  withinActiveHours
} from "../src/autoreply.js";
import { buildProfileFromCorpus, emptyCorpus } from "../src/trainer.js";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ""}`);
}

/** 一份"能命中"的档案：客户问交期，历史原话里有一句不含金额的回答。 */
const profile = buildProfileFromCorpus(
  {
    ...emptyCorpus(),
    outbound: ["交期 45 天，请确认收货港口。", "MOQ 是 10 台。"],
    inbound: ["请问交期要多久？", "MOQ 是多少？"],
    conversations: 1,
    messages: 4,
    exchanges: [
      { conversationId: "wa:a", occurredAt: null, inbound: "请问 SQC-300 的交期要多久？", reply: "交期 45 天，请确认收货港口。", score: 40 },
      { conversationId: "wa:a", occurredAt: null, inbound: "MOQ 是多少？", reply: "MOQ 是 10 台。", score: 40 }
    ]
  },
  { name: "决策档案" }
);

const base = defaultAutoReplySettings();
/** 关掉时段限制，让时段相关的用例单独控制（默认 8-22 点在测试跑的时候可能不在）。 */
function settings(patch = {}) {
  return { ...base, enabled: true, mode: "draft", activeHoursStart: 0, activeHoursEnd: 0, ...patch };
}

const noon = new Date("2026-10-11T12:00:00");
const question = "请问 SQC-300 的交期要多久？";

/* ---------- 时段 ---------- */

check("时段内（正常区间）", withinActiveHours(10, 8, 22) === true);
check("时段外（正常区间）", withinActiveHours(23, 8, 22) === false);
check("时段下界含", withinActiveHours(8, 8, 22) === true);
check("时段上界不含", withinActiveHours(22, 8, 22) === false);
check("跨零点：22-6 点里的 2 点", withinActiveHours(2, 22, 6) === true);
check("跨零点：22-6 点里的 23 点", withinActiveHours(23, 22, 6) === true);
check("跨零点：22-6 点里的 12 点", withinActiveHours(12, 22, 6) === false);
check("起止相同视为全天", withinActiveHours(3, 9, 9) === true);

/* ---------- 账本 ---------- */

const ledger0 = createLedger(new Date("2026-10-11T12:00:00"));
check("新账本当天为 0", sentTodayOf(ledger0, new Date("2026-10-11T23:00:00")) === 0);
const ledger1 = recordSend(ledger0, new Date("2026-10-11T12:00:00"));
check("发一条后计 1", ledger1.sentToday === 1);
check("记录最后发送时间（ISO 存储，时区无关）", ledger1.lastSentAt === new Date("2026-10-11T12:00:00").toISOString(), ledger1.lastSentAt);
const ledger2 = recordSend(ledger1, new Date("2026-10-11T12:05:00"));
check("再发一条计 2", ledger2.sentToday === 2);
check("跨天后计数归零", sentTodayOf(ledger2, new Date("2026-10-12T09:00:00")) === 0);
check("跨天后再记也会从 1 开始", recordSend(ledger2, new Date("2026-10-12T09:00:00")).sentToday === 1);
check("日期键是本地日期", localDayKey(new Date("2026-10-11T23:59:00")) === "2026-10-11");

/* ---------- 决策：不该回的情况 ---------- */

check("未启用直接跳过", decideReply({ inboundBody: question, profile, settings: settings({ enabled: false }) }).action === "skip");
check("模式 off 直接跳过", decideReply({ inboundBody: question, profile, settings: settings({ mode: "off" }) }).action === "skip");
check("空消息跳过", decideReply({ inboundBody: "   ", profile, settings: settings() }).reason.includes("空"));
check("媒体占位跳过", decideReply({ inboundBody: "[图片]", profile, settings: settings() }).reason.includes("媒体占位"));

const escalated = decideReply({ inboundBody: "我要投诉，请给我退款", profile, settings: settings() });
check("投诉类消息转人工", escalated.action === "skip" && escalated.reason.includes("投诉"), escalated.reason);
const lawyer = decideReply({ inboundBody: "I will contact my lawyer about this", profile, settings: settings() });
check("英文法律类消息转人工", lawyer.action === "skip" && lawyer.reason.includes("lawyer"), lawyer.reason);

const night = decideReply({ inboundBody: question, profile, settings: settings({ activeHoursStart: 8, activeHoursEnd: 22 }), now: new Date("2026-10-11T03:00:00") });
check("深夜不生成", night.action === "skip" && night.reason.includes("活跃时段"), night.reason);
const nightDraft = decideReply({ inboundBody: question, profile, settings: settings({ mode: "draft", activeHoursStart: 8, activeHoursEnd: 22 }), now: new Date("2026-10-11T03:00:00") });
check("深夜连草稿也不生成", nightDraft.action === "skip", nightDraft.reason);

check("没有档案跳过", decideReply({ inboundBody: question, profile: null, settings: settings() }).reason.includes("还没有训练档案"));
const notReady = { ...profile, status: "empty" };
check("档案样本不足跳过", decideReply({ inboundBody: question, profile: notReady, settings: settings() }).reason.includes("样本"));
const noHit = decideReply({ inboundBody: "你们公司总部在哪个城市？", profile, settings: settings() });
check("话术库无相近问法时跳过", noHit.action === "skip" && noHit.reason.includes("人工回复"), noHit.reason);
check("无相近问法时不给空回复", noHit.body === "");

/* ---------- 决策：额度与频控 ---------- */

const quota = decideReply({
  inboundBody: question,
  profile,
  settings: settings({ mode: "auto", dailyLimit: 2 }),
  now: noon,
  ledger: { day: localDayKey(noon), sentToday: 2, lastSentAt: null }
});
check("达日上限后跳过", quota.action === "skip" && quota.reason.includes("上限"), quota.reason);

const quotaDraft = decideReply({
  inboundBody: question,
  profile,
  settings: settings({ mode: "draft", dailyLimit: 2 }),
  now: noon,
  ledger: { day: localDayKey(noon), sentToday: 99, lastSentAt: null }
});
check("草稿模式不受发送上限约束", quotaDraft.action === "reply", quotaDraft.reason);

const tooSoon = decideReply({
  inboundBody: question,
  profile,
  settings: settings({ mode: "auto", minIntervalMinutes: 10 }),
  now: noon,
  ledger: { day: localDayKey(noon), sentToday: 1, lastSentAt: new Date(noon.getTime() - 3 * 60_000).toISOString() }
});
check("间隔不足时跳过", tooSoon.action === "skip" && tooSoon.reason.includes("不足 10 分钟"), tooSoon.reason);

const enough = decideReply({
  inboundBody: question,
  profile,
  settings: settings({ mode: "auto", minIntervalMinutes: 10 }),
  now: noon,
  ledger: { day: localDayKey(noon), sentToday: 1, lastSentAt: new Date(noon.getTime() - 30 * 60_000).toISOString() }
});
check("间隔够了就放行", enough.action === "reply", enough.reason);

/* ---------- 决策：正常回复与门槛 ---------- */

const draft = decideReply({ inboundBody: question, profile, settings: settings(), now: noon });
check("草稿模式生成回复", draft.action === "reply" && draft.mode === "draft", JSON.stringify(draft));
check("草稿内容是历史原话", draft.body.includes("45 天"), draft.body);
check("草稿带上理由", draft.reason.includes("相似度"), draft.reason);
check("草稿置信度落在 0-1", draft.confidence > 0 && draft.confidence <= 1, String(draft.confidence));

const autoPass = decideReply({ inboundBody: question, profile, settings: settings({ mode: "auto", confidenceThreshold: 0.5 }), now: noon });
check("全自动模式：过门槛即回复", autoPass.action === "reply" && autoPass.mode === "auto", JSON.stringify(autoPass));

const autoFail = decideReply({ inboundBody: question, profile, settings: settings({ mode: "auto", confidenceThreshold: 0.99 }), now: noon });
check("全自动模式：未达门槛不回复", autoFail.action === "skip", JSON.stringify(autoFail));
check("未达门槛时说明门槛", autoFail.reason.includes("门槛"), autoFail.reason);

// 置信度随问法接近程度变化：这句同时带 MOQ 和交期，跟任一条样板都只重合一截
const fuzzy = decideReply({ inboundBody: "SQC-300 的 MOQ 和交期？", profile, settings: settings({ mode: "auto", confidenceThreshold: 0.9 }), now: noon });
check("问法不完整时置信度下降", fuzzy.confidence < draft.confidence, `${fuzzy.confidence} vs ${draft.confidence}`);
check("门槛卡在中间时确实被拦住", fuzzy.action === "skip", JSON.stringify(fuzzy));

/* ---------- 决策：护栏 ---------- */

/** 一份含报价原话的档案：用来验证"金额类护栏"到底拦什么。 */
const priced = buildProfileFromCorpus(
  {
    ...emptyCorpus(),
    outbound: ["价格 USD 285/台。"],
    inbound: ["价格多少？"],
    conversations: 1,
    messages: 2,
    exchanges: [{ conversationId: "wa:a", occurredAt: null, inbound: "SQC-300 价格是多少？", reply: "价格 USD 285/台。", score: 40 }]
  },
  { name: "报价档案" }
);

/**
 * 护栏的机器可判定部分**只针对金额**：条目里提到价格/折扣/交期/库存时，
 * 回复里出现任何金额字样才拦。所以"提到交期"的规则不会因为回复里写了"交期 45 天"就拦 ——
 * 这条语义与 CRM 插件 `violatesGuardrail` 一致，故意不做模糊猜测（误拦比漏拦更容易让人关掉功能）。
 */
check("提到交期的护栏 + 回复含金额 → 拦", decideReply({
  inboundBody: "SQC-300 价格是多少？",
  profile: priced,
  settings: settings({ guardrails: ["不承诺交期"] }),
  now: noon
}).action === "skip");
check("提到交期的护栏 + 回复无金额 → 放行", decideReply({
  inboundBody: question,
  profile,
  settings: settings({ guardrails: ["不承诺交期"] }),
  now: noon
}).action === "reply");
check("与金额无关的护栏条目不做任何拦", decideReply({
  inboundBody: question,
  profile,
  settings: settings({ guardrails: ["保持礼貌与专业"] }),
  now: noon
}).action === "reply");
const blocked = decideReply({ inboundBody: "SQC-300 价格是多少？", profile: priced, settings: settings(), now: noon });
check("默认护栏拦下含金额的原话", blocked.action === "skip" && blocked.blocked === true, blocked.reason);
check("被护栏拦时不给出发送内容", blocked.body === "");
const allowed = decideReply({ inboundBody: "SQC-300 价格是多少？", profile: priced, settings: settings({ guardrails: ["保持礼貌"] }), now: noon });
check("清空护栏后原话可用", allowed.action === "reply", allowed.reason);

/* ---------- 默认值 ---------- */

const defaults = defaultAutoReplySettings();
check("默认关闭", defaults.enabled === false);
check("默认草稿模式", defaults.mode === "draft");
check("默认转人工关键词非空", defaults.escalateKeywords.length >= 8, String(defaults.escalateKeywords.length));
check("默认护栏非空", defaults.guardrails.length >= 4, String(defaults.guardrails.length));
check("默认不引用出厂数组本体（改动不串味）", defaults.guardrails !== defaultAutoReplySettings().guardrails);
check("默认限额为正", defaults.dailyLimit > 0);

/* ---------- DOM 动作在无浏览器时应安全返回 ---------- */

check("无 DOM 时取输入框返回 null", composer() === null);
check("无 DOM 时取发送按钮返回 null", sendButton() === null);
check("无 DOM 时填充返回失败对象", (await fillComposer("x"))?.ok === false);

/* ---------- 「写进输入框」必须读回确认，不能信 execCommand 的返回值 ----------
 *
 * 为什么这层必须单独测：真机上 WhatsApp 的输入框是 Lexical，它会把不认的改动
 * **悄悄吞掉**，而 `document.execCommand` 照样返回 true。旧实现只看这个返回值，于是
 * 点「替换到输入框」后界面显示「已替换到输入框」、输入框里一个字都没变
 * （用户原话：「它只是确认了一下，没真的替换」）。
 * 这里用一份假 DOM 把"正常""吞掉插入""只认粘贴""彻底不认""重排空白"五种编辑器各演一遍。
 */

const editorBox = { value: "" };
let activeBox = null;

function installFakeDom(kind) {
  editorBox.value = "";
  const box = {};
  Object.defineProperty(box, "innerText", { get: () => editorBox.value });
  // hostile：连"直接写 DOM"都被编辑器挡掉（真机上是它按自己的状态把 DOM 覆盖回来）
  Object.defineProperty(box, "textContent", {
    get: () => editorBox.value,
    set: (next) => {
      if (kind !== "hostile") editorBox.value = String(next ?? "");
    }
  });
  box.focus = () => {};
  box.setText = (value) => {
    editorBox.value = String(value);
  };
  box.dispatchEvent = (event) => {
    // 编辑器自己的「粘贴」处理：读剪贴板、写进自己的状态（Lexical 就是这么干的）
    if (event?.type === "paste" && kind !== "hostile") {
      const incoming = event.clipboardData?.getData("text/plain") ?? "";
      if (incoming) editorBox.value = incoming;
    }
    return true;
  };
  box.execCommand = (command, value) => {
    if (command === "selectAll") return true;
    if (command !== "insertText") return false;
    if (kind === "plain") {
      editorBox.value = String(value ?? "");
      return true;
    }
    if (kind === "reflow") {
      // 编辑器把空白重排（真机上是 &nbsp; / 多包一层 <p>）
      editorBox.value = String(value ?? "").replace(/\s+/gu, " \n");
      return true;
    }
    // swallow / hostile：编辑器不认这次插入，**但命令照样报成功** —— 这就是旧实现被坑的那一下
    return true;
  };

  globalThis.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  globalThis.document = {
    querySelector: () => box,
    createRange: () => ({ selectNodeContents() {}, deleteContents() {} }),
    execCommand: (command, _ui, value) => box.execCommand(command, value)
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.DataTransfer = class {
    constructor() {
      this.data = new Map();
    }
    setData(type, value) {
      this.data.set(type, String(value));
    }
    getData(type) {
      return this.data.get(type) ?? "";
    }
  };
  globalThis.ClipboardEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      this.clipboardData = init.clipboardData ?? null;
    }
  };
  globalThis.InputEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  activeBox = box;
  return box;
}

installFakeDom("plain");
const plainFill = await fillComposer("请确认交期");
check(
  "普通输入框：原生插入一招到位，并且读回确认过",
  plainFill.ok === true && plainFill.how === "insertText",
  JSON.stringify(plainFill)
);

installFakeDom("reflow");
const reflowFill = await fillComposer("Please confirm the lead time");
check(
  "编辑器把空白重排不算失败（否则每次替换都会误判成没写进去）",
  reflowFill.ok === true,
  JSON.stringify(reflowFill)
);

const swallowBox = installFakeDom("swallow");
swallowBox.setText("旧的草稿");
const swallowed = await fillComposer("Please confirm the lead time");
check(
  "编辑器吞掉原生插入时，自动改走「粘贴」那条路（Lexical 只认这条）",
  swallowed.ok === true && swallowed.how === "paste",
  JSON.stringify(swallowed)
);
check(
  "换招之后写进去的是译文、旧草稿被**覆盖**（不是追加）",
  activeBox.innerText === "Please confirm the lead time",
  activeBox.innerText
);

const hostileBox = installFakeDom("hostile");
hostileBox.setText("麻烦确认一下交期");
const hostile = await fillComposer("Please confirm the lead time");
check(
  "⚠️ 四招都不成立时必须报失败 —— 旧实现信 execCommand 的返回值，就会在这里谎报「已替换到输入框」",
  hostile.ok === false,
  JSON.stringify(hostile)
);
check("写不进去时输入框保持原样（不能被写坏）", hostileBox.innerText === "麻烦确认一下交期", hostileBox.innerText);

check("空文字不去动输入框", (await fillComposer(""))?.ok === false);

/* ---------- 汇总 ---------- */

if (failures.length) {
  console.error(`\n✗ autoreply 单测失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ autoreply 单测全通过（${passed} 项）`);
