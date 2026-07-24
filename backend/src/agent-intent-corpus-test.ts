import assert from "node:assert/strict";
import { GJAB_INTENT_CORPUS, runAgentIntentCorpusBenchmark } from "./agent-intent-corpus.js";

const result = runAgentIntentCorpusBenchmark();
assert.ok(GJAB_INTENT_CORPUS.length >= 120, `语料不足：${GJAB_INTENT_CORPUS.length}`);
assert.equal(result.passed, result.total, JSON.stringify(result.failures, null, 2));

console.log(JSON.stringify({
  ok: true,
  total: result.total,
  passed: result.passed,
  failures: result.failures.length
}, null, 2));
