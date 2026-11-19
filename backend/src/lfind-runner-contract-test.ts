import { readdirSync, readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

// server.ts 已按业务拆分为 server.ts（入口）+ server-core.ts（共享内核）+ routes/*.ts（各业务路由），
// 契约检查覆盖全部后端 HTTP 源码。
const serverSourceFiles = [
  "./server.ts",
  "./server-core.ts",
  ...readdirSync(new URL("./routes/", import.meta.url)).filter((name) => name.endsWith(".ts")).sort().map((name) => `./routes/${name}`)
];
const server = serverSourceFiles.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

assert.match(server, /const lfindResultSchema = z\.object/, "Lfind result schema must be validated before sync");
// CLI 经常把 summary.skipped 写成数字（顶层 skipped 也照抄）。以前严格要求数组 → 422 把整份结果判死，
// 自动流每次重试都失败、永远停在几%（2026-11-09 事故）。必须容忍数字并合成占位条目。
assert.match(server, /skipped: z\.preprocess\(/, "Lfind skipped must tolerate a numeric count from the CLI instead of 422-ing the whole result");
assert.match(server, /Use \$lfind\./, "Runner prompt must explicitly invoke the Lfind skill");
assert.match(server, /\/api\/lead-finder\/lfind-tasks/, "Backend must expose Lfind task launch and status endpoints");
assert.match(server, /filterExistingCrmOpportunities\(rawOpportunities, store, user\.teamId\)/, "Lfind results must be filtered against existing CRM records");
assert.match(server, /persistProviderOpportunities\(existingFilter\.opportunities/, "Lfind results must enter the normal prospect persistence path");
assert.match(server, /scheduleContactEnrichment\(user, candidateId, runId\)/, "Lfind candidates must continue through contact enrichment");
assert.match(server, /lfindSearchReportSchema/, "Lfind must accept row-level search reports for CRM display");
assert.match(server, /lfindOpportunityHasSourceBackedContact/, "Lfind sync must reject candidates without source-backed contacts");
assert.match(server, /reason: "no_contact"/, "Lfind contactless candidates must be returned with a concrete filter reason");

console.log(JSON.stringify({ ok: true, checked: "lfind-runner-contract" }, null, 2));
