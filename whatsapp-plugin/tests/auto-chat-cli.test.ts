import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AutoChatDraft, AutoChatSettings, ChannelAccount, ChatMessage, CliEngineStatus, TrainingProfile } from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { inMemoryDatabasePaths } from "./helpers/test-database";
import { createDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";
import { AutoChatService } from "../src/server/services/auto-chat-service";
import { CliEngine } from "../src/server/services/cli-engine";
import { bindPersistentTestServer, closePersistentTestServer } from "./helpers/persistent-server";

/**
 * 自动回复走本机 WorkBuddy CLI 的端到端回测。
 *
 * 用假 CLI 脚本冒充 codebuddy：能覆盖「真发出去」「脏输出容错」「失败降级」
 * 这些只有真跑一遍子进程才知道对不对的行为，同时不需要在这台机器上真的有登录态。
 */
describe("Auto reply through the local WorkBuddy CLI", () => {
  let runtime: AppRuntime;
  let europe: ChannelAccount;
  let directory = "";
  let fakeCli = "";
  /** 持久监听：见 tests/helpers/persistent-server.ts（supertest 默认每请求 listen(0)+close()）。 */
  let httpServer: Server;

  /** 所有请求都走这个已经监听的 server，避免上百次临时端口绑定造成随机 socket hang up。 */
  const api = () => request(httpServer);

  const QUESTION = "你们的最小起订量是多少？";
  const SEEDED_REPLY = "我们的最小起订量是每个型号 500 件。";
  const CLI_REPLY = "Thanks for asking — our MOQ is 500 units per model.";

  /** 与 training-auto-chat 里同款假 CLI：行为由 FAKE_CLI_MODE 驱动。 */
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
  emit({ type: "system", subtype: "init", session_id: "sess-cli-1", model: "glm-5.3" });
  if (mode === "fail") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, error: "model overloaded" });
    process.exit(1);
  }
  if (mode === "auth") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Authentication required. Please use /login to sign in."] });
    process.exit(0);
  }
  if (mode === "garbage") {
    emit({ type: "result", subtype: "success", is_error: false, result: "I could not produce anything useful." });
    process.exit(0);
  }
  const reply = process.env.FAKE_CLI_REPLY || '{"reply":"ok","confidence":0.86,"reason":"fake","language":"en"}';
  const text = mode === "fenced"
    ? "Here you go:\\n\\u0060\\u0060\\u0060json\\n" + reply + "\\n\\u0060\\u0060\\u0060\\n"
    : mode === "chatty"
      ? "Sure, here is the reply:\\n" + reply + "\\nHope that helps!"
      : reply;
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: "sess-cli-1" });
  process.exit(0);
});
`;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "wa-auto-chat-cli-"));
    fakeCli = path.join(directory, "fake-codebuddy");
    await writeFile(fakeCli, fakeCliSource(process.execPath), { mode: 0o755 });
    await chmod(fakeCli, 0o755);

    const config = {
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(directory),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: true,
      allowPrivateAiEndpoints: true,
      cliBinary: fakeCli,
      cliWorkspacePath: path.join(directory, "cli-ws"),
      autoChatSweep: false
    } as const;
    const fixtureDatabase = await createDatabase(config);
    await migrate(fixtureDatabase);
    const fixtureRepository = new Repository(fixtureDatabase);
    await seed(fixtureDatabase, fixtureRepository, config);
    await seedDemo(fixtureDatabase, fixtureRepository, config);
    await fixtureDatabase.close();

    runtime = await createAppRuntime(config);
    httpServer = await bindPersistentTestServer(runtime.app);
    const accounts = (await api().get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
    europe = accounts.find((account) => account.name === "欧洲销售")!;
  }, 60_000);

  afterAll(async () => {
    await closePersistentTestServer(httpServer);
    await runtime.close();
    delete process.env.FAKE_CLI_MODE;
    delete process.env.FAKE_CLI_REPLY;
  });

  const setCli = (mode: string, reply?: Record<string, unknown>): void => {
    process.env.FAKE_CLI_MODE = mode;
    if (reply) process.env.FAKE_CLI_REPLY = JSON.stringify(reply);
    else delete process.env.FAKE_CLI_REPLY;
  };

  const putSettings = (body: Record<string, unknown>) =>
    api().put("/api/v1/auto-chat/settings").send(body);

  const quietAutoChat = async (): Promise<void> => {
    await putSettings({ enabled: false, mode: "off", accountId: null }).expect(200);
  };

  const inbound = async (phone: string, body: string): Promise<ChatMessage> =>
    (await api()
      .post("/api/v1/demo/inbound")
      .send({ accountId: europe.id, displayName: `CLI 客户 ${phone.slice(-4)}`, phone, body })
      .expect(201)).body as ChatMessage;

  const listDrafts = async (): Promise<AutoChatDraft[]> =>
    (await api().get("/api/v1/auto-chat/drafts?limit=100").expect(200)).body as AutoChatDraft[];

  const draftFor = async (conversationId: string, inboundBody: string): Promise<AutoChatDraft> => {
    // 截止时间而非固定次数：入站钩子是 fire-and-forget 的，而这里每生成一条草稿都要
    // 起一个真的子进程，机器忙时慢下来是正常的。15 秒低于 20 秒 testTimeout，
    // 让超时报清楚的原因而不是含糊的「Test timed out」。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = (await listDrafts()).find((draft) => draft.conversationId === conversationId && draft.inboundBody === inboundBody);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("等待 CLI 自动回复草稿超时");
  };

  const outbound = async (conversationId: string): Promise<string[]> => {
    const messages = (await api().get(`/api/v1/conversations/${conversationId}/messages`).expect(200)).body as ChatMessage[];
    return messages.filter((message) => message.direction === "outbound").map((message) => message.body);
  };

  let profile: TrainingProfile;

  /** 训练档案 → 打开 CLI 引擎的自动回复。 */
  const enableCliAutoReply = async (overrides: Record<string, unknown> = {}): Promise<AutoChatSettings> => {
    const response = await putSettings({
      enabled: true,
      mode: "auto",
      accountId: null,
      engine: "cli",
      profileId: profile.id,
      providerId: null,
      cliModel: "glm-5.3",
      cliEffort: "low",
      dailyLimit: 0,
      minIntervalMinutes: 0,
      activeHoursStart: 0,
      activeHoursEnd: 0,
      confidenceThreshold: 0.6,
      ...overrides
    }).expect(200);
    return response.body as AutoChatSettings;
  };

  it("探测接口报出本机 CLI 可用与默认模型", async () => {
    const response = await api().get("/api/v1/auto-chat/engine").expect(200);
    const status = response.body as CliEngineStatus;
    expect(status).toMatchObject({ available: true, binary: fakeCli, version: "2.161.4 (fake)", reason: "" });
    expect(status.models).toContain(status.defaultModel);
    expect(status.efforts).toContain("low");

    // refresh=1 强制重探也要能过（跳过缓存）。
    const refreshed = await api().get("/api/v1/auto-chat/engine?refresh=true").expect(200);
    expect((refreshed.body as CliEngineStatus).available).toBe(true);
  });

  it("准备一份训练档案，并把引擎切到本机 CLI", async () => {
    setCli("ok", { reply: CLI_REPLY, confidence: 0.86, reason: "fake", language: "en" });
    const message = await inbound("+8613900000301", QUESTION);
    await api()
      .post(`/api/v1/conversations/${message.conversationId}/messages`)
      .send({ accountId: europe.id, clientMessageId: "cli-seed-reply-0001", body: SEEDED_REPLY })
      .expect(201);
    profile = (await api()
      .post("/api/v1/training/profiles")
      .send({ name: "CLI 话术档案", useAi: false, conversationIds: [message.conversationId] })
      .expect(201)).body as TrainingProfile;
    expect(profile.status).toBe("ready");

    const settings = await enableCliAutoReply();
    expect(settings).toMatchObject({ engine: "cli", cliModel: "glm-5.3", cliEffort: "low", mode: "auto", enabled: true });
  });

  it("引擎选 CLI 时，回复由 CLI 生成并真的发出去", async () => {
    const message = await inbound("+8613900000302", "What is your MOQ for this model?");
    const draft = await draftFor(message.conversationId, message.body);

    expect(draft).toMatchObject({ engine: "cli", status: "sent", mode: "auto", body: CLI_REPLY, model: "glm-5.3" });
    // CLI 自报的模型必须落进草稿：这是「配的模型到底生效没有」的唯一直接证据。
    expect(draft.reason).toContain("本机 CLI 生成");
    expect(draft.reason).toContain("实际使用模型：glm-5.3");
    expect(await outbound(message.conversationId)).toContain(CLI_REPLY);
  });

  it("CLI 输出带围栏或寒暄时照样能抠出 JSON", async () => {
    setCli("fenced", { reply: "Fenced reply body.", confidence: 0.9, reason: "wrapped", language: "en" });
    const fenced = await inbound("+8613900000303", "Could you send the catalogue?");
    expect(await draftFor(fenced.conversationId, fenced.body)).toMatchObject({ engine: "cli", status: "sent", body: "Fenced reply body." });

    setCli("chatty", { reply: "Chatty reply body.", confidence: 0.9, reason: "wrapped", language: "en" });
    const chatty = await inbound("+8613900000304", "Do you ship to Spain?");
    expect(await draftFor(chatty.conversationId, chatty.body)).toMatchObject({ engine: "cli", status: "sent", body: "Chatty reply body." });
  }, 45_000);

  it("CLI 回复里带报价时，护栏照样拦下不自动发送", async () => {
    setCli("ok", { reply: "Our best price is USD 12 per unit.", confidence: 0.95, reason: "priced", language: "en" });
    const message = await inbound("+8613900000305", "Can you quote 500 units?");
    const draft = await draftFor(message.conversationId, message.body);

    expect(draft).toMatchObject({ engine: "cli", status: "pending", messageId: null });
    expect(draft.reason).toContain("可能触碰护栏");
    expect(await outbound(message.conversationId)).toHaveLength(0);
  });

  it("CLI 执行失败时降级为话术库，并且不自动发送", async () => {
    setCli("fail");
    const message = await inbound("+8613900000306", QUESTION);
    const draft = await draftFor(message.conversationId, message.body);

    expect(draft.engine).toBe("rules");
    expect(draft.status).toBe("pending");
    expect(draft.reason).toContain("本机 CLI 生成失败已降级为话术库");
    expect(draft.reason).toContain("model overloaded");
    expect(await outbound(message.conversationId)).toHaveLength(0);
    setCli("ok", { reply: CLI_REPLY, confidence: 0.86, reason: "fake", language: "en" });
  });

  it("CLI 未登录（退出码 0 但 result 报错）也要当成失败，并把原始原因带出来", async () => {
    setCli("auth");
    const message = await inbound("+8613900000307", "Do you have a distributor in Germany?");
    const draft = await draftFor(message.conversationId, message.body);

    expect(draft.engine).toBe("rules");
    expect(draft.status).toBe("pending");
    expect(draft.reason).toContain("Authentication required");
    expect(await outbound(message.conversationId)).toHaveLength(0);
    setCli("ok", { reply: CLI_REPLY, confidence: 0.86, reason: "fake", language: "en" });
  });

  it("CLI 吐出的不是 JSON 时不硬猜：降级话术库且不自动发送", async () => {
    setCli("garbage");
    const message = await inbound("+8613900000308", "Any discount for 1000 units?");
    const draft = await draftFor(message.conversationId, message.body);

    expect(draft.engine).toBe("rules");
    expect(draft.status).toBe("pending");
    expect(await outbound(message.conversationId)).toHaveLength(0);
    setCli("ok", { reply: CLI_REPLY, confidence: 0.86, reason: "fake", language: "en" });
  });

  it("模型/档位走白名单：非法值保留上一次的值，显式空串才是跟随 CLI 默认", async () => {
    const rejected = await enableCliAutoReply({ cliModel: "gpt-4o", cliEffort: "ludicrous" });
    expect(rejected).toMatchObject({ cliModel: "glm-5.3", cliEffort: "low" });

    const reset = await enableCliAutoReply({ cliModel: "", cliEffort: "" });
    expect(reset).toMatchObject({ cliModel: "", cliEffort: "" });
  });

  it("引擎选 AI 却没配 Provider 时明确拒绝，而不是存下去静默降级", async () => {
    const response = await putSettings({ enabled: true, mode: "auto", accountId: null, engine: "ai", providerId: null, profileId: profile.id });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "AI_PROVIDER_REQUIRED" });
  });

  it("CLI 修好之前不许把引擎切到 CLI", async () => {
    // 直接构造一个指向不存在二进制的引擎：走服务层，避免为此再起一整套运行时。
    const service = new AutoChatService(
      runtime.repository,
      {} as never,
      {} as never,
      undefined,
      undefined,
      new CliEngine({ binary: path.join(directory, "no-such-codebuddy"), workspacePath: directory })
    );
    const status = await service.cliStatus(true);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("未找到可执行文件");

    // 已经是 rules 的引擎 → 切到 cli 会被挡下；而其它字段照常可改（不会因为 CLI 掉线就改不了配置）。
    await putSettings({ enabled: true, mode: "draft", accountId: null, engine: "rules", profileId: profile.id }).expect(200);
    await expect(service.updateSettings("test-user", { enabled: true, mode: "draft", engine: "cli" }))
      .rejects.toThrow(/本机 CLI 当前不可用/u);
    const kept = await service.updateSettings("test-user", { enabled: true, mode: "draft", dailyLimit: 7 });
    expect(kept).toMatchObject({ engine: "rules", dailyLimit: 7 });
  }, 30_000);

  it("自动回复关掉后不再生成任何草稿", async () => {
    await quietAutoChat();
    setCli("ok", { reply: "should-not-be-used", confidence: 0.99, reason: "x", language: "en" });
    const message = await inbound("+8613900000309", "Are you still there?");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const drafts = await listDrafts();
    expect(drafts.some((draft) => draft.inboundMessageId === message.id)).toBe(false);
  });
});
