import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AutoChatDraft,
  ChannelAccount,
  ChatMessage,
  Conversation,
  TrainingLibraryEntry,
  TrainingLibraryMatchResult,
  TrainingProfile
} from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { inMemoryDatabasePaths } from "./helpers/test-database";
import { bindPersistentTestServer, closePersistentTestServer } from "./helpers/persistent-server";

/**
 * 训练库（自动回复的专用语料库）端到端回测。
 *
 * 三条链路各测一段，因为它们的失败方式完全不同：
 * 1. **入库**：去重与幂等（反复导入同一份档案不该让库膨胀）；
 * 2. **检索**：四类条目各归其位（问答对命中、口径全带、政策并入护栏、禁用词两侧生效）；
 * 3. **落地**：库里的口径真的被自动回复用上，且禁用纪律真的拦得住。
 *
 * 运行时用 PGlite 的**内存**文件系统：本文件不验持久化，而落盘 PGlite 每建一个库要跑一遍
 * initdb（本机实测 ~40 秒，时间几乎全花在文件系统等待上）。落盘路径由
 * `mysql.integration.test.ts` / `api.integration.test.ts` 覆盖。
 */
describe("自动回复训练库", () => {
  let runtime: AppRuntime;
  let httpServer: Server;
  let europe: ChannelAccount;
  let profile: TrainingProfile;

  const api = () => request(httpServer);

  const createEntry = (body: Record<string, unknown>) => api().post("/api/v1/training/library").send(body);
  const listEntries = async (query = ""): Promise<TrainingLibraryEntry[]> =>
    (await api().get(`/api/v1/training/library${query}`).expect(200)).body as TrainingLibraryEntry[];
  const match = async (body: string): Promise<TrainingLibraryMatchResult> =>
    (await api().post("/api/v1/training/library/match").send({ body }).expect(200)).body as TrainingLibraryMatchResult;

  const listDrafts = async (): Promise<AutoChatDraft[]> =>
    (await api().get("/api/v1/auto-chat/drafts?limit=100").expect(200)).body as AutoChatDraft[];

  /** 造一条入站消息并等它触发的那份草稿出现（入站钩子是 fire-and-forget）。 */
  const inboundAndWait = async (phone: string, body: string): Promise<AutoChatDraft> => {
    const message = (await api()
      .post("/api/v1/demo/inbound")
      .send({ accountId: europe.id, displayName: `训练库客户 ${phone.slice(-4)}`, phone, body })
      .expect(201)).body as ChatMessage;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = (await listDrafts()).find((draft) => draft.inboundMessageId === message.id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("等待自动聊草稿超时");
  };

  beforeAll(async () => {
    // 内存库 + 临时目录里的媒体目录：见 helpers/test-database.ts。
    const scratch = await mkdtemp(path.join(os.tmpdir(), "wa-crm-library-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(scratch),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: true,
      allowPrivateAiEndpoints: false,
      // 本文件测的是训练库与规则通道：把 CLI 指向不存在的路径，避免开发机上装了 codebuddy
      // 就走 CLI 子进程（断言全变，而且慢且依赖登录态）。
      cliBinary: path.join(scratch, "no-such-codebuddy"),
      autoChatSweep: false
    } as never);
    httpServer = await bindPersistentTestServer(runtime.app);
    europe = ((await api().get("/api/v1/accounts").expect(200)).body as ChannelAccount[]).find((account) => account.name === "欧洲销售")!;
    // 规则引擎训练：把演示会话抽成一份可用档案（自动聊必须绑定 ready 档案才会工作）。
    profile = (await api().post("/api/v1/training/profiles").send({ name: "训练库回测档案", useAi: false }).expect(201)).body as TrainingProfile;
    expect(profile.status).toBe("ready");
  }, 60_000);

  afterAll(async () => {
    await closePersistentTestServer(httpServer);
    await runtime.close();
  });

  describe("入库：去重与幂等", () => {
    it("问答对缺问法会被拒，只有答法不算一条完整问答", async () => {
      const response = await createEntry({ kind: "qa", answer: "有的，我们支持小批量试单。" }).expect(400);
      expect(response.body).toMatchObject({ code: "INVALID_REQUEST" });
    });

    it("首次入库返回 201，同一条问答重复提交返回既有那条（200）且不新增", async () => {
      const first = await createEntry({ kind: "qa", question: "你们最小的型号是什么？", answer: "最小的机型是 X-20。" }).expect(201);
      const again = await createEntry({ kind: "qa", question: "你们最小的型号是什么？", answer: "最小的机型是 X-20。" }).expect(200);
      expect(again.body.id).toBe(first.body.id);

      // 只差空白与大小写也算同一条：否则反复导入会堆出几十条一模一样的东西。
      const spaced = await createEntry({ kind: "qa", question: "  你们最小的型号是什么？  ", answer: "最小的机型是  X-20。" }).expect(200);
      expect(spaced.body.id).toBe(first.body.id);

      const qa = await listEntries("?kind=qa");
      expect(qa.filter((entry) => entry.question === "你们最小的型号是什么？")).toHaveLength(1);
    });

    it("答法不同就是另一条，不会被误合并", async () => {
      const other = await createEntry({ kind: "qa", question: "你们最小的型号是什么？", answer: "最小的机型是 X-30。" }).expect(201);
      expect((await listEntries("?kind=qa")).some((entry) => entry.id === other.body.id)).toBe(true);
    });

    it("按类型与启用状态过滤列表", async () => {
      const snippet = await createEntry({ kind: "snippet", question: "付款方式", answer: "常规是 30% 定金 + 70% 见提单副本。" }).expect(201);
      await api().patch(`/api/v1/training/library/${snippet.body.id}`).send({ kind: "snippet", question: "付款方式", answer: "常规是 30% 定金 + 70% 见提单副本。", enabled: false }).expect(200);

      expect((await listEntries("?kind=snippet")).map((entry) => entry.id)).toContain(snippet.body.id);
      expect((await listEntries("?kind=snippet&enabled=true")).map((entry) => entry.id)).not.toContain(snippet.body.id);
      // 非法的 kind 会被忽略而不是 500
      expect(Array.isArray(await listEntries("?kind=nonsense"))).toBe(true);
    });

    it("更新内容时保留来源、创建时间与命中计数", async () => {
      const created = (await createEntry({ kind: "policy", question: "报价权限", answer: "不得在聊天里给具体价格。" }).expect(201)).body as TrainingLibraryEntry;
      await runtime.trainingLibrary.recordHits([created.id]);
      const before = (await listEntries()).find((entry) => entry.id === created.id)!;

      const updated = (await api()
        .patch(`/api/v1/training/library/${created.id}`)
        .send({ kind: "policy", question: "报价权限", answer: "不得在聊天里给具体价格，统一回复安排报价。" })
        .expect(200)).body as TrainingLibraryEntry;

      expect(updated.answer).toContain("统一回复安排报价");
      expect(updated.createdAt).toBe(before.createdAt);
      expect(updated.hitCount).toBe(before.hitCount);
      expect(updated.source).toBe(before.source);
      expect(updated.enabled).toBe(true);
    });

    it("删除之后列表里不再有这一条", async () => {
      const created = (await createEntry({ kind: "snippet", question: "临时", answer: "这条会被删掉。" }).expect(201)).body as TrainingLibraryEntry;
      await api().delete(`/api/v1/training/library/${created.id}`).expect(204);
      expect((await listEntries()).some((entry) => entry.id === created.id)).toBe(false);
    });
  });

  describe("检索：四类条目各归其位", () => {
    it("中文短问句能命中标准问答对（按相邻两字切特征）", async () => {
      await createEntry({ kind: "qa", question: "你们的最小型号是什么？", answer: "最小的机型是 X-20。" }).expect([200, 201]);
      const result = await match("请问你们的最小型号是什么呢");
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0].entry.answer).toBe("最小的机型是 X-20。");
      expect(result.hits[0].similarity).toBeGreaterThan(0.5);
      expect(result.verdict).toContain("命中");
    });

    it("完全不相干的问题不硬凑命中", async () => {
      const result = await match("里约热内卢的天气怎么样");
      expect(result.hits).toHaveLength(0);
      expect(result.forbidden).toHaveLength(0);
    });

    it("停用的问答对不参与检索", async () => {
      const created = (await createEntry({ kind: "qa", question: "你们的质保期是多久？", answer: "整机一年。" }).expect(201)).body as TrainingLibraryEntry;
      expect((await match("你们的质保期是多久")).hits.map((hit) => hit.entry.id)).toContain(created.id);

      await api().patch(`/api/v1/training/library/${created.id}`).send({ kind: "qa", question: "你们的质保期是多久？", answer: "整机一年。", enabled: false }).expect(200);
      expect((await match("你们的质保期是多久")).hits.map((hit) => hit.entry.id)).not.toContain(created.id);
    });

    it("口径片段与政策无论是否命中问法都会带上，禁用词两侧都能用", async () => {
      await createEntry({ kind: "snippet", question: "交期口径", answer: "标准交期以排产确认为准。" }).expect(201);
      const forbidden = (await createEntry({ kind: "forbidden", question: "counterfeit", answer: "我们承担全部损失" }).expect(201)).body as TrainingLibraryEntry;

      const untouched = await match("completely unrelated question about weather");
      expect(untouched.snippets.map((entry) => entry.id)).toContain(
        (await listEntries("?kind=snippet")).find((entry) => entry.question === "交期口径")!.id
      );
      expect(untouched.policies.length).toBeGreaterThan(0);
      // 禁用词是「回复里出现就拦」，所以永远在 forbiddenPhrases 里，跟当前这句问话无关
      expect(untouched.forbiddenPhrases).toContain("我们承担全部损失");
      expect(untouched.forbidden).toHaveLength(0);

      // 而 question 是「客户这么说就该转人工」的触发场景
      const triggered = await match("Is this a counterfeit product?");
      expect(triggered.forbidden.map((hit) => hit.entry.id)).toContain(forbidden.id);
    });
  });

  describe("从训练档案导入", () => {
    it("样板进问答对、护栏进政策，重复导入只算已存在", async () => {
      const first = (await api().post("/api/v1/training/library/import").send({ profileId: profile.id }).expect(200)).body as { created: number; skipped: number; total: number };
      expect(first.created).toBe(profile.examples.length + profile.guardrails.length);
      expect(first.total).toBe(first.created);

      const second = (await api().post("/api/v1/training/library/import").send({ profileId: profile.id }).expect(200)).body as { created: number; skipped: number; total: number };
      // 幂等：重复导入不该让库膨胀，这正是「反复导同一份档案」的自然操作。
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(first.created);

      const imported = await listEntries("?kind=qa&enabled=true");
      expect(imported.some((entry) => entry.source === "profile")).toBe(true);
      const policies = await listEntries("?kind=policy");
      expect(policies.some((entry) => entry.answer.includes("不编造公司资质"))).toBe(true);
    });

    it("档案不存在时返回 404", async () => {
      const response = await api().post("/api/v1/training/library/import").send({ profileId: "trn_0000000000000000" }).expect(404);
      expect(response.body).toMatchObject({ code: "TRAINING_PROFILE_NOT_FOUND" });
    });
  });

  describe("导出 Markdown 知识包", () => {
    it("按 政策 → 禁用语 → 问答对 → 口径片段 的顺序分区", async () => {
      const response = await api().get("/api/v1/training/library/export.md").expect(200);
      expect(response.headers["content-type"]).toContain("text/markdown");
      const markdown = response.text;
      expect(markdown).toContain("# 自动回复训练库");
      const order = ["## 政策（必须遵守）", "## 禁用语 / 红线", "## 标准问答对", "## 口径片段"].map((heading) => markdown.indexOf(heading));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((left, right) => left - right));
      expect(markdown).toContain("我们承担全部损失");
      expect(markdown).toContain("最小的机型是 X-20。");
    });
  });

  describe("训练库驱动的自动回复", () => {
    beforeAll(async () => {
      await api().put("/api/v1/auto-chat/settings").send({
        enabled: true,
        mode: "auto",
        engine: "rules",
        accountId: null,
        profileId: profile.id,
        confidenceThreshold: 0.5,
        // 三条都是为了确定性：不限时（起止相同即「不限时段」）、不限间隔（否则第一条发出后
        // 后续用例会被「距上一条不足 N 分钟」拦下，断言全变）、不限每日条数。
        activeHoursStart: 0,
        activeHoursEnd: 0,
        minIntervalMinutes: 0,
        dailyLimit: 0
      }).expect(200);
    });

    afterAll(async () => {
      await api().put("/api/v1/auto-chat/settings").send({ enabled: false, mode: "off", accountId: null }).expect(200);
    });

    it("命中训练库问答时，规则通道直接用库里的口径回复并自动发出", async () => {
      const question = "What is your minimum order quantity?";
      const answer = "Our minimum order quantity is 10 units for a trial order.";
      await createEntry({ kind: "qa", question, answer }).expect(201);

      const draft = await inboundAndWait("+8613900001001", question);
      // 库里的口径就是回复本身（这比从聊天记录里抽出来的样本更可信，所以训练库优先）。
      expect(draft.body).toBe(answer);
      expect(draft.engine).toBe("rules");
      expect(draft.reason).toContain("训练库匹配");
      expect(draft.confidence).toBeGreaterThanOrEqual(0.5);
      expect(draft.status).toBe("sent");

      const conversation = (await api().get("/api/v1/conversations").expect(200)).body as Conversation[];
      const mine = conversation.find((item) => item.id === draft.conversationId)!;
      const messages = (await api().get(`/api/v1/conversations/${mine.id}/messages`).expect(200)).body as ChatMessage[];
      expect(messages.filter((message) => message.direction === "outbound").map((message) => message.body)).toContain(answer);
    });

    it("回复里出现训练库禁用短语时，不自动发送，只留草稿", async () => {
      const question = "Do you offer free shipping to Spain?";
      await createEntry({ kind: "qa", question, answer: "Yes, we always offer free shipping to Spain." }).expect(201);
      await createEntry({ kind: "forbidden", answer: "free shipping" }).expect(201);

      const draft = await inboundAndWait("+8613900001002", question);
      expect(draft.body).toBe("Yes, we always offer free shipping to Spain.");
      expect(draft.status).toBe("pending");
      expect(draft.status).not.toBe("sent");
      expect(draft.error).toContain("禁用语");
      expect(draft.reason).toContain("禁用语");
    });

    it("客户消息命中禁用场景时，不生成回复，直接转人工", async () => {
      // 刻意不夹带升级关键词（lawyer / refund 之类）：那条路径会更早拦下，
      // 就测不到「训练库禁用场景」这一层了。
      const draft = await inboundAndWait("+8613900001003", "Is this a counterfeit product?");
      expect(draft.body).toBe("");
      expect(draft.status).toBe("pending");
      expect(draft.engine).toBe("rules");
      expect(draft.confidence).toBe(0);
      expect(draft.error).toContain("禁用场景");
      expect(draft.reason).toContain("禁用场景");
      expect(draft.reason).toContain("转人工");
    });

    it("库里没有相近问法时不硬回，留一条请人工处理的草稿", async () => {
      const draft = await inboundAndWait("+8613900001004", "Could you send me the customs paperwork for Bolivia?");
      expect(draft.body).toBe("");
      expect(draft.status).toBe("pending");
      expect(draft.confidence).toBeLessThan(0.5);
      expect(draft.reason).toContain("人工");
    });
  });

  describe("训练档案推送（web-import，扩展归档 → CRM）", () => {
    const importBody = () => ({
      name: "浏览器归档档案",
      tone: "专业",
      summary: "来自 WhatsApp Web 归档的训练档案。",
      guidelines: ["回复保持英文"],
      guardrails: ["不承诺交期"],
      languages: ["en"],
      examples: [
        { inbound: "What is your MOQ?", reply: "Our MOQ is 500 pieces per design.", score: 0.9 },
        { inbound: "How long is the lead time?", reply: "Usually 25 days after deposit.", score: 0.8 }
      ],
      stats: { conversations: 2, messages: 12, exchanges: 4, samples: 2 }
    });

    it("首次推送：建档（engine=web-import）+ 问答样本进训练库", async () => {
      const response = await api().post("/api/v1/training/profiles/import").send(importBody()).expect(201);
      expect(response.body.updated).toBe(true);
      expect(response.body.profile.engine).toBe("web-import");
      expect(response.body.profile.sampleCount).toBe(2);
      expect(response.body.library.created).toBeGreaterThanOrEqual(2);
      expect(response.body.library.skipped).toBe(0);

      const entries = await listEntries();
      expect(entries.find((entry) => entry.question === "What is your MOQ?")).toBeTruthy();
      const policies = entries.filter((entry) => entry.kind === "policy");
      expect(policies.some((entry) => entry.answer.includes("不承诺交期"))).toBe(true);
    });

    it("同内容重复推送：内容指纹一致 → 200 且不重复入库", async () => {
      const before = (await listEntries()).length;
      const response = await api().post("/api/v1/training/profiles/import").send(importBody()).expect(200);
      expect(response.body.updated).toBe(false);
      expect(response.body.library).toBeNull();
      expect((await listEntries()).length).toBe(before);
    });

    it("内容变化后推送：原位更新档案，训练库只补新增的部分", async () => {
      const body = importBody();
      body.examples.push({ inbound: "Do you offer OEM service?", reply: "Yes, we support OEM with your logo.", score: 0.7 });
      const response = await api().post("/api/v1/training/profiles/import").send(body).expect(201);
      expect(response.body.updated).toBe(true);
      expect(response.body.profile.sampleCount).toBe(3);
      expect(response.body.library.created).toBe(1);
      const entries = await listEntries();
      expect(entries.filter((entry) => entry.answer.includes("OEM with your logo")).length).toBe(1);
    });

    it("超过 200 组样本会被 422 拒收（上限在服务端兜底）", async () => {
      const body = importBody();
      body.examples = Array.from({ length: 201 }, (_, index) => ({
        inbound: `Question ${index}`,
        reply: `Answer ${index}`
      }));
      const response = await api().post("/api/v1/training/profiles/import").send(body).expect(400);
      expect(response.body.code).toBe("INVALID_REQUEST");
    });
  });

  describe("跨语言检索（词典扩展）", () => {
    it("英文 MOQ 问句能命中中文问答对（扩展前这两侧共同特征恒 0）", async () => {
      await createEntry({ kind: "qa", question: "起订量是多少？", answer: "我们的起订量是 500 个。" }).expect(201);
      const result = await match("What's your MOQ for this item?");
      // 同语言的英文条目（别的用例造的）排在前面很正常；这里断言的是**中文条目也进来了**。
      const hit = result.hits.find((item) => item.entry.question.includes("起订量"));
      expect(hit).toBeTruthy();
      expect(hit!.expandedHits ?? 0).toBeGreaterThan(0);
      expect(result.verdict).toContain("词典等价命中");
    });

    it("中文问句也能命中英文问答对（词典双向）", async () => {
      await createEntry({ kind: "qa", question: "What is your lead time for bulk orders?", answer: "Usually 25 days." }).expect(201);
      const result = await match("你们交期多久？");
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0].entry.question).toContain("lead time");
    });

    it("只蹭到 1 个扩展词的候选过不了门槛（防误召回）", async () => {
      await createEntry({ kind: "qa", question: "价格怎么样", answer: "价格面议。" }).expect(201);
      // 触发 price→价格 扩展，但扩展命中只有「价格」1 个特征（< 2 门槛）
      const result = await match("Could you send me a price list when convenient please");
      expect(result.hits).toHaveLength(0);
    });

    it("红线（forbidden）不做词典扩展：宁漏勿错", async () => {
      await createEntry({ kind: "forbidden", question: "counterfeit", answer: "假货" }).expect(201);
      // 客户中文问「这是不是仿品/假货」——仿品不在词典里，禁用场景**不该**被扩展词误触发
      const result = await match("Is this a replica product?");
      expect(result.forbidden).toHaveLength(0);
    });
  });
});
