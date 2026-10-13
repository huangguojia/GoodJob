import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AutoChatDraft } from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { createDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";
import { inMemoryDatabasePaths } from "./helpers/test-database";
import { bindPersistentTestServer, closePersistentTestServer } from "./helpers/persistent-server";

/**
 * 「拿一段现场对话换一条草稿」的端到端回测。
 *
 * 两个假件，各顶一头：
 * - **假 CRM**：一个真的 HTTP 服务，会校验插件自签的 JWT。它断言的是「确实按 owner 的身份去读了
 *   这个客户的档案/报价/知识」，而不只是「代码里调了个函数」。
 * - **假 CLI**：把提示词里有没有出现四个 CRM 标记**回读**出来当回复。这是这条链路唯一能证明
 *   「CRM 依据真的进了提示词」的办法 —— 否则单测只能断言到"拼字符串的函数返回了什么"，
 *   而断不到"跑起来之后模型到底看见了什么"。
 */

const SECRET = "compose-test-crm-secret";
const OWNER = "test-user";

const COMPANY_MARKER = "ACME-MARKER GmbH";
const ACTIVITY_MARKER = "renewal follow-up marker";
const QUOTE_MARKER = "PI-2026-0042";
const KNOWLEDGE_MARKER = "MOQ-KB-MARKER";

const CRM_CUSTOMERS = {
  customers: [
    {
      id: "cust-compose-1",
      company: COMPANY_MARKER,
      contact: "Ann Weber",
      country: "DE",
      whatsapp: "+491234567890",
      stage: "询盘",
      grade: "A",
      ownerName: "张三",
      lifecycleStatus: "open",
      pipelineStage: "报价",
      pipelineAmount: 12000,
      activeDealCount: 1,
      wonDealCount: 1,
      lastActivityAt: "2026-10-01T08:00:00.000Z",
      activities: [
        { type: "whatsapp", content: ACTIVITY_MARKER, createdAt: "2026-10-01T08:00:00.000Z", operatorName: "张三" }
      ]
    }
  ]
};

const CRM_QUOTES = {
  records: [
    {
      documentNumber: QUOTE_MARKER,
      documentType: "形式发票",
      totalAmount: 1234.5,
      currency: "USD",
      quotedAt: "2026-09-20T00:00:00.000Z",
      items: [{ product: "Widget", model: "W-1" }]
    }
  ]
};

const CRM_KNOWLEDGE = {
  hits: [{ document: { title: KNOWLEDGE_MARKER, module: "trade", summary: "最小起订 500" }, score: 9.1 }]
};

describe("POST /api/v1/auto-chat/compose", () => {
  let runtime: AppRuntime;
  let httpServer: Server;
  let directory = "";
  let fakeCli = "";
  let crmServer: Server | undefined;
  let crmPort = 0;
  /** 让假 CRM 整体挂掉，用来验"CRM 不在时回复照样能出"。 */
  let crmDown = false;
  /** 每次 CRM 请求的 path 与它带来的身份，断言用。 */
  const crmCalls: Array<{ path: string; subject: string; authorized: boolean }> = [];

  const ownerToken = jwt.sign({ ver: 1 }, SECRET, {
    subject: OWNER,
    issuer: "goodjob-crm",
    audience: "goodjob-crm-web",
    expiresIn: "2h",
    algorithm: "HS256"
  });

  /**
   * 每个请求都要带上 CRM 会话 —— 这份 config 里配了 `crmJwtSecret`，所以插件的 `/api/v1`
   * 全段都要求真实身份（不像"没配密钥"的老回测会放行一个 test-user）。
   * 这也正是生产里的形态：扩展先用 CRM 账号换一枚 Bearer，再拿它调插件。
   */
  const authorized = () => ({ authorization: `Bearer ${ownerToken}` });
  const api = () => ({
    get: (url: string) => request(httpServer).get(url).set(authorized()),
    post: (url: string) => request(httpServer).post(url).set(authorized()),
    put: (url: string) => request(httpServer).put(url).set(authorized())
  });

  /**
   * 假 CLI：把提示词里的四个 CRM 标记回读出来。
   *
   * `--model` 参数也一并回读（放进 system 事件的 model 字段）—— 这样"非法模型名有没有被
   * 透传给子进程"是可断言的，而不是只能信一个纯函数单测。
   */
  const fakeCliSource = (execPath: string): string => `#!${execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.161.4 (fake)\\n"); process.exit(0); }
const modelIndex = args.indexOf("--model");
const reportedModel = modelIndex >= 0 ? args[modelIndex + 1] : "glm-5.3";
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  emit({ type: "system", subtype: "init", session_id: "sess-compose", model: reportedModel });
  const probes = [
    ["company", ${JSON.stringify(COMPANY_MARKER)}],
    ["followup", ${JSON.stringify(ACTIVITY_MARKER)}],
    ["quote", ${JSON.stringify(QUOTE_MARKER)}],
    ["knowledge", ${JSON.stringify(KNOWLEDGE_MARKER)}],
    ["engineName", "goodjob-auto-reply"]
  ];
  const reply = probes.map(([name, needle]) => (prompt.includes(needle) ? name + "=1" : name + "=0")).join(" ");
  const text = JSON.stringify({ reply, confidence: 0.88, reason: "probe", language: "en" });
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: "sess-compose" });
  process.exit(0);
});
`;

  const TRANSCRIPT = [
    { direction: "inbound", body: "Hi, is the MOQ still 500?", occurredAt: "2026-10-01T07:50:00.000Z" },
    { direction: "outbound", body: "Let me check and confirm.", occurredAt: "2026-10-01T07:55:00.000Z" },
    { direction: "inbound", body: "Also when can you ship?", occurredAt: "2026-10-01T08:00:00.000Z" }
  ];

  const compose = (body: Record<string, unknown>) => api().post("/api/v1/auto-chat/compose").send(body);

  const composePayload = (overrides: Record<string, unknown> = {}) => ({
    messages: TRANSCRIPT,
    contact: { phone: "+49 1234 567890", name: "Ann Weber" },
    engine: "cli",
    ...overrides
  });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "wa-compose-"));
    fakeCli = path.join(directory, "fake-codebuddy");
    await writeFile(fakeCli, fakeCliSource(process.execPath), { mode: 0o755 });
    await chmod(fakeCli, 0o755);

    crmServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const authorization = String(req.headers.authorization ?? "");
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      let subject = "";
      let authorized = false;
      try {
        const payload = jwt.verify(token, SECRET, { issuer: "goodjob-crm", audience: "goodjob-crm-web" });
        subject = String((payload as { sub?: string }).sub ?? "");
        authorized = Boolean(subject);
      } catch {
        authorized = false;
      }
      crmCalls.push({ path: url.pathname + url.search, subject, authorized });
      if (crmDown) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "CRM 暂时不可用" }));
        return;
      }
      if (!authorized) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }
      const body =
        url.pathname === "/api/customers"
          ? CRM_CUSTOMERS
          : url.pathname === "/api/quote-history"
            ? CRM_QUOTES
            : url.pathname === "/api/agent/knowledge/search"
              ? CRM_KNOWLEDGE
              : null;
      if (!body) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => crmServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = crmServer.address();
    crmPort = typeof address === "object" && address ? address.port : 0;

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
      autoChatSweep: false,
      crmBaseUrl: `http://127.0.0.1:${crmPort}`,
      crmJwtSecret: SECRET
    } as const;
    const fixtureDatabase = await createDatabase(config);
    await migrate(fixtureDatabase);
    const fixtureRepository = new Repository(fixtureDatabase);
    await seed(fixtureDatabase, fixtureRepository, config);
    await seedDemo(fixtureDatabase, fixtureRepository, config);
    await fixtureDatabase.close();

    runtime = await createAppRuntime(config);
    httpServer = await bindPersistentTestServer(runtime.app);
  }, 60_000);

  afterAll(async () => {
    await closePersistentTestServer(httpServer);
    await runtime.close();
    if (crmServer) await new Promise<void>((resolve) => crmServer!.close(() => resolve()));
  });

  it("CRM 的客户历史与知识命中都进了提示词", async () => {
    crmDown = false;
    const response = await compose(composePayload()).expect(200);
    const result = response.body as {
      action: string;
      reply: string;
      engine: string;
      model: string | null;
      evidence: { crm: { matchedBy: string; customer: string; followUps: number; quotes: number; knowledge: Array<{ title: string }> } };
    };

    expect(result.action).toBe("reply");
    expect(result.engine).toBe("cli");
    // 假 CLI 把「提示词里有没有这些标记」当成回复写回来了。
    expect(result.reply).toBe("company=1 followup=1 quote=1 knowledge=1 engineName=1");
    expect(result.evidence.crm.matchedBy).toBe("phone");
    expect(result.evidence.crm.customer).toBe(COMPANY_MARKER);
    expect(result.evidence.crm.followUps).toBe(1);
    expect(result.evidence.crm.quotes).toBe(1);
    expect(result.evidence.crm.knowledge[0].title).toBe(KNOWLEDGE_MARKER);
    expect(result.evidence.crm.errors).toEqual([]);

    // 三路请求都带上了 owner 自己的身份 —— 这就是"以这个人的权限读 CRM"。
    const customerCalls = crmCalls.filter((call) => call.path.startsWith("/api/customers"));
    expect(customerCalls.length).toBeGreaterThan(0);
    expect(customerCalls.every((call) => call.authorized && call.subject === OWNER)).toBe(true);
    expect(crmCalls.some((call) => call.path.startsWith("/api/quote-history?") && call.path.includes("customerId=cust-compose-1"))).toBe(true);
    expect(crmCalls.some((call) => call.path.startsWith("/api/agent/knowledge/search?"))).toBe(true);
  });

  it("CRM 整体不可用时照样出稿，只是没有那块依据（并如实上报错误）", async () => {
    crmDown = true;
    try {
      const response = await compose(composePayload()).expect(200);
      const result = response.body as {
        action: string;
        reply: string;
        evidence: { crm: { matchedBy: string; errors: string[] } };
      };
      expect(result.action).toBe("reply");
      expect(result.reply).toBe("company=0 followup=0 quote=0 knowledge=0 engineName=1");
      expect(result.evidence.crm.matchedBy).toBe("none");
      expect(result.evidence.crm.errors.join()).toContain("HTTP 503");
    } finally {
      crmDown = false;
    }
  });

  it("只回草稿，绝不自动发送 —— 哪怕全局配的是 auto", async () => {
    // 造一份真档案：`mode !== off` 时后端强制要求先选档案（这条校验是对的，别绕过它）。
    const accounts = (await api().get("/api/v1/accounts").expect(200)).body as Array<{ id: string; name: string }>;
    const europe = accounts.find((account) => account.name === "欧洲销售")!;
    const seeded = (await api()
      .post("/api/v1/demo/inbound")
      .send({ accountId: europe.id, displayName: "Compose 客户", phone: "+8613900000901", body: "你们的最小起订量是多少？" })
      .expect(201)).body as { conversationId: string };
    await api()
      .post(`/api/v1/conversations/${seeded.conversationId}/messages`)
      .send({ accountId: europe.id, clientMessageId: "compose-seed-0001", body: "我们的最小起订量是 500 件。" })
      .expect(201);
    const profile = (await api()
      .post("/api/v1/training/profiles")
      .send({ name: "Compose 话术档案", useAi: false, conversationIds: [seeded.conversationId] })
      .expect(201)).body as { id: string };

    try {
      // 全局设成 auto：后台通道（runNow）在这个配置下是会直接发出的。
      await api()
        .put("/api/v1/auto-chat/settings")
        .send({
          enabled: true,
          mode: "auto",
          accountId: null,
          engine: "cli",
          profileId: profile.id,
          dailyLimit: 0,
          minIntervalMinutes: 0,
          activeHoursStart: 0,
          activeHoursEnd: 0,
          confidenceThreshold: 0.1
        })
        .expect(200);

      const response = await compose(composePayload()).expect(200);
      expect((response.body as { action: string }).action).toBe("reply");
      // 现场生成不落库、也不借后台那条会发送的路：草稿列表必须仍然是空的。
      const drafts = (await api().get("/api/v1/auto-chat/drafts?limit=100").expect(200)).body as AutoChatDraft[];
      expect(drafts).toEqual([]);
    } finally {
      await api().put("/api/v1/auto-chat/settings").send({ enabled: false, mode: "off", accountId: null }).expect(200);
    }
  }, 30_000);

  it("段里没有客户消息时不生成", async () => {
    const response = await compose(
      composePayload({ messages: [{ direction: "outbound", body: "helo?", occurredAt: "2026-10-01T08:00:00.000Z" }] })
    ).expect(200);
    expect(response.body).toMatchObject({ action: "skip", reply: "" });
    expect((response.body as { reason: string }).reason).toContain("没有客户消息");
  });

  it("命中升级关键词就转人工，不给草稿", async () => {
    const response = await compose(
      composePayload({
        messages: [{ direction: "inbound", body: "I want a refund for the broken batch", occurredAt: "2026-10-01T08:00:00.000Z" }]
      })
    ).expect(200);
    expect(response.body).toMatchObject({ action: "skip", reply: "", blocked: false });
    expect((response.body as { reason: string }).reason).toContain("升级关键词");
  });

  it("非法模型名不会透传给子进程，实际模型以 CLI 自报为准", async () => {
    const illegal = await compose(composePayload({ model: "definitely-not-a-model" })).expect(200);
    // 假 CLI 把收到的 --model 原样报回来；回落成功的话它报的是自己的默认值。
    expect((illegal.body as { model: string }).model).toBe("glm-5.3");

    const legal = await compose(composePayload({ model: "deepseek-v4-pro" })).expect(200);
    expect((legal.body as { model: string }).model).toBe("deepseek-v4-pro");
  });

  it("显式选话术库时如实说明没有相近问法，而不是硬编一条", async () => {
    // 来文刻意全程不带任何贸易词（MOQ/交期/发货…）：合并来文检索上线后，
    // 默认对话里前面的 MOQ 正题是能命中的——这条用例验的是「真没有相近问法」时的收口。
    const response = await compose(
      composePayload({
        engine: "rules",
        messages: [
          { direction: "inbound", body: "What are your office hours?", occurredAt: "2026-10-01T08:00:00.000Z" },
          { direction: "inbound", body: "Thanks, talk tomorrow!", occurredAt: "2026-10-01T08:01:00.000Z" }
        ]
      })
    ).expect(200);
    expect(response.body).toMatchObject({ action: "skip", engine: "rules", blocked: true, reply: "" });
    expect((response.body as { reason: string }).reason).toContain("没有相近问法");
  });

  it("客户连发几句时，正题不在最后一条也能命中训练库（合并来文检索）", async () => {
    // 中文条目 + 英文连问：同时压住「词典扩展（MOQ→起订量）」与「合并来文（正题不是最后一条）」。
    await api()
      .post("/api/v1/training/library")
      .send({ kind: "qa", question: "起订量是多少？最低多少个起做？", answer: "起订量 500 个，1000 个以上有阶梯价。", priority: 5 })
      .expect(201);
    const response = await compose(
      composePayload({
        engine: "rules",
        messages: [
          { direction: "inbound", body: "Hello! What's your MOQ for this item?", occurredAt: "2026-10-01T08:00:00.000Z" },
          { direction: "inbound", body: "And the lead time?", occurredAt: "2026-10-01T08:01:00.000Z" }
        ]
      })
    ).expect(200);
    const body = response.body as { reply: string; reason: string };
    expect(body.reply).toContain("500");
    expect(body.reason).not.toContain("没有相近问法");
  });

  it("空 messages 直接 400，不给 CLI 灌任意长度文本", async () => {
    await compose({ messages: [], contact: { phone: "+491234567890", name: "x" } }).expect(400);
    await compose({ messages: [{ direction: "inbound", body: "x".repeat(4_001), occurredAt: "" }] }).expect(400);
  });
});
