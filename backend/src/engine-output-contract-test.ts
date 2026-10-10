/**
 * CLI 输出契约测试（engine-output.ts + ai-engine-prompts.ts 的解析层）。
 *
 * 每个用例都对应一类**实测发生过**的脏输出——目的不是验证「正常输出能解析」，
 * 而是验证「不正常输出也能接住」：CLI 敞开了挖，接不住就会显示不出来。
 */
import {
  applyResearchEnginePatch,
  extractEngineJson,
  normalizeAcquisitionCompanies,
  normalizeEmailPatch,
  normalizeResearchPatch,
  normalizeTenderReport
} from "./ai-engine-prompts.js";
import { readInt, readText, splitByLimit, toArray, unwrapEnginePayload } from "./engine-output.js";

let passed = 0;
function check(ok: boolean, label: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    process.exitCode = 1;
  }
}

// ── L1/L2：JSON 抠取（真实脏输出） ───────────────────────────────────────────
check(extractEngineJson('```json\n{"summary":"ok"}\n```')?.summary === "ok",
  "```json 围栏能剥掉");
check(extractEngineJson('结果如下：\n{"a":1}\n以上。')?.a === 1,
  "JSON 前后带说明文字能抠出来");
check(extractEngineJson('{"a":1}\n{"summary":"最后一个才是结果"}')?.summary === "最后一个才是结果",
  "多段 JSON 取最后一个（流式输出里前面会有别的 JSON）");
check(extractEngineJson('这是结论：\n｛"summary"："全角标点"｝')?.summary === "全角标点",
  "全角花括号/冒号/引号（整段修复后）能解析");
check(extractEngineJson('{"body":"第一行\n第二行"}')?.body === "第一行\n第二行",
  "字符串内裸换行（JSON 规范外）能修复");
check(extractEngineJson('{"a":1,}')?.a === 1,
  "尾随逗号能修复");
check(extractEngineJson("CLI 只说了一句话，没有 JSON") === null,
  "确实没有 JSON 时返回 null（不误判）");
check(extractEngineJson("") === null, "空输出返回 null");

// ── L2：别名 + 类型强转 + 剥壳 ──────────────────────────────────────────────
const aliased = normalizeAcquisitionCompanies({
  data: {
    companies: [{
      company_name: "ACME Weighing GmbH",
      website: "acme-weighing.de",
      "国家": "德国",
      "主营业务": "工业称重设备",
      confidence: "88"
    }]
  }
});
check(aliased.length === 1 && aliased[0]!.company === "ACME Weighing GmbH",
  "公司名走别名（company_name / 公司名称）能识别");
check(aliased[0]!.country === "德国" && aliased[0]!.business === "工业称重设备",
  "中文键名（国家 / 主营业务）能识别");
check(aliased[0]!.website === "https://acme-weighing.de",
  "裸域名自动补协议（否则前端渲染不出可点链接）");
check(aliased[0]!.confidence === 88, "字符串数字 \"88\" 强转为 88");

const singleValue = normalizeResearchPatch({ talkTracks: "只有一句开场白" });
check(singleValue.talkTracks.length === 1 && singleValue.talkTracks[0] === "只有一句开场白",
  "单值自动转数组（模型只给了一条也收）");

const jsonStringArray = normalizeResearchPatch({ opportunities: '["机会一","机会二"]' });
check(jsonStringArray.opportunities.length === 2,
  "字符串包裹的 JSON 数组能解出来");

const objectArray = normalizeResearchPatch({ opportunities: [{ text: "机会写成对象" }] });
check(objectArray.opportunities.length === 1 && objectArray.opportunities[0] === "机会写成对象",
  "对象数组（{text:…}）也能读成文本");

check(unwrapEnginePayload({ data: "这是业务字段的字符串值", companies: [{ company: "X" }] }, ["companies"])["companies"] !== undefined,
  "顶层已有业务字段时不误剥外层");

check(readInt({ relevance: "85%" }, ["relevance"], 0, 100) === 85,
  "\"85%\" 取首个数字");
check(readInt({ relevance: "很高" }, ["relevance"], 0, 100) === null,
  "无数字时返回 null（不瞎猜）");
check(readText({ company: 123 }, ["company"], 20) === "123",
  "数字被当文本读时也认");

check(toArray(undefined).length === 0 && toArray([1, 2]).length === 2,
  "toArray 对空值与数组都稳定");

// ── 开发信：包壳 + 保留换行 ────────────────────────────────────────────────
const email = normalizeEmailPatch({ draft: { Subject: "Flow meters for your plant", content: "Dear team,\n\nBody line.\n\nBest regards" } });
check(email.subject === "Flow meters for your plant", "开发信剥掉 draft 外壳，Subject 大小写变体能认");
check(email.body.split("\n").length === 5,
  "邮件正文保留段落换行（压平成一行就废了）");

// ── L3：溢出不丢 ───────────────────────────────────────────────────────────
const manyFindings = {
  findings: Array.from({ length: 35 }, (_, index) => ({ label: `事实${index + 1}`, value: `值${index + 1}` })),
  opportunities: Array.from({ length: 12 }, (_, index) => `机会${index + 1}`),
  talkTracks: Array.from({ length: 12 }, (_, index) => `话术${index + 1}`)
};
const patch = normalizeResearchPatch(manyFindings);
check(patch.findings.length === 30, "事实首屏 30 条");
check(patch.opportunities.length === 10 && patch.talkTracks.length === 10, "机会/话术首屏各 10 条");
check(patch.overflow.length === 5 + 2 + 2, "超出的 9 条进入 overflow（不静默丢弃）");
check(patch.overflow.some((line) => line.includes("机会（更多）")), "overflow 标明溢出内容类型");

const skeleton = {
  score: 50, verdict: "", summary: "", scoreReason: "", nextAction: "", crmOnly: true,
  facts: [] as Array<{ label: string; value: string; group?: string }>,
  opportunities: [] as string[], talkTracks: [] as string[],
  risks: [] as Array<{ level: "high" | "medium" | "low"; title: string; detail: string }>,
  sources: [] as Array<{ title: string; url: string; observedAt: string; authority?: string }>
};
const applied = applyResearchEnginePatch(skeleton, manyFindings);
// 30 条首屏事实 + 5 条溢出事实 + 2 条溢出机会 + 2 条溢出话术 = 39，一条都不能少
check(applied.research.facts.length === 39, "首屏事实与 overflow 全部落到背调事实列表（一条不丢）");
check(applied.research.facts.every((fact) => fact.group === "引擎补充"), "引擎补充的条目单独成组，便于界面区分");

const dedupe = applyResearchEnginePatch(skeleton, {
  findings: [{ label: "年营收", value: "约 2 亿欧元" }, { label: "年营收", value: "约 2 亿欧元" }]
});
check(dedupe.research.facts.length === 1, "重复事实按 label+value 去重");

// ── 背调：半条信息也收 ─────────────────────────────────────────────────────
const halfRisk = normalizeResearchPatch({ risks: [{ title: "资金链偏紧" }] });
check(halfRisk.risks.length === 1 && halfRisk.risks[0]!.detail === "",
  "风险点只给了标题也收（以前要求标题+依据同时存在，整条被丢）");
const cnLevel = normalizeResearchPatch({ risks: [{ level: "高", title: "合规风险", detail: "缺认证" }] });
check(cnLevel.risks[0]!.level === "high", "中文风险等级「高」映射为 high");

const urlOnlySource = normalizeResearchPatch({ sources: [{ url: "https://example.com/a" }] });
check(urlOnlySource.sources.length === 1 && urlOnlySource.sources[0]!.title === "https://example.com/a",
  "来源只给链接时用链接当标题");
const badSource = normalizeResearchPatch({ sources: [{ title: "猜的链接", url: "example.com/a" }] });
check(badSource.sources.length === 0, "非法链接不入来源列表（不渲染坏链接）");

// ── 日报：别名 + 溢出告示 ──────────────────────────────────────────────────
const tenderAliased = normalizeTenderReport({
  items: [{ "标题": "Supply of weighing equipment", "链接": "https://procurement.example.go.id/notice/7", "相关性": "80%", "状态": "已授标" }]
}, { engine: "test", completedAt: "2026-10-10T00:00:00Z", reportDate: "2026-10-10" });
check(tenderAliased.tenders.length === 1, "日报条目走别名（标题/链接/相关性/状态）能识别");
check(tenderAliased.tenders[0]!.status === "awarded", "中文状态「已授标」映射为 awarded");
check(tenderAliased.tenders[0]!.relevance === 80, "相关性 \"80%\" 强转为 80");

const bulk = normalizeTenderReport({
  tenders: Array.from({ length: 30 }, (_, index) => ({
    title: `Tender number ${index + 1} for industrial equipment`,
    sourceUrl: `https://procurement.example.go.id/notice/${index + 1}`
  }))
}, { engine: "test", completedAt: "2026-10-10T00:00:00Z", reportDate: "2026-10-10" });
check(bulk.tenders.length === 25, "日报首屏 25 条");
check(bulk.notes.some((note) => note.includes("另有 5 条")),
  "超出的 5 条在 notes 里如实告知（以前静默 slice 掉，用户不知道有这些内容）");

const emptyReport = normalizeTenderReport(null, { engine: "test", completedAt: "2026-10-10T00:00:00Z", reportDate: "2026-10-10" });
check(emptyReport.tenders.length === 0 && emptyReport.reportDate === "2026-10-10",
  "空结果是合法结果（宁空勿假），日期用兜底值");

// ── splitByLimit 边界 ──────────────────────────────────────────────────────
check(splitByLimit([1, 2, 3], 5).overflow.length === 0, "未超上限时无 overflow");
check(splitByLimit([], 3).primary.length === 0, "空数组稳定");

console.log(`\nengine-output-contract-test：${passed} 条断言通过`);
