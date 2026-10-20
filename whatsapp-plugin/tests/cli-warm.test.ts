import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CliEngine } from "../src/server/services/cli-engine";

/**
 * 常驻预热池的回测。
 *
 * 假 CLI 支持两种形态，和真 CLI 一致：
 * - `--input-format stream-json`：逐行读 NDJSON，每行回一轮 result，**读完后不退出**
 *   （这就是常驻进程）；
 * - 老形态：读 stdin 到 EOF，回一轮就退出。
 *
 * 日志写到 `FAKE_WARM_LOG`，用它证明「这一轮到底是哪个 pid 处理的」——
 * 「两次请求不共用进程」是这层最关键的契约（共用 = A 客户的内容进 B 客户的上下文）。
 */

const fakeCliSource = (execPath: string): string => `#!${execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.161.4 (fake)\\n");
  process.exit(0);
}
const log = process.env.FAKE_WARM_LOG || "";
const note = (payload) => { if (log) fs.appendFileSync(log, JSON.stringify(payload) + "\\n"); };
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "") : "";
};
const streamInput = flag("--input-format") === "stream-json";
note({ event: "start", pid: process.pid, args, streamInput });

if (process.env.FAKE_WARM_EXIT === "1") {
  process.exit(3);
}

const genMs = Number(process.env.FAKE_WARM_GEN_MS || 0);
const reply = process.env.FAKE_WARM_REPLY || '{"reply":"ok","confidence":0.9,"language":"en"}';

function answer(text) {
  note({ event: "request", pid: process.pid, text });
  setTimeout(() => {
    emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: reply, session_id: "sess-" + process.pid });
    if (!streamInput) process.exit(0);
  }, genMs);
}

if (streamInput) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message = null;
      try { message = JSON.parse(line); } catch { continue; }
      const content = message && message.message && message.message.content;
      const text = Array.isArray(content) ? String(content[0] && content[0].text || "") : "";
      answer(text);
    }
  });
  process.stdin.on("end", () => {
    // 被「用完即弃」收掉的进程会走到这里：测试靠这条日志证明进程真的退出了，
    // 而不是只从池子里摘掉（摘掉但还活着 = 进程泄漏，且它带着上一轮的上下文）。
    note({ event: "end", pid: process.pid });
    process.exit(0);
  });
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => answer(prompt));
}
`;

let directory = "";
let fakeCli = "";

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "wa-cli-warm-"));
  fakeCli = path.join(directory, "fake-codebuddy");
  await writeFile(fakeCli, fakeCliSource(process.execPath), { mode: 0o755 });
  await chmod(fakeCli, 0o755);
}, 30_000);

const engines: CliEngine[] = [];
afterEach(() => {
  while (engines.length) engines.pop()!.dispose();
});

function makeEngine(options: Record<string, unknown> = {}): CliEngine {
  const engine = new CliEngine({
    binary: fakeCli,
    workspacePath: directory,
    warm: true,
    warmTarget: 1,
    warmReadyMs: 60,
    ...options
  });
  engines.push(engine);
  return engine;
}

async function logOf(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

let logSeq = 0;
function logPath(): string {
  logSeq += 1;
  return path.join(directory, `log-${logSeq}.jsonl`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

describe("常驻预热池", () => {
  it("预热后第一个请求复用预热进程，而不是现场再起一个", async () => {
    const log = logPath();
    process.env.FAKE_WARM_LOG = log;
    const engine = makeEngine();
    await engine.warmup("deepseek-v4.1-flash", "");
    // 子进程写日志是异步的：warmup 只保证进程已 spawn 且过了就绪等待。
    await waitFor(async () => (await logOf(log)).some((entry) => entry.event === "start"));
    const entries = await logOf(log);
    const started = entries.filter((entry) => entry.event === "start");
    expect(started.length, "预热应该只起一个进程").toBe(1);
    const warmPid = started[0]!.pid;

    await engine.run({ prompt: "hello", model: "deepseek-v4.1-flash" });
    const after = await logOf(log);
    const requests = after.filter((entry) => entry.event === "request");
    expect(requests.length).toBe(1);
    expect(requests[0]!.pid, "第一个请求必须落在预热进程上").toBe(warmPid);
  });

  it("用完即弃：两次请求不共用进程（共用就意味着上一轮内容会进下一轮上下文）", async () => {
    const log = logPath();
    process.env.FAKE_WARM_LOG = log;
    const engine = makeEngine();
    await engine.warmup("deepseek-v4.1-flash", "");

    await engine.run({ prompt: "first", model: "deepseek-v4.1-flash" });
    // 等后台补位完成，再发第二次。
    await waitFor(async () => (await logOf(log)).filter((entry) => entry.event === "start").length >= 2);
    await engine.run({ prompt: "second", model: "deepseek-v4.1-flash" });

    const requests = (await logOf(log)).filter((entry) => entry.event === "request");
    expect(requests.length).toBe(2);
    expect(requests[0]!.pid).not.toBe(requests[1]!.pid);
    expect(requests.map((entry) => entry.text)).toEqual(["first", "second"]);
    // 用完即弃的第二半：用过的进程必须真的退出，否则它会一直带着这一轮上下文。
    const exited = await waitFor(async () =>
      (await logOf(log)).some((entry) => entry.event === "end" && entry.pid === requests[0]!.pid)
    );
    expect(exited, "用过的进程必须被收掉（只从池里摘掉但还活着 = 泄漏 + 带上下文）").toBe(true);
  });

  it("池空也能工作：没预热时现场起一个（等价老行为，不会更慢）", async () => {
    const log = logPath();
    process.env.FAKE_WARM_LOG = log;
    // 不调 warmup：池子就是空的。
    const engine = makeEngine({ warmReadyMs: 0 });
    const result = await engine.run({ prompt: "no-warm", model: "deepseek-v4.1-flash" });
    expect(result.text).toContain("ok");
    expect((await logOf(log)).filter((entry) => entry.event === "request").length).toBe(1);
  });

  it("进程启动即失败时报可读原因，而不是等到超时", async () => {
    process.env.FAKE_WARM_EXIT = "1";
    try {
      const engine = makeEngine({ warmTarget: 0, warmReadyMs: 0 });
      await expect(engine.run({ prompt: "x" })).rejects.toThrow(/提前退出|无法启动/u);
    } finally {
      delete process.env.FAKE_WARM_EXIT;
    }
  });

  it("warm 关闭时走老路径：参数里没有 --input-format，行为与之前完全一致", async () => {
    const log = logPath();
    process.env.FAKE_WARM_LOG = log;
    const plain = new CliEngine({ binary: fakeCli, workspacePath: directory });
    engines.push(plain);
    const result = await plain.run({ prompt: "cold", model: "deepseek-v4.1-flash" });
    expect(result.text).toContain("ok");

    const started = (await logOf(log)).filter((entry) => entry.event === "start");
    expect(started.length).toBe(1);
    expect(started[0]!.streamInput, "老路径不能带流式输入参数").toBe(false);
  });

  it("参数不同的请求不会捡走参数不对的预热进程（否则模型会被悄悄换掉）", async () => {
    const log = logPath();
    process.env.FAKE_WARM_LOG = log;
    const engine = makeEngine();
    // 预热的是 glm-5.3，请求的是 flash：必须另起一个，不能拿错的那个凑合。
    await engine.warmup("glm-5.3", "");
    await engine.run({ prompt: "flash-please", model: "deepseek-v4.1-flash" });

    const started = (await logOf(log)).filter((entry) => entry.event === "start");
    const requestPid = (await logOf(log)).find((entry) => entry.event === "request")!.pid;
    const requestingProcess = started.find((entry) => entry.pid === requestPid)!;
    expect(String(requestingProcess.args)).toContain("deepseek-v4.1-flash");
  });
});
