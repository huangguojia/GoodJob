/**
 * Lfind 结果解析容错测试（2026-11-22）。
 *
 * 现场：第 1 步终于跑通（Prompt 3,063 字符、CLI 跑 165 秒、返回 57KB / 20 家），
 * 却因为 7 家公司的 `searchReport.sourceAuthenticity` 写成 "registry" 整份被 422，
 * 前端只显示「格式不对」，看上去像第一步又崩了。
 *
 * 根因：单个来源的枚举是 official / registry / reputable_directory / search_result / weak，
 * 报告级却是 official_confirmed / multi_source_supported / …。模型很自然把前者搬到后者，
 * z.enum 一遇到不认识的词就抛错，整批数据陪葬。
 *
 * 这个测试锁两件事：
 *   1. 已知的同义写法必须被收敛成契约值，而不是报错；
 *   2. 收敛不能悄悄改变事实 —— registry 归到「官方确认」、目录/搜索归到「单来源」，
 *      取值仍落在契约枚举内。
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { lfindResultSchema } from "./routes/lead-finder.js";

/** 先证明这个测试确实能红：没有别名收敛时，同样的值会被 z.enum 直接判死 */
assert.throws(
  () => z.enum(["official_confirmed", "multi_source_supported", "single_source_supported", "weak", "unknown"]).parse("registry"),
  "严格枚举下 registry 必须报错，否则这条回归测试没有意义"
);

const baseOpportunity = (index: number) => ({
  company: `Thai Food Factory ${index} Co., Ltd.`,
  business: "Food manufacturing",
  country: "Thailand",
  website: `https://factory-${index}.example.co.th`,
  contact: "Purchasing Manager",
  contactInfo: `buyer${index}@factory-${index}.example.co.th`,
  description: "",
  confidence: "85%",
  qualification: "maybe",
  uncertainPoints: [],
  searchReport: {
    summary: "已核验 2 个公开来源",
    sourceAuthenticity: "registry",
    verifiedFields: ["website", "contact"],
    checkedSources: [
      { url: "https://factory-1.example.co.th", title: "Official site", authenticity: "official_website", verifiedFields: ["website"], finding: "" },
      { url: "https://registry.example.go.th/1", title: "Company registry", authenticity: "registry", verifiedFields: ["contact"], finding: "" }
    ],
    contactFinding: { status: "confirmed", value: "buyer@example.co.th", sourceUrl: "https://registry.example.go.th/1" },
    nextAction: "复核后加入清单"
  },
  sources: []
});

const result = lfindResultSchema.parse({
  version: "1.0",
  summary: { target: "Thailand food factories", markets: ["Thailand"], products: [], customerType: "", rawFound: "20", accepted: "20", skipped: 5, noResultReason: "" },
  opportunities: Array.from({ length: 20 }, (_, index) => baseOpportunity(index)),
  skipped: 5,
  failures: []
});

// 1) 整批 20 家必须完整保住，不能因为一个标签少一条
assert.equal(result.opportunities.length, 20, "有公司被解析丢了");
assert.equal(result.opportunities[19].company, "Thai Food Factory 19 Co., Ltd.");

// 2) 报告级 registry → official_confirmed（企业登记库属于权威来源）
const report = result.opportunities[0].searchReport!;
assert.equal(report.sourceAuthenticity, "official_confirmed", "报告级 registry 没有被收敛成 official_confirmed");

// 3) 单个来源的别名：official_website → official，registry 保持 registry
assert.equal(report.checkedSources[0].authenticity, "official", "official_website 没有被收敛成 official");
assert.equal(report.checkedSources[1].authenticity, "registry", "registry 被改写了");

// 4) 联系方式状态 confirmed → source_confirmed
assert.equal(report.contactFinding.status, "source_confirmed", "confirmed 没有被收敛成 source_confirmed");

// 5) 数字容错："85%" → 85，"20" → 20
assert.equal(result.opportunities[0].confidence, 85, "confidence 没有从 85% 解析出 85");
assert.equal(result.summary.rawFound, 20, "summary.rawFound 没有从字符串 20 解析出数字");

// 6) 资格判断的未知值不许抛错：落到 review_needed
assert.equal(result.opportunities[0].qualification, "review_needed", "未知 qualification 没有回落到 review_needed");

// 7) 版本号写成 1.0 也按同一份契约解析
assert.equal(result.version, "goodjob-lfind-v1", "version 没有被归一");

// 8) 报告级来源所有已知写法都要能过关
const overall = [
  ["official", "official_confirmed"],
  ["registry", "official_confirmed"],
  ["multi_source", "multi_source_supported"],
  ["multiple_sources", "multi_source_supported"],
  ["reputable_directory", "single_source_supported"],
  ["search_result", "single_source_supported"],
  ["weak", "weak"],
  ["something_new", "unknown"]
] as const;
for (const [input, expected] of overall) {
  const parsed = lfindResultSchema.parse({
    opportunities: [{ company: "X Co., Ltd.", searchReport: { sourceAuthenticity: input } }]
  });
  assert.equal(parsed.opportunities[0].searchReport!.sourceAuthenticity, expected, `sourceAuthenticity=${input} 应归一为 ${expected}`);
}

console.log("lfind-result-schema-test passed (20 opportunities kept, alias normalization verified)");
