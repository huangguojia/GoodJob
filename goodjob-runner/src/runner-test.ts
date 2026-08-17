import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserServiceConfiguration, isBrowserCdpReady, isBrowserMcpReady, isBrowserServiceReachable, startBrowserService } from "./browser-service.js";
import { codexCodeModeHost, executeCodexTask, resolveCodexBinary } from "./codex-adapter.js";

const root = await mkdtemp(path.join(tmpdir(), "goodjob-runner-test-"));
const fakeCodex = path.join(root, "fake-codex.mjs");
const lingeringCodex = path.join(root, "lingering-codex.mjs");
const invocationFile = path.join(root, "codex-invocation.json");
await writeFile(path.join(root, "codex-code-mode-host"), "", { mode: 0o700 });
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
  assert.ok(codexCodeModeHost(resolved), `Codex 工具宿主缺失：${resolved}`);
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

await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, fakeCodexClosedLoop: true, structuredSpawn: true, browserMcpInjected: true, browserServiceLoopbackOnly: true, liveWorkflowCaptured: true, finalReplyIsLatestMessage: true, completedTurnStopsPromptly: true }, null, 2));
