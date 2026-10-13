/* 翻译「判定层」真实语料评测：直接调用扩展生产代码里的纯函数，不 mock、不联网。
   评的是三件事：这条消息会不会被翻（isTranslatable）、会不会被误判成中文而跳过（isChineseText）、
   源语言判得对不对（detectLanguage → 会写进 prompt 的 "Translate from X to zh-CN"）。
   用法：node tests/language-eval.mjs（在 whatsapp-web-translator/ 目录下跑） */
"use strict";
import {
  isTranslatable,
  isChineseText,
  detectLanguage,
  cacheKey,
  normalizeEndpoint
} from "../src/settings.js";

/* expect: "translate" = 期望翻；"skip" = 期望跳过
   lang: 期望判定的源语言（null = 不校验，比如代码明确不支持的语种，只看行为后果） */
const CASES = [
  // —— 英语（主力场景）——
  { t: "Could you send me your best FOB Shanghai price for 500 pcs?", expect: "translate", lang: "en", tag: "询盘" },
  { t: "Please see attached PI No. GJ-2026-1017, valid for 30 days.", expect: "translate", lang: "en", tag: "单据号/日期" },
  { t: "SQC-300 load cell × 4 @ USD 285/pc, CIF Hamburg, delivery 45 days.", expect: "translate", lang: "en", tag: "型号/币种/港口" },
  { t: "We are not interested in the stainless version, only carbon steel.", expect: "translate", lang: "en", tag: "否定句" },
  { t: "OK", expect: "translate", lang: "en", tag: "极短确认" },
  { t: "Yes, pls send 2 pcs samples to the address below.", expect: "translate", lang: "en", tag: "缩写/短句" },
  // —— 已中文（应跳过，别浪费钱）——
  { t: "感谢您的报价，我们内部再确认一下。", expect: "skip", lang: null, tag: "纯中文" },
  { t: "单价 12.5 美元，含运费，交期 45 天。", expect: "skip", lang: null, tag: "中文+数字" },
  { t: "OK，收到样品了，谢谢。", expect: "skip", lang: null, tag: "中文夹英文单词" },
  // —— 非文字/无信息（应跳过）——
  { t: "500", expect: "skip", lang: null, tag: "纯数字" },
  { t: "５００", expect: "skip", lang: null, tag: "全角数字" },
  { t: "$12.50", expect: "skip", lang: null, tag: "金额" },
  { t: "https://acme-instruments.de/quote/2026", expect: "skip", lang: null, tag: "链接" },
  { t: "👍👍👌", expect: "skip", lang: null, tag: "表情" },
  { t: "???", expect: "skip", lang: null, tag: "标点" },
  { t: "   ", expect: "skip", lang: null, tag: "空白" },
  // —— 代码声称覆盖的语种 ——
  { t: "¿Podrían confirmar el plazo de entrega y el precio FOB?", expect: "translate", lang: "es", tag: "西语" },
  { t: "Olá, gostaria de receber uma cotação para 300 unidades.", expect: "translate", lang: "pt", tag: "葡语" },
  { t: "Bonjour, pouvez-vous confirmer la commande et le délai ?", expect: "translate", lang: "fr", tag: "法语" },
  { t: "Здравствуйте, пришлите, пожалуйста, актуальный прайс-лист.", expect: "translate", lang: "ru", tag: "俄语" },
  // —— 未在 detectLanguage 列表里的语种（只看行为后果）——
  { t: "Guten Tag, wir brauchen 500 Stück von Modell SQC-300. Bitte um Angebot.", expect: "translate", lang: "de", tag: "德语" },
  { t: "Buongiorno, vorremmo ricevere un preventivo per 200 pezzi.", expect: "translate", lang: "it", tag: "意大利语" },
  { t: "مرحبا، هل يمكنكم إرسال عرض الأسعار للكمية 400 قطعة؟", expect: "translate", lang: "ar", tag: "阿拉伯语" },
  { t: "Cảm ơn bạn, xin gửi báo giá cho 250 sản phẩm.", expect: "translate", lang: "vi", tag: "越南语" },
  { t: "ありがとうございます。納期を教えていただけますか。", expect: "translate", lang: "ja", tag: "日语" },
  { t: "안녕하세요, 견적서를 보내주실 수 있나요?", expect: "translate", lang: "ko", tag: "韩语" },
  { t: "ขอบคุณครับ ขอใบเสนอราคาสำหรับ 100 ชิ้น", expect: "translate", lang: "th", tag: "泰语" },
  // —— 多段长文本 ——
  {
    t: "Hi Anna,\n\nThanks for the samples. Two questions:\n1) Can you do CIF Hamburg at the same price?\n2) What is the MOQ for the stainless version?\n\nBest regards,\nJohn",
    expect: "translate", lang: "en", tag: "多段邮件"
  },
  { t: "A".repeat(4000), expect: "translate", lang: "en", tag: "4000 字超长" }
];

const rows = [];
let judgeOk = 0, langOk = 0, langChecked = 0;
const defects = [];

for (const c of CASES) {
  const translatable = isTranslatable(c.t);
  const chinese = isChineseText(c.t);
  const willTranslate = translatable && !chinese;
  const got = willTranslate ? "translate" : "skip";
  const hit = got === c.expect;
  if (hit) judgeOk += 1;

  const detected = willTranslate ? detectLanguage(c.t) : "—";
  let langHit = null;
  if (c.lang && willTranslate) {
    langChecked += 1;
    langHit = detected === c.lang;
    if (langHit) langOk += 1;
  }

  if (!hit) {
    defects.push(
      c.expect === "skip"
        ? `会重复翻译本应跳过：${c.tag}「${c.t.slice(0, 44)}」`
        : `该翻却被跳过：${c.tag}「${c.t.slice(0, 44)}」（判定为中文=${chinese}）`
    );
  } else if (langHit === false) {
    defects.push(`源语言判错：${c.tag} 期望 ${c.lang}，实际 ${detected}（prompt 会写成 from ${detected}）`);
  }

  rows.push({
    tag: c.tag,
    text: c.t.length > 46 ? `${c.t.slice(0, 46).replace(/\n/gu, "⏎")}…(${c.t.length})` : c.t.replace(/\n/gu, "⏎"),
    translatable,
    chinese,
    got: got === "translate" ? "翻" : "跳过",
    ok: hit ? "✓" : "✗",
    detected: c.lang ? `${detected}${langHit === null ? "" : langHit ? " ✓" : ` ✗(期望${c.lang})`}` : ""
  });
}

// 缓存键 / 端点归一化的补充实测
const cacheProbes = [
  { name: "大小写不同 → 是否各打一次上游", a: cacheKey("Please confirm", "zh-CN", "gpt-5.5"), b: cacheKey("please confirm", "zh-CN", "gpt-5.5") },
  { name: "多余空格/换行 → 是否复用缓存", a: cacheKey("hello  world", "zh-CN", "gpt-5.5"), b: cacheKey("hello world", "zh-CN", "gpt-5.5") },
  { name: "换目标语言 → 应各自缓存", a: cacheKey("hello", "zh-CN", "gpt-5.5"), b: cacheKey("hello", "en", "gpt-5.5") }
].map((p) => ({ name: p.name, same: p.a === p.b }));

const endpointProbes = ["https://api.52token.org/v1", "https://api.52token.org", "https://api.52token.org/v1/chat/completions"]
  .map((u) => `${u}  →  ${normalizeEndpoint(u)}`);

const pad = (s, n) => String(s).padEnd(n, " ");
console.log("tag".padEnd(12) + pad("文本", 50) + pad("可译", 6) + pad("判中文", 7) + pad("动作", 6) + "判定 源语言判定");
for (const r of rows) {
  console.log(pad(r.tag, 12) + pad(r.text, 50) + pad(r.translatable ? "是" : "否", 6) + pad(r.chinese ? "是" : "否", 7) + pad(r.got, 6) + r.ok + "    " + r.detected);
}
console.log("\n=== 汇总 ===");
console.log(`行为判定（该翻/该跳过）：${judgeOk}/${CASES.length} 正确 → ${(judgeOk / CASES.length * 100).toFixed(1)}%`);
console.log(`源语言判定（仅统计需翻译且有期望的 ${langChecked} 条）：${langOk}/${langChecked} 正确 → ${(langOk / langChecked * 100).toFixed(1)}%`);
console.log("\n=== 缺陷清单 ===");
defects.forEach((d, i) => console.log(`${i + 1}. ${d}`));
console.log("\n=== 缓存键行为 ===");
for (const p of cacheProbes) console.log(`${p.same ? "复用" : "不复用（各打一次上游）"} · ${p.name}`);
console.log("\n=== 端点归一化 ===");
endpointProbes.forEach((e) => console.log("  " + e));
