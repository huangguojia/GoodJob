import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTO_REPLY_SKILL,
  CLI_MODEL_DEFAULT,
  CLI_MODEL_IDS,
  CliEngine,
  cliProcessEnvironment,
  cliSkillDirective,
  listInstalledSkills,
  parseCliStream,
  resolveCliBinary,
  resolveSkillsDirs,
  sanitizeCliEffort,
  sanitizeCliModel
} from "../src/server/services/cli-engine";

/**
 * 本机 CLI 引擎的回测。
 *
 * 这里刻意用一个「假 CLI 脚本」冒充 codebuddy：环境剥离与 stream-json 解析是本功能最容易出错的两块，
 * 而它们又完全不需要真的起 CLI。真机端到端另在 tests/auto-chat-cli.test.ts 里跑。
 */

let directory = "";
let fakeCli = "";

/**
 * 假 CLI。行为由 FAKE_CLI_MODE 驱动（CliEngine 会继承除宿主注入变量之外的环境，所以这个变量能传到子进程）：
 * - `ok`（默认）：正常返回 stream-json；
 * - `fenced` / `chatty`：把 JSON 包在围栏里 / 前后夹寒暄；
 * - `fail`：终态事件报错，退出码 1；
 * - `auth`：**退出码 0** 但在 errors 数组里报未登录（真实 CLI 就是这种行为）；
 * - `empty`：退出码 0 且什么都不输出；
 * - `slow`：睡得比超时长；
 * - `env-dump`：回吐子进程看到的技能扫描目录（验证我们真的下发了 `CODEBUDDY_SESSION_SKILL_DIRS`）。
 */
const fakeCliSource = (execPath: string): string => `#!${execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.161.4 (fake)\\n");
  process.exit(0);
}
const mode = process.env.FAKE_CLI_MODE || "ok";
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  emit({ type: "system", subtype: "init", session_id: "sess-fake-1", model: "glm-5.3" });
  if (mode === "echo-args") {
    emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ args, promptLength: prompt.length }) });
    process.exit(0);
  }
  if (mode === "slow") {
    setTimeout(() => process.exit(0), 10000);
    return;
  }
  if (mode === "env-dump") {
    emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ skillsDirs: process.env.CODEBUDDY_SESSION_SKILL_DIRS ?? null }) });
    process.exit(0);
  }
  if (mode === "auth") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Authentication required. Please use /login to sign in."] });
    process.exit(0);
  }
  if (mode === "fail") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, error: "model overloaded" });
    process.exit(1);
  }
  if (mode === "empty") {
    process.exit(0);
  }
  const reply = process.env.FAKE_CLI_REPLY || '{"reply":"Thanks, we will reply shortly.","confidence":0.86,"reason":"fake","language":"en"}';
  const text = mode === "fenced"
    ? "Sure:\\n\\u0060\\u0060\\u0060json\\n" + reply + "\\n\\u0060\\u0060\\u0060\\n"
    : mode === "chatty"
      ? "Sure, here is the reply:\\n" + reply + "\\nHope that helps!"
      : reply;
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: "sess-fake-1" });
  process.exit(0);
});
`;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "wa-cli-engine-"));
  fakeCli = path.join(directory, "fake-codebuddy");
  await writeFile(fakeCli, fakeCliSource(process.execPath), { mode: 0o755 });
  await chmod(fakeCli, 0o755);
}, 30_000);

afterAll(() => {
  delete process.env.FAKE_CLI_MODE;
  delete process.env.FAKE_CLI_REPLY;
});

describe("CLI 子进程环境", () => {
  it("剥掉宿主注入的网关与会话变量，否则 --print 会 0 输出永久挂起", () => {
    const environment = cliProcessEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      SERVER__HOST: "127.0.0.1",
      SERVER__PORT: "52051",
      CODEBUDDY_CONFIG_DIR: "/Users/someone/.workbuddy",
      CODEBUDDY_HOST: "http://127.0.0.1:1",
      CODEBUDDY_GATEWAY_AUTH: "secret",
      CODEBUDDY_API_KEY_HELPER_DISABLED: "1",
      CODEBUDDY_INTERNET_ENVIRONMENT: "intranet",
      WORKBUDDY_PAC_RPC_SOCKET: "/tmp/workbuddy-pac-1.sock",
      WORKBUDDY_PAC_RPC_TOKEN: "token",
      CODEBUDDY_IDE_PORT: "52052",
      CODEBUDDY_SERVICE_PROXY_URL: "http://127.0.0.1:1",
      CODEBUDDY_MCP_CONFIG: "/tmp/mcp.json",
      CODEBUDDY_SESSION_ID: "sess",
      CODEBUDDY_SAFE_DELETE_TOKEN: "x",
      CODEBUDDY_SANDBOX_ROOT: "/tmp/sandbox",
      CLIENT_INFO_OS: "darwin",
      NODE_OPTIONS: "--require /tmp/patch.cjs",
      ELECTRON_RUN_AS_NODE: "1",
      BASH_ENV: "/tmp/host.sh",
      TRACEPARENT: "00-abc-def-01"
    });

    for (const key of [
      "SERVER__HOST", "SERVER__PORT", "CODEBUDDY_CONFIG_DIR", "CODEBUDDY_HOST", "CODEBUDDY_GATEWAY_AUTH",
      "CODEBUDDY_API_KEY_HELPER_DISABLED", "CODEBUDDY_INTERNET_ENVIRONMENT", "WORKBUDDY_PAC_RPC_SOCKET",
      "WORKBUDDY_PAC_RPC_TOKEN", "CODEBUDDY_IDE_PORT", "CODEBUDDY_SERVICE_PROXY_URL", "CODEBUDDY_MCP_CONFIG",
      "CODEBUDDY_SESSION_ID", "CODEBUDDY_SAFE_DELETE_TOKEN", "CODEBUDDY_SANDBOX_ROOT", "CLIENT_INFO_OS",
      "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "BASH_ENV", "TRACEPARENT"
    ]) {
      expect(environment[key], `${key} 必须被剥掉`).toBeUndefined();
    }
    // 无关变量必须原样保留，否则 CLI 读不到自己的登录凭据目录。
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.HOME).toBe("/Users/someone");
    expect(environment).toMatchObject({ NO_COLOR: "1", FORCE_COLOR: "0", NO_PROXY: "*", no_proxy: "*" });
  });

  it("只剥指向本机的代理，保留真正的远程出网代理", () => {
    const environment = cliProcessEnvironment({
      HTTP_PROXY: "http://127.0.0.1:52051",
      HTTPS_PROXY: "http://localhost:7897",
      ALL_PROXY: "http://[::1]:1080",
      http_proxy: "http://proxy.corp.example:8080",
      https_proxy: "socks5://proxy.corp.example:1080"
    });
    expect(environment.HTTP_PROXY).toBeUndefined();
    expect(environment.HTTPS_PROXY).toBeUndefined();
    expect(environment.ALL_PROXY).toBeUndefined();
    expect(environment.http_proxy).toBe("http://proxy.corp.example:8080");
    expect(environment.https_proxy).toBe("socks5://proxy.corp.example:1080");
  });

  it("CODEBUDDY_* 整族剥离：黑名单外的宿主变量也一个不留（实测残留 CODEBUDDY_CONFIG_DIR 会让子 CLI error_during_execution）", () => {
    const environment = cliProcessEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      // 下面这些**不在旧黑名单里**——都是宿主实测注入过的会话状态变量，随版本增减：
      CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      CODEBUDDY_CURRENT_MODEL_ID: "glm-5.3",
      CODEBUDDY_QIMEI36: "abc",
      CODEBUDDY_TOOL_CALL_ID: "t1",
      CODEBUDDY_PROJECT_DIR: "/tmp/proj",
      WORKBUDDY_STARTUP_PID: "123",
      CLAUDE_PROJECT_DIR: "/tmp/proj",
      // 插件自己下发的技能目录不属于「宿主残留」——它由 childEnvironment() 在剥离之后设置。
      CODEBUDDY_SESSION_SKILL_DIRS: "/tmp/skills"
    });
    for (const key of [
      "CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS", "CODEBUDDY_CURRENT_MODEL_ID", "CODEBUDDY_QIMEI36",
      "CODEBUDDY_TOOL_CALL_ID", "CODEBUDDY_PROJECT_DIR", "WORKBUDDY_STARTUP_PID", "CLAUDE_PROJECT_DIR"
    ]) {
      expect(environment[key], `${key} 必须被剥掉`).toBeUndefined();
    }
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.HOME).toBe("/Users/someone");
  });
});

describe("CLI 二进制解析与取值白名单", () => {
  it("显式配置优先于任何探测", () => {
    expect(resolveCliBinary("/opt/homebrew/bin/codebuddy")).toBe("/opt/homebrew/bin/codebuddy");
  });

  it("模型与档位走白名单：非法值回落到「跟随 CLI 默认」，空串是合法值", () => {
    expect(sanitizeCliModel("glm-5.3")).toBe("glm-5.3");
    expect(sanitizeCliModel("  deepseek-v4.1-flash ")).toBe("deepseek-v4.1-flash");
    expect(sanitizeCliModel("gpt-4o")).toBe("");
    expect(sanitizeCliModel("")).toBe("");
    expect(sanitizeCliModel(undefined)).toBe("");
    expect(sanitizeCliEffort("high")).toBe("high");
    expect(sanitizeCliEffort("HIGH")).toBe("high");
    expect(sanitizeCliEffort("ludicrous")).toBe("");
    expect(CLI_MODEL_IDS).toContain(CLI_MODEL_DEFAULT);
  });
});

describe("stream-json 解析", () => {
  it("从 system 事件取自报模型，从 result 事件取终态文本", () => {
    const parsed = parseCliStream([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "glm-5.3" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"reply\":\"hi\"}", session_id: "s1" })
    ]);
    expect(parsed).toMatchObject({ model: "glm-5.3", sessionId: "s1", failed: false, text: "{\"reply\":\"hi\"}" });
  });

  it("没有 result 事件时退到逐条累积的正文", () => {
    const parsed = parseCliStream([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "part-1" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "part-2" }] } })
    ]);
    expect(parsed.text).toBe("part-1\n\npart-2");
    expect(parsed.failed).toBe(false);
  });

  it("未登录时失败原因只在 errors 数组里，必须兜底到它（退出码是 0）", () => {
    const parsed = parseCliStream([
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Authentication required. Please use /login"] })
    ]);
    expect(parsed.failed).toBe(true);
    expect(parsed.error).toContain("Authentication required");
  });

  it("忽略非 JSON 行与工具调用事件，不让它们污染回复正文", () => {
    const parsed = parseCliStream([
      "warning: remote config unavailable",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "x" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final" })
    ]);
    expect(parsed.text).toBe("final");
    expect(parsed.error).toBe("");
  });
});

describe("CliEngine 探测", () => {
  it("假 CLI 报出版本号即视为可用；路径不存在时给出可读原因", async () => {
    const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
    const status = await engine.status();
    expect(status).toMatchObject({ available: true, binary: fakeCli, version: "2.161.4 (fake)", reason: "" });
    expect(status.models).toContain(CLI_MODEL_DEFAULT);

    const missing = new CliEngine({ binary: path.join(directory, "not-here"), workspacePath: directory });
    const missingStatus = await missing.status();
    expect(missingStatus.available).toBe(false);
    expect(missingStatus.reason).toContain("未找到可执行文件");
  });
});

describe("CliEngine 执行", () => {
  it("把提示词写进 stdin，并把模型/档位翻译成 CLI 参数", async () => {
    process.env.FAKE_CLI_MODE = "echo-args";
    try {
      const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
      const result = await engine.run({ prompt: "回一句报价", model: "glm-5.3", effort: "low" });
      const echoed = JSON.parse(result.text) as { args: string[]; promptLength: number };
      expect(echoed.args).toContain("--print");
      expect(echoed.args).toContain("stream-json");
      expect(echoed.args).toContain("--no-session-persistence");
      expect(echoed.args.join(" ")).toContain("--model glm-5.3");
      expect(echoed.args.join(" ")).toContain("--effort low");
      // 关键：提示词不能出现在 argv 里（引号/换行/长度都不可靠），只能走 stdin。
      expect(echoed.promptLength).toBe("回一句报价".length);
      expect(echoed.args.join(" ")).not.toContain("回一句报价");
      expect(result.model).toBe("glm-5.3");
    } finally {
      delete process.env.FAKE_CLI_MODE;
    }
  });

  it("非法模型透传不出去（走白名单回落）", async () => {
    process.env.FAKE_CLI_MODE = "echo-args";
    try {
      const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
      const result = await engine.run({ prompt: "hi", model: "gpt-4o", effort: "ludicrous" });
      const echoed = JSON.parse(result.text) as { args: string[] };
      expect(echoed.args.join(" ")).not.toContain("gpt-4o");
      expect(echoed.args.join(" ")).not.toContain("--effort");
    } finally {
      delete process.env.FAKE_CLI_MODE;
    }
  });

  it("失败时抛出 CLI 自报的原因，而不是笼统的退出码", async () => {
    process.env.FAKE_CLI_MODE = "fail";
    try {
      const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
      await expect(engine.run({ prompt: "hi" })).rejects.toThrow("model overloaded");
    } finally {
      delete process.env.FAKE_CLI_MODE;
    }
  });

  it("退出码 0 但没有内容也要当失败（未登录的典型表现）", async () => {
    process.env.FAKE_CLI_MODE = "empty";
    try {
      const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
      await expect(engine.run({ prompt: "hi" })).rejects.toThrow(/没有返回任何内容/u);
    } finally {
      delete process.env.FAKE_CLI_MODE;
    }
  });

  it("超时会杀掉子进程并抛出可读原因，且超时下限被夹到 5 秒", async () => {
    process.env.FAKE_CLI_MODE = "slow";
    try {
      const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
      // 传 1200ms 也会被夹到 5 秒下限：一次 CLI 生成根本来不及在 1 秒内完成，
      // 让它"超时"只会把偶发慢当成故障。
      await expect(engine.run({ prompt: "hi", timeoutMs: 1_200 })).rejects.toThrow(/超过 5 秒/u);
    } finally {
      delete process.env.FAKE_CLI_MODE;
    }
  }, 20_000);
});

/**
 * 技能装载的三层里，这一层（把技能目录交给 CLI）最容易静默失效：
 * 技能没被扫到，任务照常跑，只是回复不再遵循技能里的方法论——用户只能从质量上体感发现。
 * 所以这里既验「解析到哪」，也验「真的下发给了子进程」。
 */
describe("自动回复技能装载", () => {
  it("默认解析到插件自带的 skills/，并扫出 goodjob-auto-reply", () => {
    const dirs = resolveSkillsDirs("");
    expect(dirs).toBe(path.resolve(process.cwd(), "skills"));
    expect(listInstalledSkills(dirs)).toContain(AUTO_REPLY_SKILL);
  });

  it("技能目录名与 frontmatter 的 name 必须逐字一致", async () => {
    // 目录名与 name 不一致时 CLI 不会报错，只是找不到这个技能——最难查的一类失败。
    const content = await readFile(path.join(resolveSkillsDirs(""), AUTO_REPLY_SKILL, "SKILL.md"), "utf8");
    const name = /^---\n[\s\S]*?^name:\s*(\S+)\s*$/mu.exec(content)?.[1];
    expect(name).toBe(AUTO_REPLY_SKILL);
    expect(content).toContain("description:");
  });

  it("显式配置优先于自带目录（便于多个产品共用一份安装位置）", () => {
    expect(resolveSkillsDirs("/srv/shared-skills")).toBe("/srv/shared-skills");
    expect(resolveSkillsDirs("  ")).toBe(path.resolve(process.cwd(), "skills"));
  });

  it("没有 SKILL.md 的子目录不算技能", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "wa-skills-scan-"));
    await mkdir(path.join(scratch, "not-a-skill"), { recursive: true });
    await writeFile(path.join(scratch, "other.txt"), "x");
    await mkdir(path.join(scratch, "real-skill"), { recursive: true });
    await writeFile(path.join(scratch, "real-skill", "SKILL.md"), "---\nname: real-skill\ndescription: d\n---\n");
    expect(listInstalledSkills(scratch)).toEqual(["real-skill"]);
    expect(listInstalledSkills("")).toEqual([]);
  });

  it("点名句既要求加载技能，也给出拿不到时的退路（缺装不等于整条链失败）", () => {
    const directive = cliSkillDirective();
    expect(directive).toContain(`"${AUTO_REPLY_SKILL}"`);
    expect(directive).toMatch(/not available[\s\S]*continue/iu);
  });

  it("把技能扫描目录真的下发给 CLI 子进程", async () => {
    process.env.FAKE_CLI_MODE = "env-dump";
    try {
      const engine = new CliEngine({ binary: fakeCli, workspacePath: directory, skillsDirs: "/srv/shared-skills" });
      const result = await engine.run({ prompt: "hi" });
      expect(JSON.parse(result.text)).toMatchObject({ skillsDirs: "/srv/shared-skills" });
      expect((await engine.status()).skillsDirs).toBe("/srv/shared-skills");
    } finally {
      delete process.env.FAKE_CLI_MODE;
    }
  });

  it("探测结果里带上技能目录与扫到的技能，界面才能说清「技能没装上」", async () => {
    const engine = new CliEngine({ binary: fakeCli, workspacePath: directory });
    const status = await engine.status();
    expect(status.autoReplySkill).toBe(AUTO_REPLY_SKILL);
    expect(status.skills).toContain(AUTO_REPLY_SKILL);
    expect(status.skillsDirs).toBe(path.resolve(process.cwd(), "skills"));
  });
});
