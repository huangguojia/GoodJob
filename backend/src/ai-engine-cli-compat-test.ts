import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AI_ENGINE_CODEX_MODEL_DEFAULT,
  defaultTeamAiEngineSettings,
  engineCliProfile,
  otherAiEngineAdapter,
  sanitizeTeamAiEngineSettings
} from "./ai-engine-settings.js";
import { applyCliProfileToPrompt, chooseEngineRunner, classifyEngineCliIssue } from "./ai-engine-service.js";
import {
  adaptEngineCliPromptForAdapter,
  buildAcquisitionCliPrompt,
  buildTenderDailyCliPrompt
} from "./ai-engine-prompts.js";
import { parseCodexStream, resolveDirectCliAdapter, runCliSummary } from "./cli-ai.js";
import type { SessionUser } from "./types.js";

// WorkBuddy CLI 与 Codex CLI 兼容（2026-11-05）：团队统一选一个；只配了一个就自动用它；
// Codex 默认模型 gpt-5.6-sol；提示词与故障话术不再带 WorkBuddy 专属写法。

// ---- 1. 设置：Codex 模型单独存，老数据自动补默认
{
  const defaults = defaultTeamAiEngineSettings("t1");
  assert.equal(defaults.codexModel, "gpt-5.6-sol");
  assert.equal(AI_ENGINE_CODEX_MODEL_DEFAULT, "gpt-5.6-sol");
  // 老数据：没有 codexModel / codexEffort 字段
  const legacy = sanitizeTeamAiEngineSettings("t1", { cliAdapter: "codex", cliModel: "deep-model" } as never, defaults);
  assert.equal(legacy.codexModel, "gpt-5.6-sol", "老数据读出时补上 Codex 出厂默认");
  assert.equal(legacy.cliModel, "deep-model");
  const custom = sanitizeTeamAiEngineSettings("t1", { codexModel: "gpt-6.0-preview", codexEffort: "HIGH" } as never, defaults);
  assert.equal(custom.codexModel, "gpt-6.0-preview", "Codex 模型名随版本变化，安全字符内的自定义名可以保存");
  assert.equal(custom.codexEffort, "high");
  const bad = sanitizeTeamAiEngineSettings("t1", { codexModel: "x; rm -rf /", codexEffort: "max" } as never, custom);
  assert.equal(bad.codexModel, "gpt-6.0-preview", "非法模型名回落到上一次的值");
  assert.equal(bad.codexEffort, "high", "Codex 不支持的档位回落");
  assert.equal(sanitizeTeamAiEngineSettings("t1", { codexModel: "" } as never, custom).codexModel, "", "空串 = 跟随本机 Codex 配置");
}

// ---- 2. 模型 / 档位按实际派给的 CLI 取，互不串用
{
  const settings = { ...defaultTeamAiEngineSettings("t1"), cliModel: "deepseek-v4.1-flash", cliEffort: "xhigh", codexModel: "gpt-5.6-sol", codexEffort: "medium" };
  assert.deepEqual(engineCliProfile(settings, "workbuddy"), { model: "deepseek-v4.1-flash", effort: "xhigh" });
  assert.deepEqual(engineCliProfile(settings, "codex"), { model: "gpt-5.6-sol", effort: "medium" });
  assert.equal(otherAiEngineAdapter("codex"), "workbuddy");
  const marked = applyCliProfileToPrompt("正文", engineCliProfile(settings, "codex"));
  assert.ok(marked.startsWith('[[gj-cli-options {"model":"gpt-5.6-sol","effort":"medium"}]]'), "Codex 任务也带执行档位标记（Runner 会翻译成 -m / reasoning effort）");
}

// ---- 3. 选机器 + 选 CLI：首选不可用时自动改用另一个
{
  const actor = { id: "u1", teamId: "t1" } as SessionUser;
  const runner = (id: string, capabilities: string[], online = true) => ({
    id, ownerId: "u1", displayName: id, online, capabilities, workspaces: ["/work"],
    workbuddyVersion: capabilities.includes("workbuddy") ? "wb 1.0" : "", codexVersion: capabilities.includes("codex") ? "codex 1.0" : "", lastError: ""
  });
  const base = defaultTeamAiEngineSettings("t1");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy", "codex"])], actor, { ...base, cliAdapter: "codex" }).adapter, "codex", "两个都配了：按团队选择");
  assert.equal(chooseEngineRunner([runner("r1", ["workbuddy", "codex"])], actor, { ...base, cliAdapter: "workbuddy" }).adapter, "workbuddy");
  const onlyWb = chooseEngineRunner([runner("r1", ["workbuddy"])], actor, { ...base, cliAdapter: "codex" });
  assert.equal(onlyWb.adapter, "workbuddy", "只配了 WorkBuddy：选了 Codex 也自动用 WorkBuddy");
  assert.equal(onlyWb.cliVersion, "wb 1.0");
  assert.equal(chooseEngineRunner([runner("r1", ["codex"])], actor, { ...base, cliAdapter: "workbuddy" }).adapter, "codex", "只配了 Codex：自动用 Codex");
  // 首选 CLI 在另一台机器上：优先换机器保持首选，而不是在第一台上改用另一个 CLI
  const prefersMachine = chooseEngineRunner([runner("r1", ["workbuddy"]), runner("r2", ["codex"])], actor, { ...base, cliAdapter: "codex" });
  assert.deepEqual([prefersMachine.runnerId, prefersMachine.adapter], ["r2", "codex"]);
  // 指定 Runner：只在那台上找，那台只有另一个 CLI 就用另一个
  const pinned = chooseEngineRunner([runner("r1", ["workbuddy"]), runner("r2", ["codex"])], actor, { ...base, cliAdapter: "codex", runnerId: "r1" });
  assert.deepEqual([pinned.runnerId, pinned.adapter], ["r1", "workbuddy"], "指定的 Runner 不静默换机器");
  assert.throws(() => chooseEngineRunner([runner("r1", [])], actor, base), (error: unknown) => (error as { code?: string }).code === "AI_ENGINE_CLI_MISSING");
  assert.throws(() => chooseEngineRunner([runner("r1", ["codex"], false)], actor, base), (error: unknown) => (error as { code?: string }).code === "AI_ENGINE_RUNNER_MISSING");
}

// ---- 4. 提示词：Codex 版不再要求 Skill 工具 / WebFetch，改为读取同一份技能包文件
{
  const tender = buildTenderDailyCliPrompt({ reportDate: "2026-11-05", companyName: "GoodJob", productSummary: "water pumps", regions: "Asia", focusNote: "" });
  assert.equal(adaptEngineCliPromptForAdapter(tender, "workbuddy"), tender, "WorkBuddy 提示词原样不变");
  const codexTender = adaptEngineCliPromptForAdapter(tender, "codex");
  assert.ok(!/Skill tool|WebFetch/u.test(codexTender), "Codex 版不含 WorkBuddy 专属工具名");
  assert.ok(codexTender.includes(".workbuddy/skills/goodjob-tender-daily/SKILL.md"));
  assert.ok(codexTender.includes("read-only sandbox"));
  const acquisition = adaptEngineCliPromptForAdapter(buildAcquisitionCliPrompt({ goal: "pump distributors", productKeywords: "", countries: "", industry: "", customerType: "", excludeKeywords: "", limit: 5 }), "codex");
  assert.ok(acquisition.includes(".workbuddy/skills/goodjob-lead-acquisition/SKILL.md") && !acquisition.includes("Skill tool"));
}

// ---- 5. 故障话术按 CLI 区分
{
  assert.match(classifyEngineCliIssue("Authentication required", "codex").command, /codex login/u);
  assert.doesNotMatch(classifyEngineCliIssue("Authentication required", "codex").command, /codebuddy/u);
  assert.match(classifyEngineCliIssue("Authentication required").command, /codebuddy/u, "默认（WorkBuddy）话术不变");
  assert.equal(classifyEngineCliIssue("model gpt-x not supported", "codex").title, "Codex CLI 不认识所选模型");
}

// ---- 6. 后端直连通道：Codex 事件流解析、CLI 自动选择、真实子进程调用
{
  const parsed = parseCodexStream([
    JSON.stringify({ type: "thread.started", thread_id: "th1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "草稿一" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "最终答案" } }),
    JSON.stringify({ type: "turn.completed" })
  ]);
  assert.deepEqual([parsed.text, parsed.failed], ["最终答案", false]);
  const failedStream = parseCodexStream([JSON.stringify({ type: "turn.failed", error: { message: "model not found" } })]);
  assert.deepEqual([failedStream.failed, failedStream.error], [true, "model not found"]);

  assert.equal(resolveDirectCliAdapter("codex", (adapter) => adapter === "workbuddy"), "workbuddy", "首选没装就用另一个");
  assert.equal(resolveDirectCliAdapter("workbuddy", (adapter) => adapter === "codex"), "codex");
  assert.equal(resolveDirectCliAdapter("codex", () => true), "codex");
  assert.equal(resolveDirectCliAdapter("codex", () => false), "codex", "都没装按首选，随后如实报错");

  const dir = mkdtempSync(path.join(tmpdir(), "fake-codex-"));
  const invocation = path.join(dir, "invocation.json");
  const fake = path.join(dir, "codex");
  writeFileSync(fake, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  if (prompt.includes("FAIL")) { console.log(JSON.stringify({ type: "turn.failed", error: { message: "Authentication required" } })); return; }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "th" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\\"ok\\":true}" } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
});
`);
  chmodSync(fake, 0o755);
  const result = await runCliSummary("总结一下", { adapter: "codex", binary: fake, timeoutMs: 15_000 });
  assert.equal(result.text, '{"ok":true}');
  const call = JSON.parse(readFileSync(invocation, "utf8")) as { argv: string[]; prompt: string };
  assert.equal(call.prompt, "总结一下", "提示词走 stdin");
  const execAt = call.argv.indexOf("exec");
  assert.ok(execAt >= 0 && call.argv.includes("--json") && call.argv.at(-1) === "-");
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--sandbox"), call.argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"], "直连 Codex 只读执行");
  assert.ok(call.argv.indexOf('model_reasoning_effort="low"') < execAt, "总结类任务默认 low 档位");
  await assert.rejects(runCliSummary("FAIL", { adapter: "codex", binary: fake, timeoutMs: 15_000 }), /Authentication required/u);
  await assert.rejects(runCliSummary("x", { adapter: "codex", binary: path.join(dir, "missing-codex"), timeoutMs: 15_000 }), /Codex CLI 不存在/u);
}

console.log(JSON.stringify({ ok: true, checked: "ai-engine-cli-compat" }, null, 2));
