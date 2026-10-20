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
    profile = ((await api().post("/api/v1/training/profiles").send({ name: "训练库回测档案", useAi: false }).expect(201)).body as { profile: TrainingProfile }).profile;
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

    it("出处三件套随发布入库：列表保留、编辑不抹掉、引用带出去", async () => {
      const source = { sourceTitle: "付款条款汇总.docx", sourceAnchor: "§3", sourceNote: "2026-10 客户 Anna 邮件确认" };
      const created = (await createEntry({
        kind: "qa",
        question: "训练出处探针：定金比例是多少？",
        answer: "常规是 30% 定金，发货前结清余款。",
        ...source
      }).expect(201)).body as TrainingLibraryEntry;
      expect(created.sourceTitle).toBe(source.sourceTitle);
      expect(created.sourceAnchor).toBe(source.sourceAnchor);
      expect(created.sourceNote).toBe(source.sourceNote);

      // 出处是观测数据：编辑答法（不带出处）不能把它抹掉。
      const updated = (await api()
        .patch(`/api/v1/training/library/${created.id}`)
        .send({ kind: "qa", question: "训练出处探针：定金比例是多少？", answer: "常规是 30% 定金，余款见提单副本结清。" })
        .expect(200)).body as TrainingLibraryEntry;
      expect(updated.sourceTitle).toBe(source.sourceTitle);
      expect(updated.sourceNote).toBe(source.sourceNote);

      // 引用带出处：前端引用卡片靠它显示「《文件》§段落 · 描述」。
      const result = await match("训练出处探针：定金比例");
      const citation = result.citations.find((item) => item.refId === created.id);
      expect(citation).toBeTruthy();
      expect(citation!.sourceTitle).toBe(source.sourceTitle);
      expect(citation!.sourceAnchor).toBe(source.sourceAnchor);
      expect(citation!.sourceNote).toBe(source.sourceNote);
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

      // 导入进的是**候选池**：默认列表（= 提示词同口径，只出 active）里看不到它们。
      const active = await listEntries("?kind=qa&enabled=true");
      expect(active.some((entry) => entry.source === "profile")).toBe(false);
      const imported = await listEntries("?kind=qa&status=candidate");
      expect(imported.some((entry) => entry.source === "profile")).toBe(true);
      // 候选一律 enabled=false：检索路径读 enabled，状态过滤读 status，两个都得拦住。
      expect(imported.filter((entry) => entry.source === "profile").every((entry) => entry.enabled === false)).toBe(true);

      const policies = await listEntries("?kind=policy&status=candidate");
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

      // 推送进来的样本同样只进候选池（默认列表读不到），要带 status=all 才看得到全量。
      const entries = await listEntries("?status=all");
      expect(entries.find((entry) => entry.question === "What is your MOQ?")).toBeTruthy();
      const policies = entries.filter((entry) => entry.kind === "policy");
      expect(policies.some((entry) => entry.answer.includes("不承诺交期"))).toBe(true);
    });

    it("候选不进检索；确认后才生效，丢弃则归档留痕", async () => {
      const candidates = await listEntries("?kind=qa&status=candidate");
      const sample = candidates.find((entry) => entry.question === "What is your MOQ?")!;
      expect(sample).toBeTruthy();
      expect(sample.enabled).toBe(false);
      // 候选不参与命中：resolve 走 enabled=1 且 status=active
      expect((await match(sample.question)).hits.map((hit) => hit.entry.id)).not.toContain(sample.id);

      const confirmed = (await api()
        .post("/api/v1/training/library/confirm")
        .send({ ids: [sample.id], action: "confirm" })
        .expect(200)).body as { changed: number; status: string };
      // 一次动作要同时翻 status 与 enabled，否则「确认」看起来没反应（条目既不进列表也不进提示词）
      expect(confirmed).toMatchObject({ changed: 1, status: "active" });
      const promoted = (await listEntries("?kind=qa&status=all")).find((entry) => entry.id === sample.id)!;
      expect(promoted).toMatchObject({ status: "active", enabled: true });
      expect((await match(sample.question)).hits.map((hit) => hit.entry.id)).toContain(sample.id);

      // 复原成归档，避免这条英文问答影响后面「跨语言检索」的排序断言
      await api().post("/api/v1/training/library/confirm").send({ ids: [sample.id], action: "drop" }).expect(200);
      const dropped = (await listEntries("?kind=qa&status=all")).find((entry) => entry.id === sample.id)!;
      expect(dropped).toMatchObject({ status: "archived", enabled: false });
      // 丢弃是「留痕」不是删除：行还在，指纹还在，下次导入不会又把它加回来
      expect((await match(sample.question)).hits.map((hit) => hit.entry.id)).not.toContain(sample.id);
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
      const entries = await listEntries("?status=all");
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

  describe("来源证明（P0：citations 与四类命中计数）", () => {
    /**
     * ⚠️ 本组里「四类命中都真的计入 hit_count」必须走**真实生成链路**（入站 → 生成 → 发出），
     * 而那条路要求自动聊是开着的。上一组 `训练库驱动的自动回复` 的 afterAll 已把设置关成
     * `enabled:false / mode:"off"`（describe 之间互不可见），所以这里必须**自己再打开一次**：
     * 否则入站消息进不了 `processCandidate`（第一行就 `mode === "off"` 早退），草稿永不出现，
     * `inboundAndWait` 会直接超时（实测踩过：干净态也红，一度误判成代码的锅）。
     * 其余用例只调 match()，不依赖开关，开着无副作用（autoChatSweep=false，没有后台轮询）。
     */
    beforeAll(async () => {
      await api().put("/api/v1/auto-chat/settings").send({
        enabled: true,
        mode: "auto",
        engine: "rules",
        accountId: null,
        profileId: profile.id,
        confidenceThreshold: 0.5,
        activeHoursStart: 0,
        activeHoursEnd: 0,
        minIntervalMinutes: 0,
        dailyLimit: 0
      }).expect(200);
    });

    afterAll(async () => {
      await api().put("/api/v1/auto-chat/settings").send({ enabled: false, mode: "off", accountId: null }).expect(200);
    });

    /**
     * 命中/采纳计数是 **fire-and-forget**（`void recordHits().catch()`，刻意不 await ——
     * 计数绝不允许拖慢回复）。所以断言必须"等到才判"，不能读一次就下结论：
     * 读太早看到 0 是时序问题，不是功能坏了。
     */
    const waitForEntries = async (
      predicate: (entries: TrainingLibraryEntry[]) => boolean,
      timeoutMs = 5_000
    ): Promise<TrainingLibraryEntry[]> => {
      const deadline = Date.now() + timeoutMs;
      let latest = await listEntries("?status=all");
      while (!predicate(latest) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        latest = await listEntries("?status=all");
      }
      return latest;
    };

    /**
     * 这一组测的是「用户能不能自己核验回复」。
     * 判据全部落在**可回指**上：一个出处若指不回库里的条目，它就只是一段好看的文字。
     */
    it("试问一句带回 citations，每条都含 refId/标题/切片/命中词，且都能回指到库里的条目", async () => {
      const created = (await createEntry({
        kind: "qa",
        question: "你们支持定制外箱印刷吗？",
        answer: "支持定制外箱印刷，起订量 500 个。"
      }).expect(201)).body as TrainingLibraryEntry;

      const result = await match("我们想在外箱上印我们的 logo，可以定制吗");
      const citation = result.citations.find((item) => item.refId === created.id);
      expect(citation).toBeTruthy();
      expect(citation!.sourceType).toBe("training_library");
      expect(citation!.kind).toBe("qa");
      // 标题用**客户问法**：用户认得出这条的唯一线索是「客户这么问过」。
      expect(citation!.title).toBe("你们支持定制外箱印刷吗？");
      expect(citation!.snippet).toContain("起订量 500");
      expect(citation!.score).toBeGreaterThan(0);
      // 命中词是「为什么是它」的唯一可核验证据，空数组就等于没有可解释性。
      expect(citation!.hitTerms.length).toBeGreaterThan(0);
      // 人工录入 = 校订过；这一点必须如实带出去，否则用户分不清人的口径与机器的猜测。
      expect(citation!.verified).toBe(true);
      expect(citation!.adopted).toBe(false);

      // 反向核验：每个出处都要能在库里查到（杜绝凭空造出来的出处）。
      const entries = await listEntries("?status=all");
      const ids = new Set(entries.map((entry) => entry.id));
      expect(result.citations.every((item) => ids.has(item.refId))).toBe(true);
    });

    it("检测前置返回的 citations 与检测后返回的 citations 完全一致（试问与实跑同源）", async () => {
      // 同一条问法走两次：只要 citations 还是从 resolve() 一处出来的，两次必然逐字段相同。
      // 若哪天有人为了「试问界面好看」在旁边另拼一份，这条断言会立刻红。
      const first = await match("请问最小起订量是多少");
      const second = await match("请问最小起订量是多少");
      expect(second.citations).toEqual(first.citations);
    });

    it("四类命中都真的计入 hit_count（旧版只有问答对计数，政策/口径永远是 0）", async () => {
      // 「交期口径」「报价权限」在整个文件里被 resolve 读过很多次（每次生成草稿都会带上它们），
      // 但 P0 之前它们一次都不计数 —— 这正是「清理死条目」会误杀天天在用的政策的原因。
      //
      // ⚠️ 这条判据必须用**新建的**条目：文件更早处有一条用例直接调过 `recordHits([policyId])`，
      // 老条目上的 hit_count 会被那一次污染，写成"大于 0"就永远绿（实测踩过：故意弄坏政策计数，
      // 用例照样通过）。新建条目的计数只能来自真实链路。
      const fresh = (await createEntry({
        kind: "snippet",
        question: "包装口径（P0 计数探针）",
        answer: "外箱一律用五层瓦楞，木箱按需另计。"
      }).expect(201)).body as TrainingLibraryEntry;
      expect(fresh.hitCount).toBe(0);

      // 走**真实生成链路**（入站消息 → 生成 → 发出），不是直接调 recordHits。
      const draft = await inboundAndWait("+8613900001099", "What is your minimum order quantity?");
      expect(draft.status).toBe("sent");

      const entries = await waitForEntries((list) =>
        list.some((entry) => entry.id === fresh.id && entry.hitCount > 0)
      );
      const counted = entries.find((entry) => entry.id === fresh.id)!;
      // 口径片段不该命中任何问法，但**每次生成都会进提示词** —— 它必须计数，
      // 否则「这条口径有没有在用」在数据上永远看不出来。
      expect(counted.hitCount).toBeGreaterThan(0);
      expect(counted.lastHitAt).toBeTruthy();
    });

    it("命中与采纳分开记：草稿真的发出去才会涨 adopted_count", async () => {
      const entries = await waitForEntries((list) => list.some((entry) => entry.adoptedCount > 0));
      const adopted = entries.filter((entry) => entry.adoptedCount > 0);
      // 前面「训练库驱动的自动回复」里那条 MOQ 问答是**真的发出去**的（draft.status=sent）。
      expect(adopted.length).toBeGreaterThan(0);
      expect(adopted.every((entry) => Boolean(entry.lastAdoptedAt))).toBe(true);
      // 被采纳的必然也被命中过：两个计数不能出现「采纳了但没命中」的鬼数据。
      expect(adopted.every((entry) => entry.hitCount > 0)).toBe(true);
      // 反向：命中次数远多于采纳次数是常态（读了 5 条、只用了 1 条），
      // 所以不能反过来要求 hitCount === adoptedCount —— 这里钉住这条语义。
      expect(entries.some((entry) => entry.hitCount > entry.adoptedCount)).toBe(true);
    });

    it("候选池里的条目不出现在 citations 里（人工确认这道闸门对出处同样生效）", async () => {
      const candidates = await listEntries("?kind=qa&status=candidate");
      expect(candidates.length).toBeGreaterThan(0);
      const result = await match("What is your MOQ?");
      const candidateIds = new Set(candidates.map((entry) => entry.id));
      expect(result.citations.some((item) => candidateIds.has(item.refId))).toBe(false);
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

  /**
   * 知识库（训练成果的跨账号分享）：**启用清单决定出稿读哪些语料**。
   *
   * 这一组刻意走 `runtime.repository` + `runtime.trainingLibrary.resolve` 而不是 HTTP：
   * 需要两个不同 owner 的语料同时存在，而 HTTP 侧的身份由令牌决定（测试态固定成 test-user）。
   * 判据落在 resolve 的**实际命中**与 `kbScope` 的回报上，两者缺一不可 ——
   * 只看命中数无法区分"被清单挡掉"与"根本没这条语料"。
   */
  describe("知识库启用清单与跨账号分享", () => {
    const OWNER = "u_kb_owner";
    const READER = "u_kb_reader";
    // ⚠️ 两个问法的词面必须**完全不相交**：中文按相邻两字切特征，
    // 两句都含"知识/专用/问法"时共享 5 个特征就会被正常命中，
    // 于是"被清单挡掉"与"命中了别的条目"混在一起，判据立刻失真（实测踩过）。
    const SHARED_QUESTION = "zulu shared knowledge entry";
    const PRIVATE_QUESTION = "yankee private warranty item";

    const seed = async (kbId: string, question: string) => {
      const now = new Date().toISOString();
      await runtime.repository.saveTrainingLibraryEntry({
        id: `tle_${kbId || "legacy"}_${question.length}`,
        ownerUserId: OWNER,
        accountId: null,
        accountName: null,
        kbId,
        kind: "qa",
        question,
        answer: `${question} 的标准答法`,
        tags: [],
        languages: ["zh"],
        priority: 100,
        enabled: true,
        status: "active",
        source: "manual",
        verified: true,
        hitCount: 0,
        adoptedCount: 0,
        lastHitAt: null,
        lastAdoptedAt: null,
        createdAt: now,
        updatedAt: now,
        fingerprint: `fp_${kbId || "legacy"}_${question.length}`
      });
    };

    beforeAll(async () => {
      await seed("kb_shared_x", SHARED_QUESTION);
      await seed("kb_private_y", PRIVATE_QUESTION);
    });

    it("未配置清单时按兼容口径：别人库的语料一条都不参与（分享必须先勾选）", async () => {
      const result = await runtime.trainingLibrary.resolve(READER, SHARED_QUESTION);
      expect(result.hits).toHaveLength(0);
      expect(result.kbScope?.configured).toBe(false);
      // ⚠️ 默认口径（从未同步过清单）**不许报警告**：它就是本改动之前的行为，
      // 且是绝大多数账号的默认状态。写成 warnings 会让一条永不消失的"告警"
      // 常驻每次试问，把真正该看的那条（「有 N 条因所属知识库未启用而未参与」）淹掉。
      // 这个事实由 kbScope 结构化回报，界面按"检索范围"中性表述。
      expect(result.warnings?.some((warning) => warning.includes("尚未同步"))).toBe(false);
      expect(result.warnings?.some((warning) => warning.includes("未分组"))).toBe(false);
    });

    it("勾选别人公开的库之后，它的语料才进检索", async () => {
      await runtime.repository.replaceTrainingKbSubscriptions(READER, ["kb_shared_x"]);
      const result = await runtime.trainingLibrary.resolve(READER, SHARED_QUESTION);
      expect(result.hits.map((hit) => hit.entry.question)).toContain(SHARED_QUESTION);
      expect(result.kbScope?.enabledKbIds).toEqual(["kb_shared_x"]);
      expect(result.kbScope?.considered).toBeGreaterThan(0);
    });

    it("把清单换成别的库：原库语料退出检索，并被如实计入 skippedByScope", async () => {
      // 用 OWNER 自己当读者：只有「自己的语料」是插件**能完整枚举**的集合，
      // 别放弃订阅的库连行都取不到（插件不知道库的可见性），所以"被挡掉几条"只对自己的语料有意义。
      await runtime.repository.replaceTrainingKbSubscriptions(OWNER, ["kb_private_y"]);
      const result = await runtime.trainingLibrary.resolve(OWNER, SHARED_QUESTION);
      expect(result.hits).toHaveLength(0);
      expect(result.kbScope?.skippedByScope).toBe(1);
      expect(result.warnings?.some((warning) => warning.includes("未启用而未参与"))).toBe(true);
    });

    it("零启用（写成哨兵行）与从未配置是两种状态：前者一个库都不读", async () => {
      await runtime.repository.replaceTrainingKbSubscriptions(READER, []);
      const rows = await runtime.repository.listTrainingKbSubscriptionRows(READER);
      expect(rows).toEqual([""]);
      const result = await runtime.trainingLibrary.resolve(READER, PRIVATE_QUESTION);
      expect(result.hits).toHaveLength(0);
      expect(result.kbScope?.configured).toBe(true);
      expect(result.kbScope?.enabledKbIds).toEqual([]);
      expect(result.warnings?.some((warning) => warning.includes("一个知识库都没启用"))).toBe(true);
    });

    it("未分组的自有语料始终参与：它们不属于任何知识库，不会被清单关掉", async () => {
      await seed("", SHARED_QUESTION);
      await runtime.repository.replaceTrainingKbSubscriptions(READER, ["kb_nothing"]);
      const result = await runtime.trainingLibrary.resolve(OWNER, SHARED_QUESTION);
      expect(result.hits.map((hit) => hit.entry.question)).toContain(SHARED_QUESTION);
      expect(result.hits.every((hit) => hit.entry.kbId === "")).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("未分组语料始终参与"))).toBe(true);
    });

    /**
     * ⚠️ 这条是**真机验收抓出来的**：`inScope` 的三目只判了 `subscribed.length`，
     * 于是「已配置 + 零启用」（只写了哨兵行）并进了「从未配置」那一档（`p.owner_user_id=$1`）——
     * 表现是「我已经把这个知识库关掉了，它里面的语料照样进出稿提示词」。
     *
     * 下面这个断言只用 READER 是抓不到的（READER 本来就没有自有语料，两种写法它都是 0 命中），
     * 必须用**语料所有者**当读者：只有自己的语料是插件能完整枚举的集合。
     */
    it("零启用只留未分组的自有语料：带 kb_id 的自有语料必须退出，并被计入 skippedByScope", async () => {
      await runtime.repository.replaceTrainingKbSubscriptions(OWNER, []);
      // ① 带 kb_id 的自有语料（kb_private_y）退出检索
      const kbScoped = await runtime.trainingLibrary.resolve(OWNER, PRIVATE_QUESTION);
      expect(kbScoped.kbScope?.configured).toBe(true);
      expect(kbScoped.kbScope?.enabledKbIds).toEqual([]);
      expect(kbScoped.hits).toHaveLength(0);
      expect(kbScoped.kbScope?.skippedByScope).toBeGreaterThanOrEqual(1);
      expect(kbScoped.warnings?.some((warning) => warning.includes("未启用而未参与"))).toBe(true);
      // ② 反证：未分组的那条（不属于任何知识库）仍在 —— "关掉"关的是库，不是连坐所有语料
      const ungrouped = await runtime.trainingLibrary.resolve(OWNER, SHARED_QUESTION);
      expect(ungrouped.hits.map((hit) => hit.entry.question)).toContain(SHARED_QUESTION);
      expect(ungrouped.hits.every((hit) => hit.entry.kbId === "")).toBe(true);
    });
  });
});
