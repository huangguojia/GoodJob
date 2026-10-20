import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { createDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";
import { inMemoryDatabasePaths } from "./helpers/test-database";
import { bindPersistentTestServer, closePersistentTestServer } from "./helpers/persistent-server";

/**
 * 「回复 + 资料」这条链路的端到端回测（真 HTTP，两个假件顶两头）。
 *
 * 为什么不能只靠单测：这条链路上有两个**跨进程 / 跨服务**的接缝，
 * 单测各测一半都测不到它们：
 *
 * 1. 插件 → CRM：单测里是 stub fetch，断言的是「我拼了个 URL」。这里是一个真 HTTP 服务
 *    在**校验插件自签的 JWT**，所以「以这个业务员的身份去检索」才是被验过的。
 * 2. 插件 → CLI 子进程：假 CLI 真的被 fork 出来、从 stdin 读提示词，把**候选清单里的标记
 *    回读**进 `why`。这是唯一能证明「候选真的进了提示词」的办法 —— 否则断到的只是
 *    「拼字符串的函数返回了什么」。
 *
 * 另外三条纪律在这里被钉死：
 * - 目录/推荐响应里**不许出现任何 URL**（真实地址只能经 reveal 取）；
 * - reveal 是**唯一**把外链交出去的地方，且它把 owner 的身份带过去了；
 * - CRM 整体挂掉时，回复照常出、资料区出一句原因（而不是整条接口 500）。
 */

const SECRET = "resource-hub-test-crm-secret";
const OWNER = "test-user";

const FILE_ID = "res-file-1";
const FILE_TITLE = "LED-PANEL-SPEC-MARKER.pdf";
const KNOWLEDGE_ID = "kb-1";
const REAL_URL = "https://pan.baidu.com/s/REAL-LINK-MARKER";
const SHARE_CODE = "sc9x";

const RECOMMENDATIONS = [
  {
    id: FILE_ID,
    sourceType: "file",
    title: FILE_TITLE,
    category: "规格书",
    summary: "600x600 LED panel, 40W, 4000K",
    tags: ["led", "panel"],
    fileType: "pdf",
    version: "v2",
    author: "张三",
    updatedAt: "2026-09-01T00:00:00.000Z",
    accessCount: 4,
    hasExternalLink: true,
    score: 12.5,
    headline: "「led」「规格书」都在这份资料里",
    match: { lexical: 8, strategic: 0, structured: 0.18, semantic: 4, vector: 0 },
    reasons: [{ kind: "lexical", text: "「led」「规格书」都在这份资料里" }],
    hitTerms: ["led"]
  },
  {
    id: KNOWLEDGE_ID,
    sourceType: "knowledge",
    title: "MOQ 政策",
    category: "trade",
    summary: "最小起订 500",
    tags: ["moq"],
    fileType: "md",
    version: "v1",
    author: "系统",
    updatedAt: "2026-08-01T00:00:00.000Z",
    accessCount: 1,
    hasExternalLink: false,
    score: 6.2,
    headline: "命中「最小起订」",
    match: { lexical: 5, structured: 0, semantic: 1.2, vector: 0 },
    reasons: [{ kind: "lexical", text: "命中「最小起订」" }],
    hitTerms: ["moq"]
  }
];

const CRM_CUSTOMERS = {
  customers: [
    {
      id: "cust-res-1",
      company: "ACME-RESOURCE-MARKER GmbH",
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
      wonDealCount: 0,
      lastActivityAt: "2026-10-01T08:00:00.000Z",
      activities: [{ type: "whatsapp", content: "asked for spec", createdAt: "2026-10-01T08:00:00.000Z", operatorName: "张三" }]
    }
  ]
};

/**
 * 目录快照的假响应（文件中心的治理视图）。
 *
 * `CATALOG_MARKER` 落在 fingerprint 里：用来证明插件把 CRM 的响应**原样**带回来了，
 * 而不是自己拼了一份看起来像的。`corePool + longTailPool == published` 这条恒等式
 * 在假数据里也必须成立 —— 否则用例本身就在教一套错误口径。
 */
const CATALOG_MARKER = "CATALOG-MARKER-9f3a";
const CATALOG = {
  revision: {
    generatedAt: "2026-10-14T08:00:00.000Z",
    latestUpdatedAt: "2026-10-14T07:59:00.000Z",
    total: 411,
    fingerprint: `419:411:2:7:4:${CATALOG_MARKER}`
  },
  vocabulary: {
    categories: [{ value: "规格书", usageCount: 12 }],
    tags: [{ value: "led", usageCount: 30 }]
  },
  governance: {
    total: 419,
    published: 411,
    draft: 5,
    review: 1,
    archived: 2,
    verified: 7,
    unverified: 404,
    corePool: 7,
    longTailPool: 404,
    missingLink: 4,
    orphans: 0,
    qualityFlags: { 缺少说明: 415 },
    byCategory: [{ category: "规格书", total: 12, verified: 2, missingLink: 0 }]
  },
  items: [
    {
      id: FILE_ID,
      title: FILE_TITLE,
      category: "规格书",
      tags: ["led"],
      description: "600x600 LED panel, 40W, 4000K",
      fileType: "pdf",
      version: "v2",
      status: "published",
      verified: true,
      pool: "core",
      hasExternalLink: true,
      qualityFlags: [],
      accessCount: 4,
      author: "张三",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-10-14T07:59:00.000Z"
    }
  ],
  truncated: 0,
  warnings: []
};

describe("资源推荐：插件 ↔ CRM ↔ CLI 的闭环", () => {
  let runtime: AppRuntime;
  let httpServer: Server;
  let directory = "";
  let fakeCli = "";
  let crmServer: Server | undefined;
  let crmPort = 0;
  let crmDown = false;
  /** 每次 CRM 请求的 method / path / 身份 / body，断言用。 */
  const crmCalls: Array<{ method: string; path: string; subject: string; authorized: boolean; body: Record<string, unknown> | null }> = [];
  /**
   * 假 CLI 每次收到的提示词，**由子进程自己写进日志文件**。
   *
   * 不能靠测试进程里的数组：CLI 是 fork 出去的独立进程，它 push 不到我们的数组里。
   * 这条日志是"提示词里到底有什么"的唯一直接证据。
   */
  let promptLog = "";

  const readPrompts = async (): Promise<string[]> => {
    if (!promptLog) return [];
    try {
      const raw = await readFile(promptLog, "utf8");
      return raw.split("\n\u0000\n").map((item) => item.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };

  const ownerToken = jwt.sign({ ver: 1 }, SECRET, {
    subject: OWNER,
    issuer: "goodjob-crm",
    audience: "goodjob-crm-web",
    expiresIn: "2h",
    algorithm: "HS256"
  });

  const authorized = () => ({ authorization: `Bearer ${ownerToken}` });
  const api = () => ({
    get: (url: string) => request(httpServer).get(url).set(authorized()),
    post: (url: string) => request(httpServer).post(url).set(authorized())
  });

  /**
   * 假 CLI 要顶**两种**任务，所以按提示词里有没有 `candidateMaterials` 分流：
   * - 有 → 资源挑选：把候选清单里的第一个 title 回读进 `why`（证明候选真的进了提示词）；
   * - 没有 → 出回复：把提示词里的 CRM 标记回读成正文（证明 CRM 依据进了提示词）。
   */
  const fakeCliSource = (execPath: string): string => `#!${execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("2.161.4 (fake)\\n"); process.exit(0); }
const modelIndex = args.indexOf("--model");
const reportedModel = modelIndex >= 0 ? args[modelIndex + 1] : "glm-5.3";
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
const logFile = process.env.FAKE_CLI_PROMPT_LOG;
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (logFile) { try { fs.appendFileSync(logFile, prompt + "\\n\\u0000\\n"); } catch (e) {} }
  emit({ type: "system", subtype: "init", session_id: "sess-res", model: reportedModel });
  let text;
  if (prompt.includes("candidateMaterials")) {
    const keyMatch = prompt.match(/"key":"([^"]+)"/);
    const key = keyMatch ? keyMatch[1] : "";
    const titleMatch = prompt.match(/"title":"([^"]+)"/);
    const title = titleMatch ? titleMatch[1] : "";
    text = JSON.stringify({
      picks: [
        { id: key, why: "客户点名要 " + title, suggestedLine: "Sure, please find the specification sheet attached." },
        { id: "file:NOT-IN-LIST", why: "编的", suggestedLine: "" }
      ],
      reply: "这批资料里规格书最对口"
    });
  } else {
    const probes = [
      ["company", "ACME-RESOURCE-MARKER GmbH"],
      ["engineName", "goodjob-auto-reply"]
    ];
    text = JSON.stringify({
      reply: probes.map(([name, needle]) => (prompt.includes(needle) ? name + "=1" : name + "=0")).join(" "),
      confidence: 0.9,
      reason: "probe",
      language: "en"
    });
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: "sess-res" });
  process.exit(0);
});
`;

  const TRANSCRIPT = [
    { direction: "inbound", body: "Hi, can you send the LED panel specification?", occurredAt: "2026-10-01T07:50:00.000Z" },
    { direction: "outbound", body: "Let me look it up.", occurredAt: "2026-10-01T07:55:00.000Z" },
    { direction: "inbound", body: "Also what is your MOQ?", occurredAt: "2026-10-01T08:00:00.000Z" }
  ];

  const search = (body: Record<string, unknown>) => api().post("/api/v1/resources/search").send(body);
  const suggest = (body: Record<string, unknown>) => api().post("/api/v1/auto-chat/suggest").send(body);

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "wa-resource-"));
    fakeCli = path.join(directory, "fake-codebuddy");
    await writeFile(fakeCli, fakeCliSource(process.execPath), { mode: 0o755 });
    await chmod(fakeCli, 0o755);
    promptLog = path.join(directory, "prompts.log");
    process.env.FAKE_CLI_PROMPT_LOG = promptLog;

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
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
        crmCalls.push({ method: req.method ?? "GET", path: url.pathname + url.search, subject, authorized, body });
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
        if (url.pathname === "/api/agent/resources/recommend") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              recommendations: RECOMMENDATIONS,
              retrieval: { mode: "lexical+structured", scanned: 40, candidates: 2, vectorEnabled: false, tookMs: 7 },
              customer: { matched: true, id: "cust-res-1", company: "ACME-RESOURCE-MARKER GmbH" },
              warnings: ["向量库为空（未启用）"]
            })
          );
          return;
        }
        if (url.pathname === "/api/agent/resources") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ resources: RECOMMENDATIONS, total: 2, retrievalMode: "list", vectorEnabled: false }));
          return;
        }
        if (url.pathname === `/api/agent/resources/file/${FILE_ID}/reveal`) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              resource: { id: FILE_ID, sourceType: "file", title: FILE_TITLE, fileType: "pdf" },
              access: { kind: "external", url: REAL_URL, shareCode: SHARE_CODE },
              accessId: "rae_test_1"
            })
          );
          return;
        }
        if (url.pathname === "/api/agent/resources/catalog") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(CATALOG));
          return;
        }
        if (url.pathname === "/api/agent/resources/feedback") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ recorded: 1, ignored: 0 }));
          return;
        }
        if (url.pathname === "/api/customers") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(CRM_CUSTOMERS));
          return;
        }
        if (url.pathname === "/api/quote-history") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ records: [] }));
          return;
        }
        if (url.pathname === "/api/agent/knowledge/search") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ hits: [] }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "not found" }));
      });
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
    delete process.env.FAKE_CLI_PROMPT_LOG;
    await closePersistentTestServer(httpServer);
    await runtime.close();
    if (crmServer) await new Promise<void>((resolve) => crmServer!.close(() => resolve()));
  });

  it("检索：以业务员身份打 CRM，响应里一个 URL 都没有", async () => {
    crmDown = false;
    crmCalls.length = 0;
    const response = await search({
      messages: TRANSCRIPT,
      customerId: "cust-res-1",
      conversationKey: "wa:+491234567890"
    }).expect(200);
    const result = response.body as {
      resources: Array<{ id: string; key: string; title: string; why: string; suggestedLine: string; hasExternalLink: boolean }>;
      customer: { matched: boolean; company: string };
      retrieval: { vectorEnabled: boolean };
      warnings: string[];
    };

    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].key).toBe(`file:${FILE_ID}`);
    expect(result.customer.company).toBe("ACME-RESOURCE-MARKER GmbH");
    expect(result.retrieval.vectorEnabled).toBe(false);
    // CRM 的 warnings 要原样带到面板上（「未取到：…」这类话由它拼）。
    expect(result.warnings).toContain("向量库为空（未启用）");
    // 关键：没复排时 why/suggestedLine 是空的，面板会退化成展示 headline。
    expect(result.resources[0].why).toBe("");

    // **整个响应序列化后不许出现任何 http** —— 外链只能经 reveal 取。
    expect(JSON.stringify(response.body)).not.toContain("http");
    expect(JSON.stringify(response.body)).not.toContain(SHARE_CODE);

    const recommendCalls = crmCalls.filter((call) => call.path === "/api/agent/resources/recommend");
    expect(recommendCalls).toHaveLength(1);
    expect(recommendCalls[0].method).toBe("POST");
    expect(recommendCalls[0].authorized).toBe(true);
    expect(recommendCalls[0].subject).toBe(OWNER);
    expect(recommendCalls[0].body).toMatchObject({ customerId: "cust-res-1", conversationKey: "wa:+491234567890", signal: "manual" });
  });

  it("目录式检索走 GET，q 原样带给 CRM", async () => {
    crmCalls.length = 0;
    const response = await search({ q: "led panel", limit: 5 }).expect(200);
    expect((response.body as { resources: unknown[] }).resources).toHaveLength(2);
    const listCalls = crmCalls.filter((call) => call.path.startsWith("/api/agent/resources?"));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].method).toBe("GET");
    // 用 URL 解析而不是字符串包含：`URLSearchParams` 把空格编成 `+`，
    // `decodeURIComponent` 不会把它还原回空格 —— 直接比字符串会写出一个假失败。
    const listQuery = new URL(`http://127.0.0.1${listCalls[0].path}`);
    expect(listQuery.searchParams.get("q")).toBe("led panel");
    expect(listQuery.searchParams.get("limit")).toBe("5");
  });

  it("suggest：一次给全回复与资料，且候选清单真的进了提示词", async () => {
    crmDown = false;
    crmCalls.length = 0;
    await writeFile(promptLog, "");
    const response = await suggest({
      messages: TRANSCRIPT,
      contact: { phone: "+49 1234 567890", name: "Ann Weber" },
      engine: "cli",
      conversationKey: "wa:+491234567890"
    }).expect(200);
    const result = response.body as {
      reply: { action: string; reply: string; engine: string; model: string | null; evidence: { sources: string[]; crm: { customer: string } } };
      resources: Array<{ key: string; why: string; suggestedLine: string; sourceType: string }>;
      curatorNote: string;
      curated: boolean;
      replyEngine: string;
      warnings: string[];
    };

    // 1) 回复那一半：CRM 依据进了提示词，来源徽章如实列出。
    expect(result.reply.action).toBe("reply");
    expect(result.reply.engine).toBe("cli");
    expect(result.reply.reply).toBe("company=1 engineName=1");
    expect(result.reply.evidence.crm.customer).toBe("ACME-RESOURCE-MARKER GmbH");
    expect(result.reply.evidence.sources).toContain("crm_followup");
    // 面板那一排徽章与它下面列的资料必须是同一件事。
    expect(result.reply.evidence.sources).toContain("resource");

    // 2) 资料那一半：CLI 复排真的跑过，且**候选清单进了提示词**。
    expect(result.curated).toBe(true);
    expect(result.replyEngine).toBe("cli");
    expect(result.curatorNote).toBe("这批资料里规格书最对口");
    expect(result.resources[0].key).toBe(`file:${FILE_ID}`);
    expect(result.resources[0].why).toBe(`客户点名要 ${FILE_TITLE}`);
    expect(result.resources[0].suggestedLine).toBe("Sure, please find the specification sheet attached.");
    // 模型夹带的「不在清单里的资料」被丢掉了。
    expect(result.resources.map((item) => item.key)).not.toContain("file:NOT-IN-LIST");
    expect(result.warnings.join()).toContain("臆造");

    // 3) 两个 CLI 任务都真的 fork 出来了，且资料那个提示词里带着候选标记。
    const prompts = await readPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    const resourcePrompt = prompts.find((prompt) => prompt.includes("candidateMaterials"));
    expect(resourcePrompt).toBeTruthy();
    expect(resourcePrompt!).toContain(FILE_TITLE);
    expect(resourcePrompt!).toContain(`file:${FILE_ID}`);
    expect(resourcePrompt!).toContain('load your skill "goodjob-resource-scout"');
    const replyPrompt = prompts.find((prompt) => !prompt.includes("candidateMaterials"));
    expect(replyPrompt!).toContain('load your skill "goodjob-auto-reply"');
  });

  it("withReply:false 时不出回复，只出资料", async () => {
    const response = await suggest({ messages: TRANSCRIPT, withReply: false, withAi: false }).expect(200);
    const result = response.body as { reply: null; resources: unknown[]; curated: boolean };
    expect(result.reply).toBeNull();
    expect(result.resources).toHaveLength(2);
    expect(result.curated).toBe(false);
  });

  it("reveal 是唯一交出外链的地方，且带上了 owner 的身份", async () => {
    crmCalls.length = 0;
    const response = await api()
      .post("/api/v1/resources/reveal")
      .send({ sourceType: "file", id: FILE_ID, reason: "manual", conversationKey: "wa:+491234567890" })
      .expect(200);
    const result = response.body as { ok: boolean; resource: { title: string }; access: { kind: string; url: string; shareCode: string }; accessId: string };
    expect(result.ok).toBe(true);
    expect(result.resource.title).toBe(FILE_TITLE);
    expect(result.access).toEqual({ kind: "external", url: REAL_URL, shareCode: SHARE_CODE });
    expect(result.accessId).toBe("rae_test_1");

    const revealCalls = crmCalls.filter((call) => call.path.endsWith("/reveal"));
    expect(revealCalls).toHaveLength(1);
    expect(revealCalls[0].method).toBe("POST");
    expect(revealCalls[0].subject).toBe(OWNER);
    expect(revealCalls[0].body).toMatchObject({ reason: "manual", conversationKey: "wa:+491234567890" });
  });

  it("reveal 失败时给的是可显示的原因，不是 HTTP 错误", async () => {
    const response = await api()
      .post("/api/v1/resources/reveal")
      .send({ sourceType: "file", id: "does-not-exist" })
      .expect(200);
    const result = response.body as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("HTTP 404");
  });

  it("埋点回 202，且确实打到了 CRM", async () => {
    crmCalls.length = 0;
    await api()
      .post("/api/v1/resources/feedback")
      .send({ items: [{ resourceId: FILE_ID, sourceType: "file", action: "accepted" }], conversationKey: "wa:+491234567890" })
      .expect(202);
    const feedbackCalls = crmCalls.filter((call) => call.path === "/api/agent/resources/feedback");
    // 旁路：接口先回，写请求是异步发的，给它一点点时间。
    for (let attempt = 0; attempt < 40 && !feedbackCalls.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      feedbackCalls.push(...crmCalls.filter((call) => call.path === "/api/agent/resources/feedback"));
    }
    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0].body).toMatchObject({ conversationKey: "wa:+491234567890" });
  });

  it("目录快照：以业务员身份取文件中心治理视图，词表 / 两池 / 质量标记都带出来，且一个 URL 都没有", async () => {
    crmDown = false;
    crmCalls.length = 0;
    const response = await api()
      .get("/api/v1/resources/catalog?since=2026-10-01T00:00:00.000Z&limit=200")
      .expect(200);
    const result = response.body as {
      revision: { latestUpdatedAt: string; fingerprint: string };
      vocabulary: { categories: Array<{ value: string }> };
      governance: { published: number; corePool: number; longTailPool: number; draft: number };
      items: Array<{ id: string; verified: boolean; pool: string }>;
    };

    // 原样带回：marker 在 fingerprint 里，插件不可能自己拼出这一串。
    expect(result.revision.fingerprint).toContain(CATALOG_MARKER);
    expect(result.revision.latestUpdatedAt).toBe("2026-10-14T07:59:00.000Z");
    // 草稿也进治理计数（才催得动），而两池相加必须等于已发布（同一份数据不能算出两个结论）
    expect(result.governance.draft).toBe(5);
    expect(result.governance.corePool + result.governance.longTailPool).toBe(result.governance.published);
    expect(result.vocabulary.categories[0].value).toBe("规格书");
    // 两池归属一路带到这里 —— 在此之前插件的类型声明里连字段都没有，整个丢掉
    expect(result.items[0].verified).toBe(true);
    expect(result.items[0].pool).toBe("core");

    // 目录同样不许出现任何 URL：hasExternalLink 只说"有没有"，不说"是什么"
    expect(JSON.stringify(response.body)).not.toContain("http");
    expect(JSON.stringify(response.body)).not.toContain(SHARE_CODE);

    const catalogCalls = crmCalls.filter((call) => call.path.startsWith("/api/agent/resources/catalog"));
    expect(catalogCalls).toHaveLength(1);
    expect(catalogCalls[0].method).toBe("GET");
    expect(catalogCalls[0].authorized).toBe(true);
    expect(catalogCalls[0].subject).toBe(OWNER);
    expect(catalogCalls[0].path).toContain("since=2026-10-01");
    expect(catalogCalls[0].path).toContain("limit=200");
  });

  it("目录快照上游挂掉时给 502 + 真实原因，绝不伪装成空目录", async () => {
    crmDown = true;
    try {
      const response = await api().get("/api/v1/resources/catalog").expect(502);
      // 「空」和「取不到」必须能分开：原因句要真的带出来，而不是一句 Internal server error
      expect(String((response.body as { error: string }).error)).toContain("503");
    } finally {
      crmDown = false;
    }
  });

  it("CRM 挂掉时回复照常出，资料区只出一句原因", async () => {
    crmDown = true;
    try {
      const response = await suggest({ messages: TRANSCRIPT, engine: "cli" }).expect(200);
      const result = response.body as { reply: { action: string; reply: string }; resources: unknown[]; warnings: string[]; curated: boolean };
      // 回复那一半本来就允许没有 CRM 依据（buildCrmContext 永不抛错）。
      expect(result.reply.action).toBe("reply");
      // 资料那一半整块降级：空列表 + 一句可显示的原因，**不是** 500。
      expect(result.resources).toEqual([]);
      expect(result.curated).toBe(false);
      expect(result.warnings.join()).toContain("资料推荐未取到");
    } finally {
      crmDown = false;
    }
  });

  it("未登录一律 401（三个新接口都不能绕开身份）", async () => {
    await request(httpServer).post("/api/v1/resources/search").send({ q: "x" }).expect(401);
    await request(httpServer).post("/api/v1/resources/reveal").send({ sourceType: "file", id: FILE_ID }).expect(401);
    await request(httpServer).post("/api/v1/auto-chat/suggest").send({ messages: TRANSCRIPT }).expect(401);
  });

  it("入参乱给一律 400，不会带着坏数据去碰 CRM", async () => {
    crmCalls.length = 0;
    await api().post("/api/v1/resources/reveal").send({ sourceType: "nope", id: FILE_ID }).expect(400);
    await api().post("/api/v1/resources/feedback").send({ items: [] }).expect(400);
    await api().post("/api/v1/auto-chat/suggest").send({ messages: [{ direction: "sideways", body: "x" }] }).expect(400);
    expect(crmCalls.filter((call) => call.path.startsWith("/api/agent/resources"))).toEqual([]);
  });
});
