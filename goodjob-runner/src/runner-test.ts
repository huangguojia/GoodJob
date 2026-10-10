import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserServiceConfiguration, isBrowserCdpReady, isBrowserMcpReady, isBrowserServiceReachable, startBrowserService, tryStartBrowserService } from "./browser-service.js";
import { codexCodeModeHost, executeCodexTask, resolveCodexBinary } from "./codex-adapter.js";
import { execFileSync } from "node:child_process";
import { executeWorkbuddyTask, parseWorkbuddyCliProfile, resolveWorkbuddyBinary, workbuddyProcessEnvironment, workbuddySkillDirs, STRIPPED_ENVIRONMENT_PREFIXES } from "./workbuddy-adapter.js";
import { cachedRunnerIdentity, cliDetectionSnapshot, detectRunnerClis, resetRunnerCliCache, runnerCliIssue, runnerIdentity } from "./runner.js";

const root = await mkdtemp(path.join(tmpdir(), "goodjob-runner-test-"));
const fakeCodex = path.join(root, "fake-codex.mjs");
const lingeringCodex = path.join(root, "lingering-codex.mjs");
const invocationFile = path.join(root, "codex-invocation.json");
await writeFile(path.join(root, "codex-code-mode-host"), "", { mode: 0o700 });
// CLI 技能目录注入（2026-10-10 回归）：技能包放在 .workbuddy/skills，CLI 自己不扫这个目录，
// 必须由 Runner 通过 CODEBUDDY_SESSION_SKILL_DIRS 显式喂给子进程，否则技能等于不存在。
await mkdir(path.join(root, ".workbuddy", "skills", "goodjob-probe"), { recursive: true });
await writeFile(
  path.join(root, ".workbuddy", "skills", "goodjob-probe", "SKILL.md"),
  "---\nname: goodjob-probe\ndescription: runner test probe\n---\nprobe body\n"
);
await writeFile(fakeCodex, `
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => { prompt += chunk.toString("utf8"); });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  console.log(JSON.stringify({type:"thread.started",thread_id:"thread_test"}));
  console.log(JSON.stringify({type:"turn.started"}));
  console.log(JSON.stringify({type:"item.completed",item:{id:"msg_1",type:"agent_message",text:"正在检查运行环境"}}));
  console.log(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"printf test"}}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution",aggregated_output:"test",exit_code:0}}));
  console.log(JSON.stringify({type:"item.started",item:{id:"browser_1",type:"mcp_tool_call",server:"goodjob_browser",tool:"browser_navigate",arguments:{title:"打开 Google 搜索"}}}));
  console.log(JSON.stringify({type:"item.completed",item:{id:"browser_1",type:"mcp_tool_call",server:"goodjob_browser",tool:"browser_navigate",arguments:{title:"打开 Google 搜索"},status:"completed"}}));
  console.log(JSON.stringify({type:"item.completed",item:{id:"reason_1",type:"reasoning",text:"已验证命令与浏览器步骤"}}));
  console.log(JSON.stringify({type:"item.completed",item:{id:"msg_2",type:"agent_message",text:"Runner closed loop works"}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:5}}));
});
`, { mode: 0o700 });
await chmod(fakeCodex, 0o700);
await writeFile(lingeringCodex, `
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({type:"thread.started",thread_id:"thread_lingering"}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Lingering result"}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
  setTimeout(() => process.exit(0), 10_000);
});
`, { mode: 0o700 });
await chmod(lingeringCodex, 0o700);

const events: Array<{ message: string; eventType: string; stage: unknown }> = [];
const result = await executeCodexTask({
  id: "task_test", runnerId: "runner_test", adapter: "codex", prompt: "test",
  workspace: root, executionMode: "read_only", timeoutSeconds: 30, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal,
  codexBinary: process.execPath, codexArgumentPrefix: [fakeCodex],
  browserMcpUrl: "http://127.0.0.1:8931/mcp",
  async onEvent(event) { events.push({ message: event.message, eventType: event.eventType, stage: event.payload?.stage }); }
});

assert.equal(result.status, "succeeded");
assert.equal(result.resultText, "Runner closed loop works");
assert.equal(result.codexThreadId, "thread_test");
assert.ok(events.some((item) => item.message.includes("正在执行") && item.stage === "command"));
assert.ok(events.some((item) => item.message.includes("test") && item.stage === "command"));
assert.ok(events.some((item) => item.message.includes("打开 Google 搜索") && item.stage === "browser"));
assert.ok(events.some((item) => item.message.includes("已验证命令与浏览器步骤") && item.stage === "analysis"));
assert.ok(events.some((item) => item.message.includes("输入 10 / 输出 5 tokens") && item.stage === "usage"));
assert.ok(events.some((item) => item.message === "Runner closed loop works" && item.eventType === "output"));
const invocation = JSON.parse(await readFile(invocationFile, "utf8")) as { argv: string[]; prompt: string };
assert.ok(invocation.argv.includes('mcp_servers.goodjob_browser.url="http://127.0.0.1:8931/mcp"'));
assert.ok(invocation.argv.includes("--approve-for-me"));
assert.ok(invocation.prompt.includes("必须使用 goodjob_browser"));
assert.ok(invocation.prompt.endsWith("用户任务：\ntest"));
assert.equal(resolveCodexBinary(fakeCodex), fakeCodex);
if (process.platform === "darwin") {
  const resolved = resolveCodexBinary("/opt/homebrew/bin/codex");
  // 本机 codex 版本可能不带 codex-code-mode-host（2026-10-10 实测 0.144.0 就没有）。
  // 这种环境缺口不该把整个套件卡死在这里：CRM 的 CLI 任务走 WorkBuddy 适配器，
  // 下面那些 WorkBuddy 断言与 codex 无关。装齐了的机器上这条断言仍然照常执行。
  if (existsSync(resolved) && !codexCodeModeHost(resolved)) {
    console.warn(`[runner-test] 跳过 Codex code-mode-host 断言：${resolved} 所在安装未提供 codex-code-mode-host（本机 codex 版本差异，不影响 WorkBuddy CLI 任务）`);
  } else {
    assert.ok(codexCodeModeHost(resolved), `Codex 工具宿主缺失：${resolved}`);
  }
}

const lingerStartedAt = Date.now();
const lingeringResult = await executeCodexTask({
  id: "task_lingering", runnerId: "runner_test", adapter: "codex", prompt: "test",
  workspace: root, executionMode: "read_only", timeoutSeconds: 30, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal,
  codexBinary: process.execPath, codexArgumentPrefix: [lingeringCodex],
  async onEvent() {}
});
assert.equal(lingeringResult.status, "succeeded");
assert.equal(lingeringResult.resultText, "Lingering result");
assert.ok(Date.now() - lingerStartedAt < 4_000, "turn.completed 后不应等待 CLI 后台清理");

// —— WorkBuddy CLI 适配器 ——
const workbuddyInvocationFile = path.join(root, "workbuddy-invocation.json");
const fakeCodebuddy = path.join(root, "fake-codebuddy.mjs");
const failingCodebuddy = path.join(root, "failing-codebuddy.mjs");
await writeFile(fakeCodebuddy, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => { prompt += chunk.toString("utf8"); });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(workbuddyInvocationFile)}, JSON.stringify({
    argv: process.argv.slice(2),
    prompt,
    nodeOptions: process.env.NODE_OPTIONS || "",
    idePort: process.env.CODEBUDDY_IDE_PORT || "",
    serviceProxy: process.env.CODEBUDDY_SERVICE_PROXY_URL || "",
    mcpConfig: process.env.CODEBUDDY_MCP_CONFIG || "",
    skillDirs: process.env.CODEBUDDY_SESSION_SKILL_DIRS || ""
  }));
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "wb_session_1", model: "deepseek-v4.1-flash" }));
  console.log(JSON.stringify({ type: "assistant", session_id: "wb_session_1", message: { content: [
    { type: "text", text: "正在检查项目结构" },
    { type: "tool_use", name: "Bash", input: { command: "ls -la" } }
  ] } }));
  console.log(JSON.stringify({ type: "assistant", session_id: "wb_session_1", message: { content: [
    { type: "text", text: "WorkBuddy 已接通" }
  ] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "wb_session_1", result: "WorkBuddy 已接通" }));
});
`, { mode: 0o700 });
await chmod(fakeCodebuddy, 0o700);
await writeFile(failingCodebuddy, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "wb_session_fail", error: "模型额度不足" }));
});
`, { mode: 0o700 });
await chmod(failingCodebuddy, 0o700);

// 子进程环境必须剔除会污染 CLI 的变量，且不得反向修改父进程环境
// ⚠️ SERVER__HOST / SERVER__PORT 是实测根因：带上它们时 CLI 不会走云端，而是去连桌面端宿主网关，
//    `--print` 非交互任务 0 输出永久挂起（最坏等到 24 小时任务超时）。
const HOST_SESSION_ENVIRONMENT: Record<string, string> = {
  NODE_OPTIONS: "--max-old-space-size=4096",
  CODEBUDDY_IDE_PORT: "63694",
  CODEBUDDY_SERVICE_PROXY_URL: "http://127.0.0.1:63694/internal/hooks/services/invoke",
  CODEBUDDY_MCP_CONFIG: '{"mcpServers":{"connector-proxy":{"type":"http","url":"http://127.0.0.1:63043/mcp"}}}',
  CODEBUDDY_SESSION_ID: "cd04b00f-99d9-446e-b61a-d1dd29984956",
  CODEBUDDY_ROOT_REQUEST_ID: "root_request_test",
  SERVER__HOST: "127.0.0.1",
  SERVER__PORT: "63694",
  CODEBUDDY_HOST: "workbuddy-desktop",
  CODEBUDDY_GATEWAY_AUTH: "password",
  CODEBUDDY_GATEWAY_PASSWORD: "gateway_password_test",
  CODEBUDDY_API_KEY_HELPER_DISABLED: "1",
  CODEBUDDY_INTERNET_ENVIRONMENT: "internal",
  ELECTRON_RUN_AS_NODE: "1",
  CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
  CODEBUDDY_ARTIFACTS: "/tmp/host-artifacts.jsonl",
  BASH_ENV: "/tmp/host-shell-env.sh",
  CLIENT_INFO_PLATFORM: "darwin",
  // 宿主注入的 CLI 凭据目录：指向桌面端集成登录态（~/.workbuddy），
  // 独立版 CLI 的登录凭据在 ~/.codebuddy，必须剥掉（2026-10-06 Authentication required 实锤）
  CODEBUDDY_CONFIG_DIR: "/tmp/host-workbuddy-config",
  // 桌面端 PAC 代理 RPC：socket 随桌面会话存亡，桌面重启后旧值必死
  // （2026-10-06 实锤：400 connect ENOENT workbuddy-pac-82669-*.sock）
  WORKBUDDY_PAC_RPC_SOCKET: "/tmp/workbuddy-pac-99999-deadbeef.sock",
  WORKBUDDY_PAC_RPC_TOKEN: "pac_token_test"
};
const ENV_PROBE_KEYS = Object.keys(HOST_SESSION_ENVIRONMENT);
// 宿主环境变量要原样还原：CODEBUDDY_SESSION_ID 之类是宿主自身必需的，直接 delete 会弄坏宿主
const savedEnvironment = Object.fromEntries(ENV_PROBE_KEYS.map((key) => [key, process.env[key]]));
Object.assign(process.env, HOST_SESSION_ENVIRONMENT);
const isolatedEnv = workbuddyProcessEnvironment();
for (const key of ENV_PROBE_KEYS) {
  assert.equal(isolatedEnv[key], undefined, `${key} 必须从 CLI 子进程环境剔除`);
}
// 前缀族（安全删除代理 / 沙箱 broker / 宿主客户端指纹）会驱动宿主自身的 shim，
// 不能在父进程里伪造取值（改了会把测试进程自己的 broker 端点打歪），只断言宿主真实注入的那些。
const hostPrefixKeys = Object.keys(process.env).filter((key) =>
  STRIPPED_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)));
for (const key of hostPrefixKeys) {
  assert.equal(isolatedEnv[key], undefined, `${key} 属于宿主会话工具链前缀族，必须剔除`);
}
assert.equal(process.env.CODEBUDDY_IDE_PORT, "63694", "不得修改父进程环境");
assert.equal(process.env.CODEBUDDY_MCP_CONFIG?.includes("connector-proxy"), true, "不得修改父进程环境");
// 反向守卫：剔除不能过头，CLI 启动必需的基础变量必须原样保留
for (const key of ["HOME", "PATH", "USER", "SHELL", "TMPDIR", "WORKBUDDY_CONFIG_DIR"]) {
  if (process.env[key] !== undefined) {
    assert.equal(isolatedEnv[key], process.env[key], `${key} 是 CLI 启动必需项，不得剔除`);
  }
}

// 本机会话代理：桌面端重启后端口即失效，必须从 CLI 子进程环境剥掉（远程代理保留）
const SAVED_PROXY_ENVIRONMENT: Record<string, string | undefined> = {
  HTTP_PROXY: "http://127.0.0.1:63719",
  HTTPS_PROXY: "http://127.0.0.1:63719",
  http_proxy: "http://127.0.0.1:63719",
  https_proxy: "http://127.0.0.1:63719",
  ALL_PROXY: "http://10.20.30.40:8080",
  NO_PROXY: process.env.NO_PROXY
};
const savedProxyValues = Object.fromEntries(Object.keys(SAVED_PROXY_ENVIRONMENT).map((key) => [key, process.env[key]]));
Object.assign(process.env, SAVED_PROXY_ENVIRONMENT);
const proxyIsolatedEnv = workbuddyProcessEnvironment();
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
  assert.equal(proxyIsolatedEnv[key], undefined, `本机代理 ${key} 必须从 CLI 子进程环境剔除`);
}
assert.equal(proxyIsolatedEnv.ALL_PROXY, "http://10.20.30.40:8080", "远程代理不是会话级产物，必须保留");
for (const [key, value] of Object.entries(savedProxyValues)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const workbuddyEvents: Array<{ message: string; eventType: string; stage: unknown }> = [];
const workbuddyResult = await executeWorkbuddyTask({
  id: "task_workbuddy", runnerId: "runner_test", adapter: "workbuddy", prompt: "test",
  workspace: root, executionMode: "read_only", timeoutSeconds: 60, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal, workbuddyBinary: fakeCodebuddy,
  async onEvent(event) { workbuddyEvents.push({ message: event.message, eventType: event.eventType, stage: event.payload?.stage }); }
});
assert.equal(workbuddyResult.status, "succeeded");
assert.equal(workbuddyResult.resultText, "WorkBuddy 已接通");
assert.equal(workbuddyResult.codexThreadId, "wb_session_1");
assert.equal(workbuddyResult.outputTruncated, false);
assert.ok(workbuddyEvents.some((item) => item.message.includes("Bash") && item.stage === "command"), "工具调用必须转成进度事件");
assert.ok(workbuddyEvents.some((item) => item.message === "WorkBuddy 已接通" && item.eventType === "output"));
assert.ok(workbuddyEvents.some((item) => item.message.includes("会话已建立")), "system 事件必须转成会话状态");
// CLI 自报的模型必须落到事件里：提示词里的 model 标记只证明「我们要了什么」，
// 只有这条能证明「CLI 真的用了什么」——排查「系统里配的模型没生效」时全靠它。
assert.ok(
  workbuddyEvents.some((item) => item.message.includes("实际使用模型：deepseek-v4.1-flash")),
  "必须把 CLI 自报的模型记进会话事件"
);
const workbuddyInvocation = JSON.parse(await readFile(workbuddyInvocationFile, "utf8")) as {
  argv: string[]; prompt: string; nodeOptions: string; idePort: string; serviceProxy: string; mcpConfig: string; skillDirs: string;
};
assert.deepEqual(workbuddyInvocation.argv, [
  "--print", "--output-format", "stream-json", "--no-session-persistence", "--permission-mode", "plan"
]);
assert.equal(workbuddyInvocation.prompt, "test", "任务内容必须通过 stdin 传入");
assert.equal(workbuddyInvocation.nodeOptions, "", "NODE_OPTIONS 不得泄漏到 CLI 子进程");
assert.equal(workbuddyInvocation.idePort, "", "CODEBUDDY_IDE_PORT 不得泄漏到 CLI 子进程");
assert.equal(workbuddyInvocation.serviceProxy, "", "不得把宿主会话的服务代理带给 CLI（会让 CLI 挂起）");
assert.equal(workbuddyInvocation.mcpConfig, "", "不得把宿主会话级 MCP 配置（含 Bearer 凭据）带给 CLI");
// 技能目录注入（2026-10-10 回归）：CLI 只扫 <cwd>/.codebuddy/skills 与 ~/.codebuddy/skills，
// 不认桌面版的 .workbuddy/skills。少了这一条，四个 goodjob 技能包在真实任务里从不生效，
// 且「技能没起作用」这种故障没有任何报错——只能靠这条断言兜住。
assert.ok(
  workbuddyInvocation.skillDirs.endsWith(`${path.sep}.workbuddy${path.sep}skills`),
  `必须把仓库技能目录注入 CLI 子进程，实际拿到 "${workbuddyInvocation.skillDirs}"`
);
assert.equal(workbuddySkillDirs(root), path.join(root, ".workbuddy", "skills"), "默认取 <workspace>/.workbuddy/skills");
assert.equal(workbuddySkillDirs(path.join(root, "no-skills-here")), "", "技能目录不存在时不得注入空路径");
const savedSkillsOverride = process.env.GOODJOB_SKILLS_DIRS;
process.env.GOODJOB_SKILLS_DIRS = "/tmp/goodjob-skills-override";
assert.equal(workbuddySkillDirs(root), "/tmp/goodjob-skills-override", "GOODJOB_SKILLS_DIRS 必须优先于默认约定");
if (savedSkillsOverride === undefined) delete process.env.GOODJOB_SKILLS_DIRS;
else process.env.GOODJOB_SKILLS_DIRS = savedSkillsOverride;
for (const key of ENV_PROBE_KEYS) {
  const previous = savedEnvironment[key];
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

// 任务级 CLI 快速模式标记：解析 + 参数翻译 + 从提示词里剥离（2026-10-10）
assert.deepEqual(parseWorkbuddyCliProfile("普通提示词").profile, { effort: "", model: "", maxTurns: 0, disallowedTools: [] }, "没有标记时不得改变行为");
assert.deepEqual(
  parseWorkbuddyCliProfile("[[gj-cli-options {\"effort\":\"low\",\"maxTurns\":3.5,\"model\":\"gpt-9\"}]]\n正文").prompt,
  "正文",
  "标记行必须从提示词里剥离"
);
assert.deepEqual(
  parseWorkbuddyCliProfile("[[gj-cli-options {\"effort\":\"low\",\"maxTurns\":3.5,\"model\":\"gpt-9\"}]]\n正文").profile,
  { effort: "low", model: "", maxTurns: 0, disallowedTools: [] },
  "非法取值（非白名单模型 / 非整数轮次）必须被丢弃"
);
assert.deepEqual(
  parseWorkbuddyCliProfile("[[gj-cli-options {坏掉的 JSON}]]\n正文").profile,
  { effort: "", model: "", maxTurns: 0, disallowedTools: [] },
  "JSON 坏了也不能让协议头漏给 CLI"
);
// 标记与正文同一行：只剥标记，绝不能把整行吞掉（吞掉 = 提示词变空串 = CLI 空返回"成功"）
assert.deepEqual(
  parseWorkbuddyCliProfile("[[gj-cli-options {\"effort\":\"low\"}]] 正文").prompt,
  "正文",
  "同行标记必须只剥标记本身，保留同一行的正文"
);
assert.deepEqual(
  parseWorkbuddyCliProfile("[[gj-cli-options {坏掉的 JSON}]] 正文").prompt,
  "正文",
  "同行且 JSON 坏了时也要保留正文"
);
assert.deepEqual(
  parseWorkbuddyCliProfile("[[gj-cli-options {\"effort\":\"low\"}]] 正文\n第二行").prompt,
  "正文\n第二行",
  "同行标记 + 后续多行都必须完整保留"
);

const profileEvents: string[] = [];
await executeWorkbuddyTask({
  id: "task_workbuddy_profile", runnerId: "runner_test", adapter: "workbuddy",
  prompt: "[[gj-cli-options {\"effort\":\"low\",\"model\":\"fast-model\",\"maxTurns\":6,\"disallowedTools\":[\"Write\",\"Edit\",\"WebFetch\",\"Grep\"]}]]\n请读取文件后输出 JSON",
  workspace: root, executionMode: "read_only", timeoutSeconds: 60, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal, workbuddyBinary: fakeCodebuddy,
  async onEvent(event) { profileEvents.push(event.message); }
});
const profileInvocation = JSON.parse(await readFile(workbuddyInvocationFile, "utf8")) as { argv: string[]; prompt: string };
assert.deepEqual(profileInvocation.argv, [
  "--print", "--output-format", "stream-json", "--no-session-persistence", "--permission-mode", "plan",
  "--effort", "low", "--model", "fast-model", "--max-turns", "6",
  "--disallowedTools", "Write,Edit,WebFetch,Grep"
], "快速模式标记必须翻译成 CLI 参数");
assert.equal(profileInvocation.prompt, "请读取文件后输出 JSON", "CLI 只能拿到剥离标记后的提示词");
assert.ok(profileEvents.some((message) => message.includes("CLI 执行参数")), "必须留下执行参数进度事件，便于 CRM 排查耗时与模型");

const workbuddyWriteResult = await executeWorkbuddyTask({
  id: "task_workbuddy_write", runnerId: "runner_test", adapter: "workbuddy", prompt: "test",
  workspace: root, executionMode: "workspace_write", timeoutSeconds: 60, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal, workbuddyBinary: fakeCodebuddy,
  async onEvent() {}
});
assert.equal(workbuddyWriteResult.status, "succeeded");
assert.equal(
  (JSON.parse(await readFile(workbuddyInvocationFile, "utf8")) as { argv: string[] }).argv.at(-1),
  "acceptEdits",
  "workspace_write 必须映射成 acceptEdits 权限"
);

const workbuddyFailedResult = await executeWorkbuddyTask({
  id: "task_workbuddy_fail", runnerId: "runner_test", adapter: "workbuddy", prompt: "test",
  workspace: root, executionMode: "read_only", timeoutSeconds: 60, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal, workbuddyBinary: failingCodebuddy,
  async onEvent() {}
});
assert.equal(workbuddyFailedResult.status, "failed");
assert.ok(workbuddyFailedResult.errorMessage.includes("模型额度不足"));

await assert.rejects(() => executeWorkbuddyTask({
  id: "task_workbuddy_guard", runnerId: "runner_test", adapter: "codex", prompt: "test",
  workspace: root, executionMode: "read_only", timeoutSeconds: 60, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal, workbuddyBinary: fakeCodebuddy,
  async onEvent() {}
}), /只允许执行 WorkBuddy 适配器任务/);
await assert.rejects(() => executeWorkbuddyTask({
  id: "task_workbuddy_escape", runnerId: "runner_test", adapter: "workbuddy", prompt: "test",
  workspace: tmpdir(), executionMode: "read_only", timeoutSeconds: 60, status: "running"
}, {
  allowedWorkspaces: [root], signal: new AbortController().signal, workbuddyBinary: fakeCodebuddy,
  async onEvent() {}
}), /不在本机 Runner 授权范围内/);
assert.equal(resolveWorkbuddyBinary("/custom/codebuddy"), "/custom/codebuddy");
// 无显式指定时：PATH 里的独立版 codebuddy（可 /login）优先于桌面端内置 CLI（headless-only，
// 2026-10-06 实锤：回落到它会让所有任务 Authentication required）。
{
  const resolved = resolveWorkbuddyBinary();
  const which = (() => { try { return execFileSync("which", ["codebuddy"], { encoding: "utf8" }).trim(); } catch { return ""; }; })();
  if (which && which !== "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy") {
    assert.equal(resolved, which, "独立版 codebuddy 必须优先于桌面端内置 CLI");
  }
}

// —— CLI 探测缓存 + "成功值粘滞"（否则一次瞬时失败会抹掉库存里的能力）——
resetRunnerCliCache();
let codexProbes = 0;
let workbuddyProbes = 0;
const firstDetection = await detectRunnerClis({
  detectCodex: async () => { codexProbes += 1; return "codex 1.0.0"; },
  detectWorkbuddy: async () => { workbuddyProbes += 1; return "codebuddy 2.156.0"; }
});
assert.deepEqual(firstDetection, { codexVersion: "codex 1.0.0", workbuddyVersion: "codebuddy 2.156.0" });
await detectRunnerClis({
  detectCodex: async () => { codexProbes += 1; return "codex 9.9.9"; },
  detectWorkbuddy: async () => { workbuddyProbes += 1; return "codebuddy 9.9.9"; }
});
assert.equal(codexProbes, 1, "TTL 内必须复用缓存，不得重复启动 CLI");
assert.equal(workbuddyProbes, 1, "TTL 内必须复用缓存，不得重复启动 CLI");
const flakyDetection = await detectRunnerClis({
  force: true,
  detectCodex: async () => { throw new Error("probe timeout"); },
  detectWorkbuddy: async () => { throw new Error("probe timeout"); }
});
assert.deepEqual(flakyDetection, { codexVersion: "codex 1.0.0", workbuddyVersion: "codebuddy 2.156.0" },
  "单次探测失败必须保留上一次检测到的版本与能力");
for (let attempt = 0; attempt < 3; attempt += 1) {
  await detectRunnerClis({ force: true, detectCodex: async () => "", detectWorkbuddy: async () => "" });
}
assert.deepEqual(
  await detectRunnerClis({ force: true, detectCodex: async () => "", detectWorkbuddy: async () => "" }),
  { codexVersion: "", workbuddyVersion: "" },
  "连续失败达阈值后必须承认 CLI 已不在，不能一直挂着不可用的能力"
);

// —— 掉线后必须"秒级"自愈（账号切换 / CLI 重新登录常是瞬时窗口）——
// 上面刚把能力清零，此时应进入快速重探：常规 TTL 是 5 分钟，不能让用户等这么久。
const droppedSnapshot = cliDetectionSnapshot();
assert.ok(droppedSnapshot && droppedSnapshot.regressedAt > 0, "能力掉线后必须进入快速重探窗口");
let recoveryProbes = 0;
await new Promise((resolve) => setTimeout(resolve, 30));
const recovered = await detectRunnerClis({
  ttlMs: undefined,
  recoveryTtlMs: 10,
  detectCodex: async () => { recoveryProbes += 1; return "codex 1.0.0"; },
  detectWorkbuddy: async () => { recoveryProbes += 1; return "codebuddy 2.160.0"; }
});
assert.equal(recoveryProbes, 2, "掉线窗口内必须重新探测，而不是死等 5 分钟 TTL");
assert.deepEqual(recovered, { codexVersion: "codex 1.0.0", workbuddyVersion: "codebuddy 2.160.0" },
  "CLI 一恢复，能力就要立刻回来");
assert.equal(cliDetectionSnapshot()?.regressedAt, 0, "恢复后必须退出快速重探窗口");
assert.equal(runnerCliIssue(), "", "CLI 正常时不得上报故障");

// —— 心跳身份快照：探测再慢也不能阻塞心跳 ——
const heartbeatTestWorkspaces = [tmpdir()];
resetRunnerCliCache();
assert.equal(cachedRunnerIdentity(heartbeatTestWorkspaces), null, "还没有快照时返回 null（调用方决定是否等一次）");
const heartbeatIdentity = await runnerIdentity(heartbeatTestWorkspaces);
const cached = cachedRunnerIdentity(heartbeatTestWorkspaces);
assert.ok(cached, "runnerIdentity 之后必须能拿到快照");
assert.deepEqual(cached?.capabilities, heartbeatIdentity.capabilities, "快照能力必须与最近一次探测一致");
assert.equal(cachedRunnerIdentity(["/tmp/another-workspace"]), null, "工作目录不匹配的快照不得复用");
resetRunnerCliCache();

async function reservePort() {
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => resolve());
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("无法分配浏览器测试端口");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}
const browserPort = await reservePort();
const browserCdpPort = await reservePort();
const browserService = await startBrowserService({
  port: browserPort,
  cdpPort: browserCdpPort,
  dataDir: path.join(root, "browser-profile"),
  outputDir: path.join(root, "browser-output")
});
assert.equal(browserService.configuration.host, "127.0.0.1");
assert.equal(browserService.configuration.url, `http://127.0.0.1:${browserPort}/mcp`);
assert.equal(await isBrowserServiceReachable(browserService.configuration), true);
assert.equal(await isBrowserCdpReady(browserService.configuration), true);
assert.equal(await isBrowserMcpReady(browserService.configuration), true);
assert.throws(() => browserServiceConfiguration(process.env, { host: "0.0.0.0" }), /只允许绑定/);
await browserService.stop();
assert.equal(await isBrowserServiceReachable(browserService.configuration), false);
assert.equal(await isBrowserCdpReady(browserService.configuration), false);

// —— 独立浏览器起不来时 Runner 必须降级存活（回归）——
// 实测故障：本机已有常驻 Runner 占着 8931 → 新 Runner 启动即抛错退出，
// 而 CRM 侧心跳尚未过期，机器仍显示"在线"，派给它的任务永远排队没人领。
const occupiedPort = await reservePort();
const occupiedCdpPort = await reservePort();
const occupyingListener = net.createServer();
await new Promise<void>((resolve, reject) => {
  occupyingListener.once("error", reject);
  occupyingListener.listen(occupiedPort, "127.0.0.1", () => resolve());
});
const degradedBrowser = await tryStartBrowserService({
  port: occupiedPort,
  cdpPort: occupiedCdpPort,
  dataDir: path.join(root, "browser-profile-degraded"),
  outputDir: path.join(root, "browser-output-degraded")
});
assert.equal(degradedBrowser.service, null, "浏览器端口被占用时必须降级返回，绝不能抛错杀死 Runner");
assert.match(degradedBrowser.error, /已被占用/, "降级原因必须可读，便于在心跳里上报");
await new Promise<void>((resolve) => occupyingListener.close(() => resolve()));

await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, fakeCodexClosedLoop: true, structuredSpawn: true, browserMcpInjected: true, browserServiceLoopbackOnly: true, liveWorkflowCaptured: true, finalReplyIsLatestMessage: true, completedTurnStopsPromptly: true, workbuddyStreamJson: true, workbuddyPermissionMode: true, workbuddyEnvIsolation: true, workbuddySkillDirsInjected: true, workbuddyFailureSurfaced: true, workbuddyGuards: true, cliDetectionCachedAndSticky: true, browserFailureDegrades: true }, null, 2));
