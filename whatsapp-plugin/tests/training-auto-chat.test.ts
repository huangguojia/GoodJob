import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AiProviderProfile,
  AutoChatDraft,
  AutoChatSettings,
  ChannelAccount,
  ChatMessage,
  Conversation,
  TrainingProfile
} from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { inMemoryDatabasePaths } from "./helpers/test-database";
import { createDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";
import { AutomationRhythmService } from "../src/server/services/automation-rhythm";
import type { ConversationIntelligenceService } from "../src/server/services/conversation-intelligence";
import { bindPersistentTestServer, closePersistentTestServer } from "./helpers/persistent-server";

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 聊天记录训练 + 自动聊的端到端回测。
 *
 * 用例是按顺序推进的一条完整业务链：导出 → 训练 → 配置自动聊 → 生成草稿 →
 * 人工确认发送 → 护栏拦截 → 真发。共享同一个运行时，因此断言要针对具体对象，
 * 不要依赖「本轮一共处理了几个候选」这类全局计数。
 */
describe("Chat history training and auto chat", () => {
  let runtime: AppRuntime;
  let accounts: ChannelAccount[];
  let europe: ChannelAccount;
  let sofiaConversation: Conversation;
  /** 持久监听：见 tests/helpers/persistent-server.ts（supertest 默认每请求 listen(0)+close()）。 */
  let httpServer: Server;

  /** 所有请求都走这个已经监听的 server，避免上百次临时端口绑定造成随机 socket hang up。 */
  const api = () => request(httpServer);

  let aiServer: Server;
  let aiBaseUrl = "";
  let aiContent = "";
  let aiStatus = 200;
  let aiCalls = 0;

  const aiServerHandler = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    aiCalls += 1;
    outgoing.setHeader("content-type", "application/json");
    if (incoming.method !== "POST") {
      outgoing.statusCode = 404;
      outgoing.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }
    await readBody(incoming);
    if (aiStatus !== 200) {
      outgoing.statusCode = aiStatus;
      outgoing.end(JSON.stringify({ error: { message: "mock AI failure" } }));
      return;
    }
    outgoing.end(JSON.stringify({ choices: [{ message: { content: aiContent } }], usage: { total_tokens: 42 } }));
  };

  beforeAll(async () => {
    aiServer = createServer((incoming, outgoing) => {
      void aiServerHandler(incoming, outgoing);
    });
    await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", () => resolve()));
    const address = aiServer.address();
    aiBaseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;

    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-training-"));
    const config = {
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(directory),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: true,
      allowPrivateAiEndpoints: true,
      // 本文件测的是「话术库 / AI Provider」两条通道：显式把本机 CLI 指向一个不存在的路径。
      // 不这么做的话，开发机上只要装了 codebuddy，`engine: auto` 就会自动切到 CLI，
      // 断言全变（而且测试会真的去起 CLI 子进程，慢且依赖登录态）。
      cliBinary: path.join(directory, "no-such-codebuddy"),
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
    accounts = (await api().get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
    europe = accounts.find((account) => account.name === "欧洲销售")!;
    const conversations = (await api().get("/api/v1/conversations").expect(200)).body as Conversation[];
    sofiaConversation = conversations.find((conversation) => conversation.contactName === "Sofia Martinez")!;
  }, 60_000);

  afterAll(async () => {
    await closePersistentTestServer(httpServer);
    await runtime.close();
    await new Promise<void>((resolve) => aiServer.close(() => resolve()));
  });

  const listDrafts = async (query = "limit=100"): Promise<AutoChatDraft[]> =>
    (await api().get(`/api/v1/auto-chat/drafts?${query}`).expect(200)).body as AutoChatDraft[];

  const putSettings = (body: Record<string, unknown>) =>
    api().put("/api/v1/auto-chat/settings").send(body);

  /** 直接改库把自动聊关掉，避免上一条入站消息触发异步草稿生成。 */
  const quietAutoChat = async (): Promise<void> => {
    await putSettings({ enabled: false, mode: "off", accountId: null }).expect(200);
  };

  /** 造一条新的入站消息，返回它落在哪个会话。 */
  const inbound = async (phone: string, body: string): Promise<ChatMessage> => {
    const response = await api()
      .post("/api/v1/demo/inbound")
      .send({ accountId: europe.id, displayName: `自动聊客户 ${phone.slice(-4)}`, phone, body })
      .expect(201);
    return response.body as ChatMessage;
  };

  /** 入站钩子是异步的：轮询到草稿出现（或满足给定条件）为止。 */
  const waitForDraft = async (
    conversationId: string,
    predicate: (draft: AutoChatDraft) => boolean = () => true
  ): Promise<AutoChatDraft> => {
    // 用「截止时间」而不是「固定尝试次数」：入站钩子是 fire-and-forget 的，草稿多久出现
    // 取决于机器负载，固定 6 秒窗口在负载高时会假失败。15 秒刻意留在 20 秒 testTimeout 里，
    // 这样超时时报的是下面这句清楚的话，而不是含糊的「Test timed out」。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = (await listDrafts()).find((draft) => draft.conversationId === conversationId && predicate(draft));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("等待自动聊草稿超时");
  };

  const outboundBodies = async (conversationId: string): Promise<string[]> => {
    const messages = (await api().get(`/api/v1/conversations/${conversationId}/messages`).expect(200)).body as ChatMessage[];
    return messages.filter((message) => message.direction === "outbound").map((message) => message.body);
  };

  // ------------------------------------------------------------ 导出 ------

  describe("聊天记录导出", () => {
    it("默认导出 JSONL，逐行都是可解析的会话记录", async () => {
      const response = await api().post("/api/v1/training/export").send({ format: "jsonl" }).expect(200);
      expect(response.body).toMatchObject({
        format: "jsonl",
        conversationCount: 3,
        messageCount: 4,
        exchangeCount: 1,
        skippedConversations: 0
      });
      expect(response.body.fileName).toMatch(/^goodjob-whatsapp-训练数据-\d{8}-\d{4}\.jsonl$/u);
      expect(response.body.characters).toBeGreaterThan(0);
      expect(response.body.sample.length).toBeGreaterThan(0);
      expect(response.body.sample[0]).toMatchObject({
        role: expect.stringMatching(/^(customer|agent)$/u),
        body: expect.any(String),
        at: expect.any(String)
      });

      const lines = (response.body.content as string).split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      const parsed = lines.map((line) => JSON.parse(line) as { conversationId: string; messages: Array<{ role: string; content: string }> });
      expect(parsed.every((record) => typeof record.conversationId === "string")).toBe(true);
      expect(parsed.flatMap((record) => record.messages).some((message) => message.role === "agent")).toBe(true);
    });

    it("json 与 txt 两种格式产出不同的结构", async () => {
      const asJson = await api().post("/api/v1/training/export").send({ format: "json" }).expect(200);
      const jsonBody = JSON.parse(asJson.body.content as string) as { generatedAt: string; records: unknown[] };
      expect(jsonBody.generatedAt).toEqual(expect.any(String));
      expect(jsonBody.records).toHaveLength(3);

      const asText = await api().post("/api/v1/training/export").send({ format: "txt" }).expect(200);
      const textContent = asText.body.content as string;
      expect(asText.body.fileName).toMatch(/\.txt$/u);
      expect(textContent).toContain("# Sofia Martinez (+34612140788)");
      expect(textContent).toMatch(/\[\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}\] Sofia Martinez: /u);
      expect(textContent).toContain("我方: Thanks, Sofia.");
    });

    it("时间范围非法或范围内没有消息时给出明确的业务错误", async () => {
      const invalid = await api()
        .post("/api/v1/training/export")
        .send({ format: "jsonl", from: "2026-01-02", to: "2026-01-01" })
        .expect(400);
      expect(invalid.body).toMatchObject({ code: "TRAINING_RANGE_INVALID" });

      const empty = await api()
        .post("/api/v1/training/export")
        .send({ format: "jsonl", from: "2000-01-01", to: "2000-01-02" })
        .expect(422);
      expect(empty.body).toMatchObject({ code: "TRAINING_NO_DATA" });
    });

    it("按账号导出的范围会被收窄", async () => {
      const response = await api()
        .post("/api/v1/training/export")
        .send({ format: "jsonl", accountId: europe.id })
        .expect(200);
      expect(response.body.conversationCount).toBe(2);
      expect(response.body.messageCount).toBe(3);
    });
  });

  // ------------------------------------------------------------ 训练 ------

  let profile: TrainingProfile;

  describe("训练回复风格档案", () => {
    it("用规则引擎训练出一个可用档案，包含语气、写作规则与安全护栏", async () => {
      const response = await api()
        .post("/api/v1/training/profiles")
        .send({ name: "欧洲客户话术", useAi: false })
        .expect(201);
      profile = response.body as TrainingProfile;

      expect(profile.id).toMatch(/^trn_[0-9a-f]{16}$/u);
      expect(profile).toMatchObject({
        ownerUserId: "test-user",
        name: "欧洲客户话术",
        status: "ready",
        engine: "rules",
        model: null,
        conversationCount: 3,
        messageCount: 4,
        exchangeCount: 1,
        sampleCount: 1,
        tone: "简短直接",
        error: null
      });
      expect(profile.languages).toEqual(expect.arrayContaining(["es", "en"]));
      expect(profile.guidelines.length).toBeGreaterThanOrEqual(4);
      expect(profile.guidelines.join(" ")).toContain("回复长度参考训练样本");
      expect(profile.guardrails).toHaveLength(5);
      expect(profile.guardrails.join(" ")).toContain("不编造公司资质");
      expect(profile.summary).toContain("基于 3 个会话、4 条消息、1 组问答提炼");
      expect(profile.examples).toHaveLength(1);
      expect(profile.examples[0]).toMatchObject({
        conversationId: sofiaConversation.id,
        inbound: "Hola, nos interesan 500 unidades. ¿Podrían compartir el precio FOB?",
        reply: "Thanks, Sofia. I will prepare the quotation today."
      });
      expect(profile.sourceFrom).toEqual(expect.any(String));
      expect(profile.sourceTo).toEqual(expect.any(String));
    });

    it("档案可被列出并按 id 读取，不存在的 id 返回 404", async () => {
      const list = (await api().get("/api/v1/training/profiles").expect(200)).body as TrainingProfile[];
      expect(list.map((item) => item.id)).toContain(profile.id);

      const single = (await api().get(`/api/v1/training/profiles/${profile.id}`).expect(200)).body as TrainingProfile;
      expect(single).toEqual(profile);

      const missing = await api().get("/api/v1/training/profiles/trn_0000000000000000").expect(404);
      expect(missing.body).toMatchObject({ code: "TRAINING_PROFILE_NOT_FOUND" });
    });

    it("空名字被拒绝", async () => {
      const response = await api().post("/api/v1/training/profiles").send({ name: "   ", useAi: false }).expect(400);
      expect(response.body.code).toBeTruthy();
    });
  });

  // ---------------------------------------------------------- 自动聊 ------

  describe("自动聊配置", () => {
    it("默认关闭，并带上出厂安全护栏与升级关键词", async () => {
      const settings = (await api().get("/api/v1/auto-chat/settings").expect(200)).body as AutoChatSettings;
      expect(settings).toMatchObject({
        accountId: null,
        enabled: false,
        mode: "off",
        profileId: null,
        providerId: null,
        language: "auto",
        dailyLimit: 40,
        minIntervalMinutes: 5,
        activeHoursStart: 8,
        activeHoursEnd: 22,
        timezone: "Asia/Shanghai",
        confidenceThreshold: 0.6
      });
      expect(settings.guardrails).toHaveLength(5);
      expect(settings.escalateKeywords).toEqual(
        expect.arrayContaining(["投诉", "退款", "complaint", "refund"])
      );
    });

    it("没有选训练档案就不能开启", async () => {
      const response = await putSettings({ enabled: true, mode: "draft", accountId: null }).expect(409);
      expect(response.body).toMatchObject({ code: "TRAINING_PROFILE_REQUIRED" });
    });

    it("引用了不存在的训练档案或 AI Provider 都会被拒绝", async () => {
      const badProfile = await putSettings({ enabled: true, mode: "draft", accountId: null, profileId: "trn_0000000000000000" }).expect(404);
      expect(badProfile.body).toMatchObject({ code: "TRAINING_PROFILE_NOT_FOUND" });

      const badProvider = await putSettings({
        enabled: true,
        mode: "draft",
        accountId: null,
        profileId: profile.id,
        providerId: "00000000-0000-4000-8000-000000000000"
      }).expect(404);
      expect(badProvider.body).toMatchObject({ code: "AI_PROVIDER_NOT_FOUND" });
    });

    it("保存设置后能读回，enabled=false 时模式被强制回落为 off", async () => {
      const saved = (await putSettings({
        enabled: true,
        mode: "draft",
        accountId: null,
        profileId: profile.id,
        dailyLimit: 25,
        activeHoursStart: 0,
        activeHoursEnd: 0,
        minIntervalMinutes: 0
      }).expect(200)).body as AutoChatSettings;
      expect(saved).toMatchObject({ enabled: true, mode: "draft", profileId: profile.id, dailyLimit: 25 });

      const reread = (await api().get("/api/v1/auto-chat/settings").expect(200)).body as AutoChatSettings;
      expect(reread).toMatchObject({ enabled: true, mode: "draft", profileId: profile.id });

      const disabled = (await putSettings({ enabled: false, mode: "auto", accountId: null }).expect(200)).body as AutoChatSettings;
      expect(disabled).toMatchObject({ enabled: false, mode: "off", profileId: profile.id });
    });
  });

  describe("自动聊草稿", () => {
    it("draft 模式下生成待确认草稿，绝不自动发送", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000101", "Hola, nos interesan 200 unidades. ¿Podrían compartir el precio FOB?");
      await putSettings({
        enabled: true,
        mode: "draft",
        accountId: null,
        profileId: profile.id,
        providerId: null,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        activeHoursStart: 0,
        activeHoursEnd: 0
      }).expect(200);

      const summary = (await api().post("/api/v1/auto-chat/run").send({}).expect(200)).body as {
        scanned: number;
        drafted: number;
        sent: number;
        failed: number;
      };
      expect(summary.scanned).toBeGreaterThan(0);
      expect(summary.sent).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.drafted).toBeGreaterThan(0);

      const drafts = (await listDrafts()).filter((draft) => draft.conversationId === message.conversationId);
      expect(drafts).toHaveLength(1);
      const [draft] = drafts;
      expect(draft).toMatchObject({
        status: "pending",
        mode: "draft",
        engine: "rules",
        model: null,
        profileId: profile.id,
        messageId: null,
        sentAt: null,
        inboundBody: "Hola, nos interesan 200 unidades. ¿Podrían compartir el precio FOB?"
      });
      // 与训练样本高度相似 → 规则引擎给出可用的参考回复；draft 模式下任何情况下都不自动发送。
      expect(draft.body).toBe("Thanks, Sofia. I will prepare the quotation today.");
      // 来源必须能区分「训练库」与「训练档案话术库」：两者可信度不同，看到来源才知道该去哪改口径。
      expect(draft.reason).toContain("训练档案话术库");
      expect(draft.reason).toContain("未配置 AI Provider");
      expect(draft.reason).toContain("draft 模式只生成草稿");
      expect(draft.confidence).toBeGreaterThanOrEqual(0.6);
      expect(await outboundBodies(message.conversationId)).toHaveLength(0);
    });

    it("同一轮重复运行不会重复生成草稿", async () => {
      const before = (await listDrafts()).length;
      await api().post("/api/v1/auto-chat/run").send({}).expect(200);
      expect((await listDrafts()).length).toBe(before);
    });

    it("人工确认后能真正发出，并保持幂等", async () => {
      const [pending] = (await listDrafts("status=pending")).filter((draft) => draft.body.length > 0);
      const sent = (await api().post(`/api/v1/auto-chat/drafts/${pending.id}/send`).send({}).expect(200)).body as AutoChatDraft;
      expect(sent).toMatchObject({ status: "sent", messageId: expect.any(String), sentAt: expect.any(String), edited: false });
      expect(await outboundBodies(pending.conversationId)).toContain(pending.body);

      const again = (await api().post(`/api/v1/auto-chat/drafts/${pending.id}/send`).send({}).expect(200)).body as AutoChatDraft;
      expect(again.status).toBe("sent");
      expect(again.messageId).toBe(sent.messageId);
      expect((await outboundBodies(pending.conversationId)).filter((body) => body === pending.body)).toHaveLength(1);
    });

    it("人工改写后再发送会被标记 edited", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000102", "Hola, nos interesan 150 unidades. ¿Podrían compartir el precio FOB?");
      await putSettings({
        enabled: true,
        mode: "draft",
        accountId: null,
        profileId: profile.id,
        providerId: null,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        activeHoursStart: 0,
        activeHoursEnd: 0
      }).expect(200);
      await api().post("/api/v1/auto-chat/run").send({}).expect(200);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      const edited = (await api()
        .post(`/api/v1/auto-chat/drafts/${draft.id}/send`)
        .send({ body: "Hola, gracias por escribir. Le confirmo la disponibilidad hoy mismo." })
        .expect(200)).body as AutoChatDraft;
      expect(edited).toMatchObject({ status: "sent", edited: true, body: "Hola, gracias por escribir. Le confirmo la disponibilidad hoy mismo." });
      expect(await outboundBodies(message.conversationId)).toContain(edited.body);
    });

    it("丢弃草稿后状态变为 dismissed，且不再出现在待确认列表", async () => {
      const [pending] = await listDrafts("status=pending");
      const dismissed = (await api().post(`/api/v1/auto-chat/drafts/${pending.id}/dismiss`).send({}).expect(200)).body as AutoChatDraft;
      expect(dismissed.status).toBe("dismissed");
      expect((await listDrafts("status=pending")).map((draft) => draft.id)).not.toContain(pending.id);
    });

    it("凭空捏造的草稿 id 返回 404", async () => {
      const response = await api()
        .post("/api/v1/auto-chat/drafts/00000000-0000-4000-8000-000000000000/send")
        .send({})
        .expect(404);
      expect(response.body).toMatchObject({ code: "AUTO_CHAT_DRAFT_NOT_FOUND" });
    });
  });

  describe("自动聊安全闸门", () => {
    it("命中升级关键词的直接转人工，不生成回复", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000103", "你们的产品有问题，我要投诉并要求退款！");
      await putSettings({
        enabled: true,
        mode: "auto",
        accountId: null,
        profileId: profile.id,
        providerId: null,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        activeHoursStart: 0,
        activeHoursEnd: 0
      }).expect(200);
      await api().post("/api/v1/auto-chat/run").send({}).expect(200);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      expect(draft).toMatchObject({ status: "skipped", body: "", confidence: 0, messageId: null });
      expect(draft.reason).toContain("命中升级关键词");
      expect(draft.reason).toContain("投诉");
      expect(await outboundBodies(message.conversationId)).toHaveLength(0);
    });

    it("不在活跃时段时跳过", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000104", "Could you share your catalogue?");
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(new Date()));
      await putSettings({
        enabled: true,
        mode: "auto",
        accountId: null,
        profileId: profile.id,
        providerId: null,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        timezone: "Asia/Shanghai",
        activeHoursStart: (hour + 1) % 24,
        activeHoursEnd: (hour + 2) % 24
      }).expect(200);
      await api().post("/api/v1/auto-chat/run").send({}).expect(200);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      expect(draft.status).toBe("skipped");
      expect(draft.reason).toContain("不在活跃时段");
      expect(await outboundBodies(message.conversationId)).toHaveLength(0);
    });

    it("账号维度没有单独设置时回落到全局设置（入站自动触发才会生效）", async () => {
      await quietAutoChat();
      await putSettings({
        enabled: true,
        mode: "draft",
        accountId: null,
        profileId: profile.id,
        providerId: null,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        activeHoursStart: 0,
        activeHoursEnd: 0
      }).expect(200);

      // 界面上「全部账号」= 全局行；入站钩子只拿得到账号 id，必须能回落到全局行。
      const scoped = (await api().get(`/api/v1/auto-chat/settings?accountId=${europe.id}`).expect(200)).body as AutoChatSettings;
      expect(scoped).toMatchObject({ enabled: true, mode: "draft", profileId: profile.id });

      const message = await inbound("+8613900000105", "Hola, nos interesan 900 unidades. ¿Podrían compartir el precio FOB?");
      // 这里刻意不调 runNow：验证的是入站消息自身的异步触发链路。
      const draft = await waitForDraft(message.conversationId);
      expect(draft).toMatchObject({ accountId: europe.id, status: "pending", mode: "draft" });
      expect(draft.body.length).toBeGreaterThan(0);
    });
  });

  describe("自动聊对接 AI", () => {
    let provider: AiProviderProfile;

    beforeAll(async () => {
      provider = (await api()
        .post("/api/v1/ai/providers")
        .send({ name: "回测用 AI", baseUrl: aiBaseUrl, apiKey: "sk-backtest-0001", model: "mock-reply-model" })
        .expect(201)).body as AiProviderProfile;
    });

    const enableAuto = async (overrides: Record<string, unknown> = {}): Promise<AutoChatSettings> =>
      (await putSettings({
        enabled: true,
        mode: "auto",
        accountId: null,
        profileId: profile.id,
        providerId: provider.id,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        activeHoursStart: 0,
        activeHoursEnd: 0,
        confidenceThreshold: 0,
        ...overrides
      }).expect(200)).body as AutoChatSettings;

    it("AI 给出的回复带明确报价时被护栏拦下，保持待确认", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000106", "Please quote 500 units FOB Shanghai.");
      await enableAuto({ confidenceThreshold: 0 });
      aiStatus = 200;
      aiContent = JSON.stringify({ reply: "Sure, the FOB price is USD 1,200 per unit.", confidence: 0.99, reason: "直接报价", language: "en" });

      await api().post("/api/v1/auto-chat/run").send({}).expect(200);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      expect(draft).toMatchObject({ status: "pending", engine: "ai", messageId: null, sentAt: null });
      expect(draft.reason).toContain("可能触碰护栏");
      expect(draft.error).toContain("可能触碰护栏");
      expect(await outboundBodies(message.conversationId)).toHaveLength(0);
    });

    it("AI 置信度达标且不触碰护栏时自动发出", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000107", "When can you ship the order?");
      await enableAuto({ confidenceThreshold: 0.6 });
      aiStatus = 200;
      aiContent = JSON.stringify({ reply: "Thanks for reaching out. We can usually ship within three weeks.", confidence: 0.92, reason: "常规交期回答", language: "en" });

      await api().post("/api/v1/auto-chat/run").send({}).expect(200);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      expect(draft).toMatchObject({ status: "sent", engine: "ai", model: "mock-reply-model", profileId: profile.id });
      expect(draft.messageId).toEqual(expect.any(String));
      expect(draft.confidence).toBeCloseTo(0.92, 5);
      expect(await outboundBodies(message.conversationId)).toEqual(["Thanks for reaching out. We can usually ship within three weeks."]);
    });

    it("置信度低于门槛时只留草稿，不发送", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000108", "Can you customise the packaging size?");
      await enableAuto({ confidenceThreshold: 0.8 });
      aiStatus = 200;
      aiContent = JSON.stringify({ reply: "Let me check with the factory and get back to you.", confidence: 0.35, reason: "信息不足", language: "en" });

      await api().post("/api/v1/auto-chat/run").send({}).expect(200);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      expect(draft).toMatchObject({ status: "pending", engine: "ai", messageId: null });
      expect(draft.reason).toContain("置信度 0.35");
      expect(draft.reason).toContain("门槛 0.80");
      expect(await outboundBodies(message.conversationId)).toHaveLength(0);
    });

    it("AI 调用失败时降级为模板草稿并禁止自动发送", async () => {
      await quietAutoChat();
      const message = await inbound("+8613900000109", "Hola, nos interesan 700 unidades. ¿Podrían compartir el precio FOB?");
      await enableAuto({ confidenceThreshold: 0 });
      aiStatus = 500;

      const callsBefore = aiCalls;
      await api().post("/api/v1/auto-chat/run").send({}).expect(200);
      aiStatus = 200;
      expect(aiCalls).toBeGreaterThan(callsBefore);

      const draft = (await listDrafts()).find((item) => item.conversationId === message.conversationId)!;
      expect(draft).toMatchObject({ status: "pending", engine: "rules", messageId: null });
      expect(draft.reason).toContain("AI 生成失败已降级为模板回复");
      expect(draft.body).toBe("Thanks, Sofia. I will prepare the quotation today.");
      expect(await outboundBodies(message.conversationId)).toHaveLength(0);
    });
  });

  describe("训练档案与自动聊设置的联动", () => {
    it("删除被引用的训练档案会先解除引用，设置不再挂着一个死档案", async () => {
      await putSettings({
        enabled: true,
        mode: "draft",
        accountId: null,
        profileId: profile.id,
        providerId: null,
        activeHoursStart: 0,
        activeHoursEnd: 0,
        minIntervalMinutes: 0,
        dailyLimit: 0
      }).expect(200);

      await api().delete(`/api/v1/training/profiles/${profile.id}`).expect(204);

      const settings = (await api().get("/api/v1/auto-chat/settings").expect(200)).body as AutoChatSettings;
      expect(settings.profileId).toBeNull();
      expect((await api().get("/api/v1/training/profiles").expect(200)).body).toEqual([]);
      await api().delete(`/api/v1/training/profiles/${profile.id}`).expect(404);
    });
  });

  // --------------------------------------------- 文字 / 图片 / 文件 ------

  describe("文字、图片、文件都能真正发出", () => {
    it("文字消息走统一的消息接口", async () => {
      const message = (await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/messages`)
        .send({ accountId: europe.id, clientMessageId: "verify-text-0001", body: "Hello, this is a text message." })
        .expect(201)).body as ChatMessage;
      expect(message).toMatchObject({ direction: "outbound", messageType: "text", body: "Hello, this is a text message." });
      expect(await outboundBodies(sofiaConversation.id)).toContain("Hello, this is a text message.");
    });

    it("图片与文件走媒体接口并落库为对应的消息类型", async () => {
      const image = (await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/media?accountId=${europe.id}&clientMessageId=verify-image-0001&kind=image&fileName=pricing-table.png&mimeType=image/png&caption=Here is our price list`)
        .set("content-type", "application/octet-stream")
        .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        .expect(201)).body as ChatMessage;
      expect(image).toMatchObject({
        direction: "outbound",
        messageType: "image",
        body: "Here is our price list",
        media: { fileName: "pricing-table.png", mimeType: "image/png", sizeBytes: 8, available: false }
      });

      const file = (await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/media?accountId=${europe.id}&clientMessageId=verify-file-0001&kind=file&fileName=quotation.pdf&mimeType=application/pdf`)
        .set("content-type", "application/octet-stream")
        .send(Buffer.from("%PDF-1.7 mock"))
        .expect(201)).body as ChatMessage;
      expect(file).toMatchObject({
        direction: "outbound",
        messageType: "file",
        body: "quotation.pdf",
        media: { fileName: "quotation.pdf", mimeType: "application/pdf", available: false }
      });
    });

    it("媒体类型与声明不符时提前拦下", async () => {
      const mismatch = await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/media?accountId=${europe.id}&clientMessageId=verify-bad-0001&kind=image&fileName=notes.txt&mimeType=text/plain`)
        .set("content-type", "application/octet-stream")
        .send(Buffer.from("not an image"))
        .expect(400);
      expect(mismatch.body).toMatchObject({ code: "MEDIA_TYPE_INVALID" });

      const wrongKind = await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/media?accountId=${europe.id}&clientMessageId=verify-bad-0002&kind=video&fileName=clip.png&mimeType=image/png`)
        .set("content-type", "application/octet-stream")
        .send(Buffer.from("still an image"))
        .expect(400);
      expect(wrongKind.body).toMatchObject({ code: "MEDIA_TYPE_INVALID" });
    });

    it("同一个 clientMessageId 重复提交不会重复发送", async () => {
      const payload = Buffer.from("idempotent-media");
      const query = `accountId=${europe.id}&clientMessageId=verify-idem-0001&kind=file&fileName=spec.pdf&mimeType=application/pdf`;
      const first = (await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/media?${query}`)
        .set("content-type", "application/octet-stream")
        .send(payload)
        .expect(201)).body as ChatMessage;
      const second = (await api()
        .post(`/api/v1/conversations/${sofiaConversation.id}/media?${query}`)
        .set("content-type", "application/octet-stream")
        .send(payload)
        .expect(201)).body as ChatMessage;
      expect(second.id).toBe(first.id);
      const messages = (await api().get(`/api/v1/conversations/${sofiaConversation.id}/messages`).expect(200)).body as ChatMessage[];
      expect(messages.filter((message) => message.clientMessageId === "verify-idem-0001")).toHaveLength(1);
    });
  });

  // ------------------------------------- 中文话术训练 + 自动回复 ------

  /**
   * 中文自动回复的回测。
   *
   * 中文没有词边界，旧实现按空格切词会把整句变成一个 token，等于中文检索永远失配 ——
   * 这一组用例专门盯住「训练出来的中文话术能不能在客户用中文追问时自动发出去」。
   */
  describe("中文聊天记录训练后能真正自动回复", () => {
    /** 与后端 MAX_RULE_CONFIDENCE 对齐：话术库匹配的置信度上限。 */
    const RULE_CONFIDENCE_CAP = 0.9;
    const MOQ_QUESTION = "你们的最小起订量是多少？";
    const MOQ_REPLY = "我们的最小起订量是每个型号 500 件。";

    let chineseProfile: TrainingProfile;

    /** 造一组「客户问 → 我方答」的中文记录，返回会话 id。 */
    const seedExchange = async (phone: string, question: string, reply: string, clientMessageId: string): Promise<string> => {
      const message = await inbound(phone, question);
      await api()
        .post(`/api/v1/conversations/${message.conversationId}/messages`)
        .send({ accountId: europe.id, clientMessageId, body: reply })
        .expect(201);
      return message.conversationId;
    };

    const trainOn = async (name: string, conversationId: string): Promise<TrainingProfile> =>
      (await api()
        .post("/api/v1/training/profiles")
        .send({ name, useAi: false, conversationIds: [conversationId] })
        .expect(201)).body as TrainingProfile;

    /** 不用 AI Provider 的强模式：命中话术库且过门槛就真的发出去。 */
    const enableAutoReply = async (profileId: string, overrides: Record<string, unknown> = {}): Promise<void> => {
      await putSettings({
        enabled: true,
        mode: "auto",
        accountId: null,
        profileId,
        providerId: null,
        dailyLimit: 0,
        minIntervalMinutes: 0,
        activeHoursStart: 0,
        activeHoursEnd: 0,
        confidenceThreshold: 0.6,
        ...overrides
      }).expect(200);
    };

    const outboundCount = async (conversationId: string): Promise<number> => {
      const messages = (await api().get(`/api/v1/conversations/${conversationId}/messages`).expect(200)).body as ChatMessage[];
      return messages.filter((message) => message.direction === "outbound").length;
    };

    /** 本轮针对「这一条入站消息」生成的草稿（同一会话会有多条历史草稿）。 */
    const draftFor = async (conversationId: string, inboundBody: string): Promise<AutoChatDraft> =>
      waitForDraft(conversationId, (draft) => draft.inboundBody === inboundBody);

    it("中文问答能训练成话术样板", async () => {
      await quietAutoChat();
      const conversationId = await seedExchange("+8613900000201", MOQ_QUESTION, MOQ_REPLY, "zh-moq-reply-0001");
      chineseProfile = await trainOn("中文最小起订量话术", conversationId);

      expect(chineseProfile).toMatchObject({ status: "ready", engine: "rules", conversationCount: 1, exchangeCount: 1, sampleCount: 1 });
      expect(chineseProfile.examples).toHaveLength(1);
      expect(chineseProfile.examples[0]).toMatchObject({ inbound: MOQ_QUESTION, reply: MOQ_REPLY });
    });

    it("中文相近问法在未配置 AI Provider 的 auto 模式下真的自动发出", async () => {
      await enableAutoReply(chineseProfile.id);
      const message = await inbound("+8613900000203", "你好，请问最小起订量是多少呢？");

      const draft = await draftFor(message.conversationId, message.body);
      expect(draft).toMatchObject({
        status: "sent",
        mode: "auto",
        engine: "rules",
        model: null,
        profileId: chineseProfile.id,
        body: MOQ_REPLY
      });
      expect(draft.messageId).toEqual(expect.any(String));
      expect(draft.sentAt).toEqual(expect.any(String));
      expect(draft.confidence).toBeGreaterThanOrEqual(0.6);
      expect(draft.confidence).toBeLessThanOrEqual(RULE_CONFIDENCE_CAP);
      expect(draft.reason).toContain("训练档案话术库");
      expect(draft.reason).toContain("未配置 AI Provider");

      // 真的落成了一条我方发出的消息，而不是只有草稿状态。
      const sent = (await api().get(`/api/v1/conversations/${message.conversationId}/messages`).expect(200)).body as ChatMessage[];
      expect(sent.some((item) => item.id === draft.messageId && item.direction === "outbound" && item.body === MOQ_REPLY)).toBe(true);
      expect(await outboundCount(message.conversationId)).toBe(1);
    });

    it("门槛高于话术库置信度上限时只留草稿", async () => {
      await enableAutoReply(chineseProfile.id, { confidenceThreshold: 0.95 });
      const message = await inbound("+8613900000204", "请问你们最小起订量多少？");

      const draft = await draftFor(message.conversationId, message.body);
      expect(draft).toMatchObject({ status: "pending", engine: "rules", messageId: null, sentAt: null });
      expect(draft.confidence).toBeLessThan(0.95);
      expect(draft.reason).toContain("未达门槛只留草稿");
      expect(await outboundCount(message.conversationId)).toBe(0);
    });

    it("话术库里没有相近问法时不硬回，留一条请人工处理的草稿", async () => {
      await enableAutoReply(chineseProfile.id);
      const message = await inbound("+8613900000205", "Where is your factory located?");

      const draft = await draftFor(message.conversationId, message.body);
      expect(draft).toMatchObject({ status: "pending", engine: "rules", body: "", confidence: 0.1, messageId: null });
      expect(draft.reason).toContain("没有相近问法");
      expect(draft.error).toContain("没有相近问法");
      expect(await outboundCount(message.conversationId)).toBe(0);
    });

    it("入站钩子漏掉时，每分钟的兜底扫描会把这条回复补上", async () => {
      // 自动聊关着的时候收到消息 → 不会有任何回复，等价于「入站事件丢了」。
      await quietAutoChat();
      const message = await inbound("+8613900000206", "麻烦告知一下你们的最小起订量数字");
      expect(await outboundCount(message.conversationId)).toBe(0);

      await enableAutoReply(chineseProfile.id);
      await runtime.autoChat.sweepOwner("test-user");

      const draft = await draftFor(message.conversationId, message.body);
      expect(draft).toMatchObject({ status: "sent", mode: "auto", body: MOQ_REPLY });
      expect(await outboundCount(message.conversationId)).toBe(1);
    });

    it("命中的话术样板自带报价时，同样被护栏拦下不自动发送", async () => {
      await quietAutoChat();
      const pricingConversationId = await seedExchange("+8613900000202", "500 件的报价是多少？", "FOB 上海 USD 12 / 件。", "zh-price-reply-0001");
      const pricingProfile = await trainOn("中文报价话术", pricingConversationId);
      expect(pricingProfile.examples[0]?.reply).toContain("USD 12");

      await enableAutoReply(pricingProfile.id);
      const message = await inbound("+8613900000202", "那 500 件的报价是多少呢？");

      const draft = await draftFor(message.conversationId, message.body);
      expect(draft).toMatchObject({ status: "pending", engine: "rules", messageId: null });
      expect(draft.reason).toContain("可能触碰护栏");
      expect(draft.body).toContain("USD 12");
      expect(await outboundCount(message.conversationId)).toBe(1);
    });
  });

  // ------------------------------------------- 定时兜底接线 ------

  describe("自动回复的定时兜底接线", () => {
    it("每轮 tick 都会先跑兜底钩子，且不依赖 CRM 是否可达", async () => {
      const seen: string[] = [];
      const rhythm = new AutomationRhythmService(
        { listAccounts: async () => [{ ownerUserId: "owner-a" }, { ownerUserId: null }] } as unknown as Repository,
        {} as unknown as ConversationIntelligenceService,
        "http://127.0.0.1:1"
      );
      rhythm.setOwnerTick(async (ownerUserId) => {
        seen.push(ownerUserId);
      });
      try {
        await rhythm.start();
      } finally {
        await rhythm.close();
      }
      // 只带 owner 的账号被去重后跑一次；没有 owner 的账号不参与。
      expect(seen).toEqual(["owner-a"]);
    });
  });
});
