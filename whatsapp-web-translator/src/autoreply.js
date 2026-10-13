/**
 * 自动回复：把「客户新消息」变成「一条回复」。
 *
 * 决策（`decideReply`）与页面动作（填输入框 / 点发送）**刻意分开**：
 * 决策是纯函数，可以脱离浏览器逐条断言；DOM 部分只做"把结论落到页面上"这一件事。
 *
 * 三档模式：
 *   off   —— 完全不动作
 *   draft —— 生成后填进输入框，由人确认后再发（默认，错发不可撤回）
 *   auto  —— 置信度过门槛就直接发出
 *
 * 三道闸门顺序与 CRM 插件一致：转人工关键词 → 时段/频次/日限额 → 话术匹配与护栏。
 */

import { DEFAULT_SETTINGS } from "./settings.js";
import { DEFAULT_ESCALATE_KEYWORDS, DEFAULT_GUARDRAILS, escalateMatch, resolveReply } from "./trainer.js";

export const REPLY_MODES = ["off", "draft", "auto"];

/** 默认值只在这里出现一次：`settings.js` 的 DEFAULT_SETTINGS.autoReply。 */
const FALLBACK = DEFAULT_SETTINGS.autoReply;

export const DEFAULT_DAILY_LIMIT = FALLBACK.dailyLimit;
export const DEFAULT_MIN_INTERVAL_MINUTES = FALLBACK.minIntervalMinutes;
export const DEFAULT_ACTIVE_HOURS = { start: FALLBACK.activeHoursStart, end: FALLBACK.activeHoursEnd };
export const DEFAULT_CONFIDENCE_THRESHOLD = FALLBACK.confidenceThreshold;

/** 出厂设置：把"空数组 = 用出厂默认"这条约定在这里落地一次。 */
export function defaultAutoReplySettings() {
  return {
    ...FALLBACK,
    guardrails: [...DEFAULT_GUARDRAILS],
    escalateKeywords: [...DEFAULT_ESCALATE_KEYWORDS]
  };
}

/** 库里存空数组代表"用出厂默认" —— 与 CRM 插件的 resolveSettings 同一约定。 */
function effectiveKeywords(settings) {
  const list = settings?.escalateKeywords;
  return list && list.length ? list : DEFAULT_ESCALATE_KEYWORDS;
}

function effectiveGuardrails(settings, profile) {
  const list = settings?.guardrails;
  if (list && list.length) return list;
  return profile?.guardrails?.length ? profile.guardrails : DEFAULT_GUARDRAILS;
}

/** 活跃时段判定：`start === end` 视为全天。跨零点（22 → 6）也要成立。 */
export function withinActiveHours(hour, start, end) {
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 当天（本地时区）已发送数量的清零基准。 */
export function localDayKey(now = new Date()) {
  const at = new Date(now);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** 账本：只记「今天发了多少条」和「最后一条什么时候发的」，用来做限额与频控。 */
export function createLedger(now = new Date()) {
  return { day: localDayKey(now), sentToday: 0, lastSentAt: null };
}

export function recordSend(ledger, now = new Date()) {
  const day = localDayKey(now);
  return {
    day,
    sentToday: (ledger?.day === day ? ledger.sentToday ?? 0 : 0) + 1,
    lastSentAt: new Date(now).toISOString()
  };
}

export function sentTodayOf(ledger, now = new Date()) {
  return ledger?.day === localDayKey(now) ? Number(ledger.sentToday) || 0 : 0;
}

/**
 * 纯决策：给一句客户消息和一份档案，回答"该不该回、回什么、能不能直接发"。
 *
 * @param {{ inboundBody:string, profile:object|null, settings:object, now?:Date, ledger?:object }} input
 * @returns {{ action:"skip"|"reply", mode:"off"|"draft"|"auto", body:string, confidence:number, blocked:boolean, reason:string, source:string }}
 */
export function decideReply(input) {
  const now = input.now ? new Date(input.now) : new Date();
  const settings = input.settings ?? {};
  const ledger = input.ledger ?? createLedger(now);
  const skip = (reason, extra = {}) => ({
    action: "skip",
    mode: settings.mode ?? "off",
    body: "",
    confidence: 0,
    blocked: false,
    reason,
    source: "none",
    ...extra
  });

  const mode = REPLY_MODES.includes(settings.mode) ? settings.mode : "off";
  if (!settings.enabled || mode === "off") return skip("自动回复未启用");

  const inbound = String(input.inboundBody ?? "").trim();
  if (!inbound) return skip("客户消息是空的");
  if (/^\[[^\]]{1,20}\]$/u.test(inbound)) return skip("这条是媒体占位，没有可回复的文字");

  const escalate = escalateMatch(inbound, effectiveKeywords(settings));
  if (escalate) return skip(`命中升级关键词「${escalate}」，已交给人工处理`);

  const hour = now.getHours();
  const start = Number(settings.activeHoursStart ?? DEFAULT_ACTIVE_HOURS.start);
  const end = Number(settings.activeHoursEnd ?? DEFAULT_ACTIVE_HOURS.end);
  const inHours = withinActiveHours(hour, start, end);

  const limit = Number(settings.dailyLimit ?? DEFAULT_DAILY_LIMIT);
  const sentToday = sentTodayOf(ledger, now);
  if (mode === "auto" && limit > 0 && sentToday >= limit) {
    return skip(`已达今日自动发送上限 ${limit} 条`);
  }
  const interval = Number(settings.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES);
  if (mode === "auto" && interval > 0 && ledger.lastSentAt) {
    const elapsedMinutes = (now.getTime() - new Date(ledger.lastSentAt).getTime()) / 60_000;
    if (elapsedMinutes < interval) {
      return skip(`距上一条自动回复不足 ${interval} 分钟`);
    }
  }
  // 不在活跃时段时**不生成草稿**：半夜攒一堆草稿反而要人第二天逐条清理。
  if (!inHours) return skip(`不在活跃时段（${start}:00-${end}:00）`);

  if (!input.profile) return skip("还没有训练档案，先去「学习」一次");
  if (input.profile.status !== "ready") return skip("训练档案还没有可用话术样本，请重新学习");

  const resolved = resolveReply(inbound, input.profile, { guardrails: effectiveGuardrails(settings, input.profile) });
  if (!resolved.reply) return skip(resolved.reason, { confidence: resolved.confidence, source: resolved.source });
  if (resolved.blocked) {
    return {
      action: "skip",
      mode,
      body: "",
      confidence: resolved.confidence,
      blocked: true,
      reason: resolved.reason,
      source: resolved.source
    };
  }

  const threshold = Number(settings.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD);
  if (mode === "auto" && resolved.confidence < threshold) {
    return {
      action: "skip",
      mode,
      body: "",
      confidence: resolved.confidence,
      blocked: false,
      reason: `${resolved.reason}（置信度 ${resolved.confidence.toFixed(2)} / 门槛 ${threshold.toFixed(2)}，未达门槛）`,
      source: resolved.source
    };
  }

  return {
    action: "reply",
    mode,
    body: resolved.reply,
    confidence: resolved.confidence,
    blocked: false,
    reason: resolved.reason,
    source: resolved.source
  };
}

/* ------------------------------------------------------------- DOM 动作 */
/* 都带 `typeof document` 守卫：这些函数同时被单测直接调用（Node 里没有 DOM），
   没有守卫就会在 import 之后立刻抛 ReferenceError，把纯逻辑的测试也一起拖挂。 */

export function composer() {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector('#main footer div[contenteditable="true"]') ||
    document.querySelector('#main div[contenteditable="true"][data-lexical-editor="true"]') ||
    document.querySelector('#main div[contenteditable="true"]') ||
    null
  );
}

/**
 * 读回输入框、判断这次写入到底成没成 —— 这是**唯一**可信的成功判据。
 *
 * 为什么不看 `document.execCommand` 的返回值：编辑器可以把这次插入在 `beforeinput`
 * 里取消掉、或者事后按自己的内部状态把 DOM 改回去，而 execCommand 照样返回 true。
 * 于是界面显示「已替换到输入框」、输入框里一个字都没变 —— 用户看到的就是
 * 「我点了替换，它只是确认了一下，输入框里的内容根本没换」。
 *
 * 空白一律折叠再比：编辑器把空格换成 `&nbsp;`、或多包一层 `<p>`，都属正常，不该判失败。
 */
function composerWritten(box, want) {
  const flatten = (value) => String(value ?? "").replace(/\s+/gu, "");
  return flatten(box.innerText || box.textContent || "") === flatten(want);
}

/** 让出一帧 + 一个宏任务：Lexical 靠 `selectionchange` **异步**同步自己的选区。 */
function composerSettle() {
  const frame =
    typeof requestAnimationFrame === "function"
      ? new Promise((resolve) => requestAnimationFrame(() => resolve()))
      : Promise.resolve();
  return frame.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/**
 * 把文字真正写进 WhatsApp 输入框（覆盖原有内容）。
 *
 * 为什么必须走编辑命令、不能直接写 `textContent`：WhatsApp 的输入框是 Lexical 富文本
 * 编辑器，只改 DOM 它内部状态还是空的 —— 字看着填进去了，按回车却发不出去。
 *
 * 但"只会 execCommand 这一招"不够：它会被编辑器吞掉而**仍然返回 true**。所以这里排了
 * 四招，**每一招都读回输入框确认**，一招不成立就换下一招；四招都不成立就返回失败，
 * 由调用方照实说"没写进去"，绝不谎报成功。
 *
 * @returns {Promise<{ok: boolean, how: "insertText"|"selectAll"|"paste"|"dom"|""}>}
 */
export async function fillComposer(text) {
  const box = composer();
  const want = String(text ?? "");
  if (!box || !want) return { ok: false, how: "" };
  box.focus();

  const tryOnce = async (run) => {
    try {
      run();
    } catch {
      /* 这一招在这个编辑器上不可用，换下一招 */
    }
    await composerSettle();
    return composerWritten(box, want);
  };

  const selectWholeBox = () => {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  // ① 整段选中 + 原生插入：多数版本这一招就够
  const plainInsert = await tryOnce(() => {
    selectWholeBox();
    document.execCommand("insertText", false, want);
  });
  if (plainInsert) return { ok: true, how: "insertText" };

  // ② 让编辑器自己 selectAll：选区是它自己建的，它更认
  const editorSelectAll = await tryOnce(() => {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, want);
  });
  if (editorSelectAll) return { ok: true, how: "selectAll" };

  // ③ 合成一次粘贴：Lexical 的 paste 处理直接改它自己的状态，绕开 beforeinput 那道坎
  const pasted = await tryOnce(() => {
    document.execCommand("selectAll", false, null);
    const data = new DataTransfer();
    data.setData("text/plain", want);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  if (pasted) return { ok: true, how: "paste" };

  // ④ 兜底：直接写 DOM 再派发 input。编辑器可能不认（那就是"看着有字、发不出去"），
  //    所以把这一档如实标出来，由界面照实提示。
  const domWrite = await tryOnce(() => {
    box.textContent = want;
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: want }));
  });
  if (domWrite) return { ok: true, how: "dom" };

  return { ok: false, how: "" };
}

export function sendButton() {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector('#main [data-testid="send"]') ||
    document.querySelector('#main button[aria-label="Send"]') ||
    document.querySelector('#main span[data-icon="send"]')?.closest("button") ||
    null
  );
}

export function clickSend() {
  const button = sendButton();
  if (!button) return false;
  button.click();
  return true;
}

/** 找到容器里最后一条入站消息行 —— 两层定位，与 content.js/archive.js 的 messageRows 同策略。 */
export function lastInboundRow(container) {
  if (!container) return null;
  const legacy = Array.from(container.querySelectorAll("div.message-in"));
  if (legacy.length) return legacy.at(-1) ?? null;
  // 改版兜底：行类名被换掉后，从后往前找 msg-container 气泡、落到 data-id 行上判方向。
  const bubbles = Array.from(container.querySelectorAll('[data-testid="msg-container"]'));
  for (let i = bubbles.length - 1; i >= 0; i -= 1) {
    const row = bubbles[i].closest("[data-id]") || bubbles[i];
    if ((row.getAttribute("data-id") || "").startsWith("false_")) return row;
  }
  return null;
}
