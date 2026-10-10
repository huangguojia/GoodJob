/**
 * 「新增客户资料识别」结果归因的回归测试。
 *
 * 起因（2026-10-10 实测事故）：用户上传一份二进制 .xls 形式发票，CLI 读不了，
 * 回了**合法**的空字段 JSON + 警告「该文件是二进制 .xls，Read 无法解析」。
 * 旧实现只看「有没有字段」，于是报「CLI 返回的内容不是可解析的 JSON」——
 * 结论和真实原因完全相反。下面这些断言保证四种归因不会再串味。
 */
import assert from "node:assert/strict";
import {
  normalizeCustomerIntakeFields,
  parseCustomerIntakeResult
} from "./customer-intake-parse.js";

// ── 1. 正常：抽到字段 ─────────────────────────────────────────────
const ok = parseCustomerIntakeResult({
  resultText: '{"fields":{"company":"ACME Trading","email":"buyer@acme.example"},"confidence":0.8,"warnings":[],"summary":"展会名片"}',
  status: "succeeded"
});
assert.equal(ok.outcome, "ok");
assert.equal(ok.usable, true);
assert.equal(ok.fields.company, "ACME Trading");
assert.equal(ok.parseError, "");
assert.equal(ok.emptyReason, "");

// ── 2. 本次事故：JSON 合法但零字段，绝不能报「不是可解析的 JSON」──
// 这正是二进制 .xls 的真实返回形状：字段全空、confidence 0、warnings 写清原因。
const emptyResult = parseCustomerIntakeResult({
  resultText: JSON.stringify({
    fields: { company: "", email: "", phone: "" },
    confidence: 0,
    warnings: ["文件为二进制 .xls 格式，Read 工具无法解析其内容，需人工用表格软件打开核对"],
    summary: "该 .xls 二进制表格未识别到任何客户信息。"
  }),
  status: "succeeded"
});
assert.equal(emptyResult.outcome, "empty");
assert.equal(emptyResult.usable, false, "没抽到字段就仍然不算可用");
assert.equal(emptyResult.parseError, "", "零字段不是解析失败，不能再说「不是可解析的 JSON」");
assert.match(emptyResult.emptyReason, /没有从这份资料里抽到/u);
assert.equal(emptyResult.warnings.length, 1, "CLI 给出的原因必须原样保留给用户");
assert.match(emptyResult.warnings[0], /二进制/u);
assert.equal(emptyResult.summary, "该 .xls 二进制表格未识别到任何客户信息。");
assert.match(emptyResult.rawPreview, /二进制/u, "原始返回片段要留给排查用");

// ── 3. 真的解析不出 JSON（模型只回了散文）────────────────────────
const prose = parseCustomerIntakeResult({
  resultText: "我无法读取该文件，请人工核对后填写。",
  status: "succeeded"
});
assert.equal(prose.outcome, "unparsable");
assert.equal(prose.parseError, "CLI 返回的内容不是可解析的 JSON，请重新识别或直接手工填写");
assert.match(prose.rawPreview, /无法读取/u);

// ── 4. 输出被截断：话术要说「截断」，别甩锅给 JSON ────────────────
const truncated = parseCustomerIntakeResult({
  resultText: '{"fields":{"company":"ACME Trad',
  status: "succeeded",
  outputTruncated: true
});
assert.equal(truncated.outcome, "unparsable");
assert.match(truncated.parseError, /截断/u);

// ── 5. 任务成功但什么都没返回 ────────────────────────────────────
const silent = parseCustomerIntakeResult({ resultText: "   ", status: "succeeded" });
assert.equal(silent.outcome, "no_output");
assert.match(silent.parseError, /没有返回任何内容/u);

// ── 6. 任务失败且没返回内容：把话术留给上层诊断，不要重复报「没内容」
const failed = parseCustomerIntakeResult({ resultText: "", status: "failed" });
assert.equal(failed.outcome, "no_output");
assert.equal(failed.parseError, "");

// ── 7. 全角标点 / 整段裸换行 / 尾随逗号：容错修复后仍要能解析 ─────
const messy = parseCustomerIntakeResult({
  resultText: '｛"fields"：{"company"："宁波精锐机械有限公司","otherNotes":"第一行\n第二行"}，"confidence"：0.6，"warnings"：[]，"summary"："名片"，｝',
  status: "succeeded"
});
assert.equal(messy.outcome, "ok", "全角花括号 / 全角冒号 / 裸换行 / 尾随逗号都应被修复后解析");
assert.equal(messy.fields.company, "宁波精锐机械有限公司");
assert.match(messy.fields.otherNotes, /第一行 第二行/u, "字符串里的裸换行要转义后再压平");

// ── 8. 字段裁剪：白名单 / 超长 / 非法 WhatsApp ────────────────────
const trimmed = normalizeCustomerIntakeFields({
  fields: {
    company: "A".repeat(300),
    whatsapp: "0151 1234 5678",
    unknownField: "不该出现"
  }
});
assert.equal(trimmed.fields.company.length, 120, "超出上限要截断");
assert.equal(trimmed.fields.whatsapp, undefined, "不含国家码的号码要丢掉");
assert.ok(trimmed.warnings.some((item) => item.includes("WhatsApp")), "丢掉的号码要给出警告");
assert.equal(trimmed.fields.unknownField, undefined, "白名单外的字段一律不要");

// ── 9. 合法 WhatsApp 归一化 + 顶层平铺结构也要认 ──────────────────
assert.equal(normalizeCustomerIntakeFields({ fields: { whatsapp: "+49 151 1234 5678" } }).fields.whatsapp, "+4915112345678");
assert.deepEqual(Object.keys(normalizeCustomerIntakeFields({ company: "Flat Ltd" }).fields), ["company"]);

console.log("✓ 客户资料识别归因：9 组断言全部通过（含二进制表格零字段场景）");
