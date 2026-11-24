/**
 * 入池逐项状态回归测试（2026-11-22）。
 *
 * 背景：获客的查重已从 CLI 提示词移回后端，因此后端必须能逐项区分：
 *   - 本轮真正新增的候选
 *   - 已有候选但本轮补到了新证据（值得刷新报告）
 *   - 已有候选且毫无变化（不该再送进背调/写信）
 * 以前 persistProviderOpportunities 只返回整份列表 + 汇总计数，调用方无法区分，
 * 于是历史候选会被当成本轮候选重复处理。这里锁住三个 id 集合的行为。
 */
import assert from "node:assert/strict";
import { getStore } from "./store.js";
import { persistProviderOpportunities } from "./server-core.js";
import type { ProviderEvidenceSnapshot, WebsiteOpportunity } from "./types.js";

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

/** 完整证据快照：withProspectVerificationReport 会读 matchedFields 等字段 */
function evidence(providerRecordId: string): ProviderEvidenceSnapshot {
  return {
    providerId: "cli",
    providerRecordId,
    officialWebsite: "https://kansai.co.th",
    sourceUrl: "https://kansai.co.th/about",
    recordType: "company",
    fetchedAt: new Date().toISOString(),
    payloadHash: `hash_${providerRecordId}`,
    evidenceSummary: "public company profile",
    matchedFields: ["company", "website"],
    adapterVersion: "1.0",
    catalogPolicyVersion: "1.0",
    sourceLevel: "public_web",
    retentionPolicyRef: "default"
  };
}

function candidate(overrides: Partial<WebsiteOpportunity> = {}): WebsiteOpportunity {
  return {
    id: `cand_${Math.random().toString(36).slice(2, 10)}`,
    company: "Kansai Paint (Thailand) Co., Ltd.",
    business: "paint manufacturing",
    country: "Thailand",
    website: "https://kansai.co.th",
    contact: "Sales Department",
    contactInfo: "sales@kansai.co.th",
    description: "Automotive coatings manufacturer",
    ownerId: "u_ingest_owner",
    teamId: "t_ingest_team",
    status: "preview",
    createdAt: new Date().toISOString(),
    ...overrides
  } as WebsiteOpportunity;
}

const store = getStore();
const stats = { rawCount: 1, deduplicatedCount: 0 };

// ── 1. 全新公司 → newIds ──
const first = candidate({ id: "opp_first" });
const run1 = persistProviderOpportunities([first], stats);
check(run1.newIds.has("opp_first"), "首次上报计入 newIds");
check(!run1.unchangedIds.has("opp_first"), "首次上报不在 unchangedIds");
check(run1.incrementalStats.newCount === 1, "newCount = 1");

// ── 2. 同一公司、字段完全相同再报一次 → unchangedIds ──
const duplicate = candidate({ id: "opp_duplicate" });
const run2 = persistProviderOpportunities([duplicate], stats);
check(!run2.newIds.has("opp_duplicate"), "重复公司不计入 newIds");
check(run2.unchangedIds.has("opp_first"), "重复公司落入 unchangedIds（不会再进背调/写信）");
check(run2.incrementalStats.newCount === 0, "重复不计新增");
check(run2.incrementalStats.unchangedCount === 1, "unchangedCount = 1");
check(store.websiteOpportunities.filter((item) => item.id === "opp_duplicate").length === 0,
  "重复公司没有被写入独立行");

// ── 3. 同一公司补到新来源证据 → changedIds，而不是 unchanged ──
const evidential = candidate({
  id: "opp_evidential",
  sourceEvidence: [evidence("rec_1")]
});
const run3 = persistProviderOpportunities([evidential], stats);
check(!run3.newIds.has("opp_evidential"), "补证据不新增行");
check(run3.changedIds.has("opp_first"), "补到新证据落入 changedIds（值得刷新报告）");
check(!run3.unchangedIds.has("opp_first"), "补到新证据不再算 unchanged");
check(run3.incrementalStats.evidenceUpdatedCount === 1, "evidenceUpdatedCount = 1");

// ── 4. 不同公司 → 新行 ──
const other = candidate({
  id: "opp_other",
  company: "TOA Paint (Thailand) Public Co., Ltd.",
  website: "https://toapaint.co.th",
  contactInfo: "info@toapaint.co.th"
});
const run4 = persistProviderOpportunities([other], stats);
check(run4.newIds.has("opp_other"), "不同公司计入 newIds");
check(run4.incrementalStats.newCount === 1, "不同公司 newCount = 1");

// ── 5. 一次混合批次：新增 + 重复 + 补证据，三个集合互斥且完整 ──
const batch = persistProviderOpportunities([
  candidate({ id: "mix_new", company: "Jotun Paints (Thailand)", website: "https://jotun.co.th" }),
  candidate({ id: "mix_dup" }), // 与 opp_first 同域名同国家
  candidate({
    id: "mix_evi",
    sourceEvidence: [evidence("rec_2")]
  })
], stats);
check(batch.newIds.size === 1 && batch.newIds.has("mix_new"), "混合批次：只有新公司进 newIds");
check(batch.unchangedIds.has("opp_first") || batch.changedIds.has("opp_first"),
  "混合批次：老公司落在 unchanged 或 changed，不会进 newIds");
check(batch.newIds.size + batch.changedIds.size + batch.unchangedIds.size === 3,
  "混合批次：三个集合合计等于命中的已有/新增项数");

console.log(`lead-finder-ingest-test: ${passed} assertions passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
