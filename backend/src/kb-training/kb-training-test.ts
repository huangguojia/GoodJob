import assert from "node:assert/strict";
import {
  candidateFingerprint,
  buildKbPrompt,
  extractJsonObject,
  hitsCommercialRedline,
  parseKbOutput,
  segmentDocuments,
  shouldPreselect,
  KB_SEGMENTS_PER_CALL
} from "./kb-training-prompt.js";
import {
  setKbTrainingRepository,
  type KbKnowledgeBase,
  type KbTrainingCandidate,
  type KbTrainingRun,
  type MysqlKbTrainingRepository
} from "./kb-training-repository.js";
import {
  collectSourceItems,
  executeKbTrainingRun,
  publishKbCandidates,
  type KbAssetRef,
  type KbTrainingDeps,
  type KbTrainingSourceSpec
} from "./kb-training-service.js";
import {
  defaultKnowledgeBaseName,
  deleteKnowledgeBase,
  renameOrShareKnowledgeBase,
  resolveKnowledgeBaseForRun,
  saveEnabledKnowledgeBases
} from "./kb-knowledge-base-service.js";
import type { AiModelConfig } from "../types.js";

// ---------------------------------------------------------------------------
// 知识库训练的回归自测。
//
// 分两段，因为它们的**失败方式**完全不同：
//  1. 纯函数（分段 / 提示词 / 输出校验 / 预勾选）—— 脱离环境，判据最硬；
//  2. 编排（引擎降级 / 计数 / 出处门槛 / 发布）—— 用窄接口替身固定行为。
//
// ⚠️ 替身**只**实现 service 真正调用的方法，刻意不模仿 MySQL 的唯一键与 JSON 列行为；
// 那两层由「双库迁移 + 现场端到端」覆盖（脚本化替身去模仿 SQL 只会让我们测自己写的桩）。
// ---------------------------------------------------------------------------

// ===========================================================================
// 一、纯函数
// ===========================================================================

// --- extractJsonObject：模型经常把 JSON 包在围栏里或前后带客套话 -------------
assert.deepEqual(extractJsonObject('{"candidates":[]}'), { candidates: [] });
assert.deepEqual(extractJsonObject('```json\n{"candidates":[]}\n```'), { candidates: [] });
assert.deepEqual(extractJsonObject('好的，结果如下：\n{"candidates":[{"kind":"qa"}]}\n以上。'), { candidates: [{ kind: "qa" }] });
assert.equal(extractJsonObject("模型今天不想干活"), null);
assert.equal(extractJsonObject("{坏掉的 JSON"), null);
assert.equal(extractJsonObject(""), null);

// --- segmentDocuments：结构感知分段 ----------------------------------------
{
  const long = "甲".repeat(900);
  const { segments, truncated } = segmentDocuments([
    { title: "手册", body: "第一段。\n\n第二段。\n\n\n  第三段。  ", assetId: "k_1", version: "v2" }
  ]);
  assert.equal(truncated, false);
  assert.equal(segments.length, 1, "三段合起来没超预算，应当合并为一段（不硬切）");
  assert.equal(segments[0].anchor, "§1");
  assert.equal(segments[0].assetId, "k_1");
  assert.equal(segments[0].version, "v2");
  assert.ok(segments[0].text.includes("第三段"), "空行与缩进要被规整掉");

  // 只有一个段落超预算时才按句末标点退化切分
  const { segments: split } = segmentDocuments([{ title: "长段", body: `${long}。${long}。` }]);
  assert.ok(split.length >= 2, "超长段落必须被切开，否则会顶爆提示词预算");
  assert.ok(split.every((segment) => segment.text.length <= 1_200), "每段都不得超过单段上限");
}

// --- buildKbPrompt：必须带编号（模型回引 source_seg 的唯一依据）--------------
{
  const { segments } = segmentDocuments([{ title: "手册", body: "A 段。\n\nB 段。" }]);
  const prompt = buildKbPrompt(segments);
  assert.ok(prompt.includes("[1]"), "段落编号必须出现在提示词里");
  assert.ok(prompt.includes("source_seg"), "必须要求模型回引段落编号");
  assert.ok(prompt.includes("宁缺勿造"), "必须写清「资料里没有就别编」");
}

// --- parseKbOutput：模型输出一律不可信，逐条校验 ----------------------------
{
  // 三段各约 700 字 → 各成一段（否则会被合并，source_seg 的合法区间就不是 1..3）
  const { segments } = segmentDocuments([
    { title: "手册", body: "甲".repeat(700) },
    { title: "手册", body: "乙".repeat(700) },
    { title: "手册", body: "丙".repeat(700) }
  ]);
  assert.equal(segments.length, 3, "三个约 700 字的段落应当各成一段");
  const result = parseKbOutput(JSON.stringify({
    candidates: [
      { kind: "qa", question: "起订量多少", answer: "500 个起订。", confidence: 0.95, source_seg: 1 },
      { kind: "snippet", question: "付款", answer: "30% 定金。", confidence: 0.8, source_seg: 2 },
      { kind: "qa", question: "缺答法", confidence: 0.9, source_seg: 1 },
      { kind: "qa", question: "缺置信度", answer: "不知道。", source_seg: 1 },
      { kind: "invented_kind", question: "未知类型", answer: "x", confidence: 0.9, source_seg: 1 },
      { kind: "qa", question: "只有一个问法", answer: "", confidence: 0.9, source_seg: 1 },
      { kind: "qa", question: "越界出处", answer: "编的。", confidence: 0.9, source_seg: 99 },
      "不是对象"
    ]
  }), segments);
  assert.equal(result.error, "");
  assert.equal(result.items.length, 2, "只有前两条是合法且可回指的");
  assert.equal(result.discarded, 6, "缺答法/缺置信度/未知 kind/空答法/越界/非对象 全部要丢");
  assert.equal(result.invented, 1, "越界出处单独计数（这条答案在资料里没有依据）");
  assert.equal(result.items[0].fingerprint.length, 32);
  assert.equal(result.items[0].segmentOrdinal, 1);

  // 越界出处的判据必须只可能来自真实链路：把越界改成合法编号后 invented 归零
  const fixed = parseKbOutput(JSON.stringify({
    candidates: [{ kind: "qa", question: "越界出处", answer: "编的。", confidence: 0.9, source_seg: 3 }]
  }), segments);
  assert.equal(fixed.invented, 0);
  assert.equal(fixed.items.length, 1);

  // 置信度超范围要夹到 [0,1]，不能让 1.5 这种值进库
  const clamped = parseKbOutput(JSON.stringify({
    candidates: [{ kind: "policy", answer: "不得报价。", confidence: 1.5, source_seg: 1 }]
  }), segments);
  assert.equal(clamped.items[0].confidence, 1);

  // 整批坏掉时必须有 error（调用方据此把这批段数计入 skipped，而不是当成"成功 0 条"）
  const broken = parseKbOutput("我觉得这个资料很好", segments);
  assert.ok(broken.error, "解析不出来必须有 error");
  assert.equal(broken.items.length, 0);

  const wrongShape = parseKbOutput(JSON.stringify({ result: [] }), segments);
  assert.ok(wrongShape.error.includes("candidates"));
}

// --- 指纹与插件同口径（空白折叠 + 小写）------------------------------------
assert.equal(
  candidateFingerprint("qa", "  What  is   MOQ?  ", "500  PCS"),
  candidateFingerprint("qa", "what is moq?", "500 pcs"),
  "空白与大小写差异不能绕过幂等"
);
assert.notEqual(candidateFingerprint("qa", "甲", "乙"), candidateFingerprint("snippet", "甲", "乙"));

// --- 商务红线与预勾选 ------------------------------------------------------
assert.ok(hitsCommercialRedline("我们的价格可以再谈"));
assert.ok(hitsCommercialRedline("We can offer a discount"));
assert.ok(!hitsCommercialRedline("外箱一律用五层瓦楞"));

assert.equal(shouldPreselect({ confidence: 0.95, sourceType: "file", question: "包装", answer: "五层瓦楞" }), true);
assert.equal(shouldPreselect({ confidence: 0.8, sourceType: "file", question: "包装", answer: "五层瓦楞" }), false, "置信度不够不许预勾选");
assert.equal(shouldPreselect({ confidence: 0.99, sourceType: "conversation", question: "包装", answer: "五层瓦楞" }), false, "会话来源不预勾选");
assert.equal(shouldPreselect({ confidence: 0.99, sourceType: "file", question: "价格", answer: "可以打折" }), false, "命中商务红线不预勾选");

// ===========================================================================
// 二、编排（窄接口替身）
// ===========================================================================

interface FakeState {
  runs: Map<string, KbTrainingRun>;
  candidates: KbTrainingCandidate[];
  /** 知识库：id → 库 */
  knowledgeBases: Map<string, KbKnowledgeBase>;
  /** 账号启用清单：userId → kbId 集合。**集合为空 = 一个都没启用**（合法状态）。 */
  enabled: Map<string, Set<string>>;
  /** 已被请求取消的批次（取消是请求，执行器在下一批开始前才会停）。 */
  cancelled: Set<string>;
}

function createFakeRepository(): { state: FakeState; repository: MysqlKbTrainingRepository } {
  const state: FakeState = { runs: new Map(), candidates: [], knowledgeBases: new Map(), enabled: new Map(), cancelled: new Set() };
  let seq = 0;
  const fake = {
    async createKnowledgeBase(input: { teamId: string; ownerId: string; name: string; visibility: string; runId: string }): Promise<KbKnowledgeBase> {
      seq += 1;
      const kb: KbKnowledgeBase = {
        id: `kb_test_fake_${seq}`,
        teamId: input.teamId,
        ownerId: input.ownerId,
        name: input.name,
        visibility: input.visibility === "team" ? "team" : "owner",
        runId: input.runId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.knowledgeBases.set(kb.id, kb);
      // 与真实仓储同语义：建库的人自己默认启用。
      if (!state.enabled.has(kb.ownerId)) state.enabled.set(kb.ownerId, new Set());
      state.enabled.get(kb.ownerId)!.add(kb.id);
      return kb;
    },
    async getKnowledgeBase(id: string, teamId: string) {
      const kb = state.knowledgeBases.get(id);
      return kb && kb.teamId === teamId ? kb : null;
    },
    async listKnowledgeBases(teamId: string, viewerId: string) {
      const mine = [...state.knowledgeBases.values()].filter(
        (kb) => kb.teamId === teamId && (kb.ownerId === viewerId || kb.visibility === "team")
      );
      const enabled = state.enabled.get(viewerId) ?? new Set<string>();
      return mine.map((kb) => ({
        ...kb,
        ownerName: kb.ownerId,
        isOwner: kb.ownerId === viewerId,
        enabled: enabled.has(kb.id),
        entryCount: 0,
        pendingCount: 0
      }));
    },
    async updateKnowledgeBase(id: string, teamId: string, ownerId: string, patch: { name?: string; visibility?: string }) {
      const kb = state.knowledgeBases.get(id);
      if (!kb || kb.teamId !== teamId || kb.ownerId !== ownerId) return false;
      state.knowledgeBases.set(id, {
        ...kb,
        name: patch.name ?? kb.name,
        visibility: (patch.visibility as KbKnowledgeBase["visibility"]) ?? kb.visibility,
        updatedAt: new Date().toISOString()
      });
      return true;
    },
    async attachKnowledgeBaseRun(id: string, runId: string, teamId: string, ownerId: string) {
      const kb = state.knowledgeBases.get(id);
      if (!kb || kb.teamId !== teamId || kb.ownerId !== ownerId) return false;
      state.knowledgeBases.set(id, { ...kb, runId });
      return true;
    },
    async listEnabledKnowledgeBaseIds(userId: string) {
      return [...(state.enabled.get(userId) ?? new Set<string>())];
    },
    async setEnabledKnowledgeBases(userId: string, _teamId: string, kbIds: string[]) {
      state.enabled.set(userId, new Set(kbIds.filter(Boolean)));
      return [...state.enabled.get(userId)!];
    },
    /** 某个库下已发布条目的插件侧 id（与真实 SQL 同口径：经 run.kbId 关联）。 */
    async listPublishedEntryIdsByKnowledgeBase(teamId: string, kbId: string) {
      const runIds = new Set(
        [...state.runs.values()].filter((run) => run.teamId === teamId && run.kbId === kbId).map((run) => run.id)
      );
      return state.candidates
        .filter((item) => runIds.has(item.runId) && item.status === "published" && item.publishedEntryId)
        .map((item) => item.publishedEntryId);
    },
    async markCandidatesRevokedByKnowledgeBase(teamId: string, kbId: string, reviewedBy: string) {
      const runIds = new Set(
        [...state.runs.values()].filter((run) => run.teamId === teamId && run.kbId === kbId).map((run) => run.id)
      );
      state.candidates = state.candidates.map((item) =>
        runIds.has(item.runId) && item.status === "published"
          ? { ...item, status: "approved", reviewedBy, reviewedAt: new Date().toISOString() }
          : item
      );
    },
    async deleteKnowledgeBase(id: string, teamId: string, ownerId: string) {
      const kb = state.knowledgeBases.get(id);
      if (!kb || kb.teamId !== teamId || kb.ownerId !== ownerId) return { deleted: false, runsDetached: 0 };
      state.knowledgeBases.delete(id);
      // 启用清单是所有人的：库没了，挂着它的勾选也必须一起消失。
      for (const set of state.enabled.values()) set.delete(id);
      let runsDetached = 0;
      for (const [runId, run] of state.runs) {
        if (run.teamId === teamId && run.kbId === id) {
          state.runs.set(runId, { ...run, kbId: "" });
          runsDetached += 1;
        }
      }
      return { deleted: true, runsDetached };
    },
    async createRun(input: { teamId: string; ownerId: string; kbId: string; sourcesJson: string }): Promise<KbTrainingRun> {
      seq += 1;
      const run: KbTrainingRun = {
        id: `kbr_test_${seq}`,
        teamId: input.teamId,
        ownerId: input.ownerId,
        kbId: input.kbId,
        sourcesJson: input.sourcesJson,
        status: "running",
        engine: "none",
        model: "",
        stats: { segments: 0, candidates: 0, duplicates: 0, skipped: 0, cliCalls: 0, invented: 0 },
        progress: null,
        pendingCount: 0,
        errorMessage: "",
        createdAt: new Date().toISOString(),
        finishedAt: ""
      };
      state.runs.set(run.id, run);
      return run;
    },
    /** 进度是辅助信息：替身只记录最后一次，用于断言「跑到哪一步」。 */
    async saveRunProgress(id: string, progress: KbTrainingRun["progress"]) {
      const run = state.runs.get(id);
      if (run) state.runs.set(id, { ...run, progress });
    },
    async requestRunCancel(id: string, teamId: string) {
      const run = state.runs.get(id);
      if (!run || run.teamId !== teamId || run.status !== "running") return false;
      state.cancelled.add(id);
      return true;
    },
    async isRunCancelRequested(id: string) {
      return state.cancelled.has(id);
    },
    /** 发布时要逐条带上归属知识库，替身按批次回查。 */
    async mapRunKnowledgeBaseIds(teamId: string, runIds: string[]): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      for (const id of runIds) {
        const run = state.runs.get(id);
        if (run && run.teamId === teamId) map.set(id, run.kbId);
      }
      return map;
    },
    async finishRun(id: string, patch: { status: string; engine: string; model: string; stats: unknown; errorMessage?: string }) {
      const run = state.runs.get(id);
      if (!run) return;
      state.runs.set(id, {
        ...run,
        status: patch.status as KbTrainingRun["status"],
        engine: patch.engine as KbTrainingRun["engine"],
        model: patch.model,
        stats: patch.stats as KbTrainingRun["stats"],
        errorMessage: patch.errorMessage || "",
        finishedAt: new Date().toISOString()
      });
    },
    async insertCandidate(input: Omit<KbTrainingCandidate, "id" | "publishedEntryId" | "reviewedBy" | "reviewedAt" | "createdAt">) {
      // 按 (teamId, fingerprint) 幂等，与真实表的唯一键同语义。
      const existing = state.candidates.find((item) => item.teamId === input.teamId && item.fingerprint === input.fingerprint);
      if (existing) return { candidate: existing, duplicate: true };
      seq += 1;
      const candidate: KbTrainingCandidate = {
        ...input,
        id: `kbc_test_${seq}`,
        publishedEntryId: "",
        reviewedBy: "",
        reviewedAt: "",
        createdAt: new Date().toISOString()
      };
      state.candidates.push(candidate);
      return { candidate, duplicate: false };
    },
    async listCandidatesByIds(teamId: string, ids: string[]) {
      return state.candidates.filter((item) => item.teamId === teamId && ids.includes(item.id));
    },
    async markCandidatePublished(id: string, teamId: string, entryId: string, reviewedBy: string) {
      const found = state.candidates.find((item) => item.id === id && item.teamId === teamId);
      if (!found) return;
      found.status = "published";
      found.publishedEntryId = entryId;
      found.reviewedBy = reviewedBy;
    },
    async markCandidateRevoked(id: string, teamId: string) {
      const found = state.candidates.find((item) => item.id === id && item.teamId === teamId);
      if (!found) return;
      found.status = "approved";
    }
  };
  return { state, repository: fake as unknown as MysqlKbTrainingRepository };
}

const AI_CONFIG: AiModelConfig = {
  id: "cfg_test",
  provider: "openai",
  protocol: "openai-compatible",
  name: "测试模型",
  baseUrl: "https://example.invalid/v1",
  model: "gpt-test",
  apiKey: "sk-test",
  enabled: true,
  temperature: 0.1,
  useLeadFinder: false,
  useWebsiteParse: false,
  useScoring: false,
  useEmailDraft: false,
  useExam: false,
  ownerId: "u1",
  teamId: "t1",
  updatedAt: new Date().toISOString()
};

const ASSETS: KbAssetRef[] = [
  { id: "k_1", title: "LED 灯具参数手册 V3", version: "v3", description: "" },
  { id: "k_2", title: "付款与包装口径", version: "v1", description: "常规付款方式：30% 定金 + 70% 见提单副本。外箱一律用五层瓦楞。" }
];

function modelResponse(items: Array<Record<string, unknown>>): string {
  return `好的，整理结果：\n\`\`\`json\n${JSON.stringify({ candidates: items })}\n\`\`\``;
}

async function executeFor(spec: KbTrainingSourceSpec, deps: Partial<KbTrainingDeps> = {}): Promise<{ state: FakeState; run: KbTrainingRun }> {
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: JSON.stringify(spec) });
  await executeKbTrainingRun(run.id, { id: "u1", teamId: "t1" }, spec, {
    assets: new Map(ASSETS.map((asset) => [asset.id, asset])),
    ...deps
  });
  return { state, run: state.runs.get(run.id)! };
}

const PAYMENT_BODY = "常规付款方式：30% 定金 + 70% 见提单副本。";

// --- 1. CLI 通道正常：引擎如实记为 cli，候选入库且一律 pending ---------------
{
  const { state, run } = await executeFor(
    // 来源描述（note）随 item 进 sourceRef：用户要能看出「这份资料从哪来」。
    { text: { items: [{ title: "付款口径", body: PAYMENT_BODY, note: "2026-10 客户 Anna 邮件确认" }] } },
    {
      runCli: async () => ({
        text: modelResponse([{ kind: "snippet", question: "付款方式", answer: PAYMENT_BODY, confidence: 0.95, source_seg: 1, rationale: "客户常问" }]),
        model: "deepseek-v4.1-flash"
      })
    }
  );
  assert.equal(run.status, "succeeded");
  assert.equal(run.engine, "cli", "走了 CLI 就必须如实记 cli");
  assert.equal(run.model, "deepseek-v4.1-flash");
  assert.equal(run.stats.cliCalls, 1);
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].status, "pending", "人工确认是闸门，不许自动放行");
  assert.equal(state.candidates[0].sourceRef?.title, "付款口径");
  assert.equal(state.candidates[0].sourceRef?.anchor, "§1");
  assert.equal(state.candidates[0].sourceRef?.note, "2026-10 客户 Anna 邮件确认", "来源描述必须落到候选出处上");
  assert.equal(state.candidates[0].sourceType, "file");
  // 进度：跑完后必须留下「总共几段 / 处理了几段 / 几批」，界面靠它回答「是不是在跑」。
  assert.equal(run.progress?.totalSegments, 1);
  assert.equal(run.progress?.processedSegments, 1);
  assert.equal(run.progress?.batchesDone, 1);
  assert.equal(run.progress?.stage, "done");
}

// --- 1b. 取消是请求：下一批开始前生效，已入池候选不回滚 ---------------------
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const spec: KbTrainingSourceSpec = { text: { items: [{ title: "长资料", body: PAYMENT_BODY }] } };
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: JSON.stringify(spec) });
  state.cancelled.add(run.id);
  let calls = 0;
  await executeKbTrainingRun(run.id, { id: "u1", teamId: "t1" }, spec, {
    assets: new Map(),
    runCli: async () => {
      calls += 1;
      return { text: modelResponse([]), model: "test" };
    }
  });
  const finished = state.runs.get(run.id)!;
  assert.equal(calls, 0, "取消后不得再发起新的模型调用（钱已经花过一次就够了）");
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.progress?.stage, "done");
}

// --- 1c. 最后一批期间点的「停止」：段落其实已全部提炼完，也必须如实说明 -----
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const spec: KbTrainingSourceSpec = { text: { items: [{ title: "长资料", body: PAYMENT_BODY }] } };
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: JSON.stringify(spec) });
  await executeKbTrainingRun(run.id, { id: "u1", teamId: "t1" }, spec, {
    assets: new Map(),
    runCli: async () => {
      // 模拟「模型调用在飞时用户点了停止」：标记要等这批结束才被读到，
      // 此时循环已经走完 —— 没有下一批可跳过，但用户明明点了停止。
      state.cancelled.add(run.id);
      return {
        text: modelResponse([{ kind: "snippet", question: "付款方式", answer: PAYMENT_BODY, confidence: 0.9, source_seg: 1 }]),
        model: "test"
      };
    }
  });
  const finished = state.runs.get(run.id)!;
  assert.equal(finished.status, "cancelled", "用户点了停止，就不能回头报成功");
  assert.ok(
    String(finished.errorMessage).includes("最后一批已经跑完"),
    "必须说清楚停止时其实已经跑完（否则用户会以为漏训了）"
  );
  assert.equal(finished.stats.candidates, 1, "已入池的候选必须保留（取消不回滚）");
}

// --- 2. CLI 失败退 CRM 模型：engine 必须变成 ai（降级可见）--------------------
{
  const { state, run } = await executeFor(
    { text: { items: [{ title: "付款口径", body: PAYMENT_BODY }] } },
    {
      aiConfig: AI_CONFIG,
      runCli: async () => { throw new Error("本机 CLI 不存在（/nope/codebuddy）"); },
      callAi: async () => modelResponse([{ kind: "snippet", question: "付款方式", answer: PAYMENT_BODY, confidence: 0.9, source_seg: 1 }])
    }
  );
  assert.equal(run.status, "succeeded");
  assert.equal(run.engine, "ai", "降级了就必须如实写 ai，不能还报 cli");
  assert.equal(run.model, "gpt-test");
  assert.equal(run.stats.cliCalls, 0);
  assert.equal(state.candidates.length, 1);
  assert.ok(run.errorMessage.includes("已改用 CRM 配置的模型"), "降级原因要能被看见");
}

// --- 3. 没有降级档：如实失败，不许假装成功 ----------------------------------
{
  const { state, run } = await executeFor(
    { text: { items: [{ title: "付款口径", body: PAYMENT_BODY }] } },
    { runCli: async () => { throw new Error("Authentication required") } }
  );
  assert.equal(run.status, "failed");
  assert.equal(run.engine, "none");
  assert.equal(state.candidates.length, 0);
  assert.ok(run.errorMessage.includes("Authentication required"), "CLI 的真实原因必须带出来");
  assert.ok(run.finishedAt, "失败也必须收尾，不能永远停在 running");
}

// --- 4. 每 20 段 1 次调用（禁止每条一调）-----------------------------------
{
  // 每段约 700 字：两段合起来就超过单段预算，所以 21 段正好切成 21 段（不会被合并）。
  const paragraphs = Array.from({ length: 21 }, (_item, index) => `第 ${index + 1} 段。${"甲".repeat(690)}`);
  const calls: number[] = [];
  const { run } = await executeFor(
    { text: { items: [{ title: "长资料", body: paragraphs.join("\n\n") }] } },
    {
      runCli: async (prompt) => {
        calls.push(prompt.length);
        // 每批都返回一条合法候选（source_seg 用 1，避免越界）
        return { text: modelResponse([{ kind: "snippet", question: "口径", answer: "固定说法。", confidence: 0.9, source_seg: 1 }]), model: "m" };
      }
    }
  );
  assert.equal(run.stats.segments, 21, "21 个约 700 字的段落应当各成一段");
  const expectedCalls = Math.ceil(21 / KB_SEGMENTS_PER_CALL);
  assert.equal(expectedCalls, 2);
  assert.equal(run.stats.cliCalls, expectedCalls, `21 段必须是 ${expectedCalls} 次调用，而不是逐段调用`);
  assert.equal(calls.length, expectedCalls);
}

// --- 5. 越界出处必须被丢弃并计数（方案 §10.2 自检 #3）------------------------
{
  const { state, run } = await executeFor(
    { text: { items: [{ title: "付款口径", body: PAYMENT_BODY }] } },
    {
      runCli: async () => ({
        text: modelResponse([
          { kind: "snippet", question: "编的", answer: "资料里没有这句话。", confidence: 0.99, source_seg: 7 }
        ]),
        model: "m"
      })
    }
  );
  assert.equal(state.candidates.length, 0, "越界出处的候选绝不能落库");
  assert.equal(run.stats.skipped, 1);
  assert.equal(run.stats.invented, 1);
}

// --- 6. 无出处不入池（正文没有标题、也没关联资料）---------------------------
{
  const { state, run } = await executeFor({ text: { items: [{ body: PAYMENT_BODY }] } });
  assert.equal(state.candidates.length, 0);
  assert.equal(run.status, "failed");
  assert.ok(run.errorMessage.includes("没有出处"), "必须明确告诉用户缺的是「出处」");
}

// --- 7. 只选文件中心资料：没有正文就如实报，不臆造 --------------------------
{
  const { run } = await executeFor({ files: { assetIds: ["k_1"] } });
  assert.equal(run.status, "failed");
  // 失败原因里同时要有「为什么不行」与「是哪份资料」—— 只报一句"训练失败"等于没说。
  assert.ok(run.errorMessage.includes("只保存资料链接与说明"), "文件中心只存链接与说明，这一点必须说出来");
  assert.ok(run.errorMessage.includes("LED 灯具参数手册 V3"), "要点名是哪份资料");

  // 有 description 的资料可以当语料（照实走通）
  const withBody = await executeFor(
    { files: { assetIds: ["k_2"] } },
    {
      runCli: async () => ({
        text: modelResponse([{ kind: "snippet", question: "付款", answer: "30% 定金 + 70% 见提单副本。", confidence: 0.9, source_seg: 1 }]),
        model: "m"
      })
    }
  );
  assert.equal(withBody.run.status, "succeeded");
  assert.equal(withBody.run.stats.segments, 1);
  assert.equal(withBody.state.candidates[0].sourceRef?.assetId, "k_2");
}

// --- 8. 同一份资料训两次：幂等，不膨胀 ---------------------------------------
{
  // ⚠️ 必须复用**同一个**替身：每次新建一个空库，「重复」当然测不出来（踩过）。
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const spec: KbTrainingSourceSpec = { text: { items: [{ title: "付款口径", body: PAYMENT_BODY }] } };
  const deps: KbTrainingDeps = {
    assets: new Map(ASSETS.map((asset) => [asset.id, asset])),
    runCli: async () => ({
      text: modelResponse([{ kind: "snippet", question: "付款方式", answer: PAYMENT_BODY, confidence: 0.9, source_seg: 1 }]),
      model: "m"
    })
  };
  const first = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: "{}" });
  await executeKbTrainingRun(first.id, { id: "u1", teamId: "t1" }, spec, deps);
  const second = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: "{}" });
  await executeKbTrainingRun(second.id, { id: "u1", teamId: "t1" }, spec, deps);
  assert.equal(state.runs.get(first.id)!.stats.candidates, 1);
  assert.equal(state.runs.get(second.id)!.stats.candidates, 0);
  assert.equal(state.runs.get(second.id)!.stats.duplicates, 1, "第二次必须识别为重复而不是新增");
  assert.equal(state.candidates.length, 1, "库不该因为重复训练而膨胀");
}

// --- 9. 会话源：P1 如实报未开放 ---------------------------------------------
{
  const { run } = await executeFor({ conversations: { limit: 30 } });
  assert.equal(run.status, "failed");
  assert.ok(run.errorMessage.includes("P2"), "未开放的源要明说，不能静默忽略");
}

// --- 10. 采集层：不存在的资料给出可读警告 -----------------------------------
{
  const collected = collectSourceItems({ files: { assetIds: ["k_missing"] }, text: { items: [{ title: "x", body: "y" }] } }, new Map());
  assert.equal(collected.items.length, 1);
  assert.ok(collected.warnings.some((warning) => warning.includes("k_missing")));
}

// --- 11. 发布编排：无出处不可发布（方案 §10.2 自检 #1）----------------------
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: "{}" });
  const inserted = await repository.insertCandidate({
    runId: run.id, teamId: "t1", ownerId: "u1", kind: "qa", question: "问法", answer: "答法",
    tags: [], languages: [], confidence: 0.9, sourceType: "file",
    sourceRef: null, rationale: "", gapFlag: false, fingerprint: "f1", status: "pending"
  });
  // 手工把出处抹掉，模拟「有人绕过界面改了库」
  state.candidates[0].sourceRef = null;

  const outcome = await publishKbCandidates({
    actor: { id: "u1", teamId: "t1" },
    ids: [inserted.candidate.id],
    publishToPlugin: async () => { throw new Error("这条不该被调用"); }
  });
  assert.equal(outcome.published.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.ok(outcome.failed[0].reason.includes("无出处"), "无出处必须被**拒绝**，而不是静默发布成功");
  assert.equal(state.candidates[0].status, "pending", "被拒之后状态不能变");
}

// --- 12. 发布成功回写血缘；单条失败不污染整批 -------------------------------
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: "kb_test_1", sourcesJson: "{}" });
  const base = {
    runId: run.id, teamId: "t1", ownerId: "u1" as string, kind: "qa" as const, question: "问法",
    answer: "答法", tags: [], languages: [], confidence: 0.9, sourceType: "file" as const,
    sourceRef: { type: "file" as const, title: "资料", anchor: "§1" }, rationale: "",
    gapFlag: false, status: "approved" as const
  };
  const okOne = await repository.insertCandidate({ ...base, fingerprint: "fa" });
  const badOne = await repository.insertCandidate({ ...base, fingerprint: "fb", answer: "会失败的答法" });
  const existingOne = await repository.insertCandidate({ ...base, fingerprint: "fc", answer: "插件里已经有了" });
  const rejectedOne = await repository.insertCandidate({ ...base, fingerprint: "fd", answer: "已丢弃的" });
  // 未确认的候选：人工确认是闸门，后端不得让它直接进插件语料库。
  const pendingOne = await repository.insertCandidate({ ...base, fingerprint: "fe", answer: "还没确认的", status: "pending" });
  // 模拟人工丢弃之后的存量状态
  state.candidates.find((item) => item.id === rejectedOne.candidate.id)!.status = "rejected";

  const seenKbIds: string[] = [];
  const outcome = await publishKbCandidates({
    actor: { id: "u1", teamId: "t1" },
    ids: [okOne.candidate.id, badOne.candidate.id, existingOne.candidate.id, rejectedOne.candidate.id, pendingOne.candidate.id, "kbc_not_exist"],
    publishToPlugin: async (candidate, context) => {
      seenKbIds.push(context.kbId);
      if (candidate.answer === "会失败的答法") throw new Error("插件返回 HTTP 500");
      return { entryId: `plugin_${candidate.fingerprint}`, existing: candidate.answer === "插件里已经有了" };
    }
  });
  assert.ok(seenKbIds.length > 0 && seenKbIds.every((id) => id === "kb_test_1"),
    "发布必须逐条带上归属知识库 —— 插件靠它判断这条语料该出现在哪些账号的出稿里");
  assert.deepEqual(outcome.published.map((item) => item.id), [okOne.candidate.id]);
  assert.deepEqual(outcome.existing.map((item) => item.id), [existingOne.candidate.id]);
  assert.equal(outcome.failed.length, 4, "失败那条、已丢弃那条、未确认那条、以及不存在的 id");
  assert.ok(outcome.failed.some((item) => item.reason.includes("HTTP 500")));
  assert.ok(outcome.failed.some((item) => item.reason.includes("已丢弃")));
  assert.ok(outcome.failed.some((item) => item.reason.includes("还没确认")), "未确认的候选不得绕过人工闸门直接发布");
  assert.ok(outcome.failed.some((item) => item.reason.includes("不存在")));

  // 血缘必须落库
  const published = state.candidates.find((item) => item.id === okOne.candidate.id)!;
  assert.equal(published.status, "published");
  assert.equal(published.publishedEntryId, `plugin_fa`, "发布后必须回写插件条目 id");
}

// ===========================================================================
// 三、知识库：命名 / 归属 / 公开私用 / 账号级启用清单
// ===========================================================================

// --- 13. 库名取自首份语料标题：列表里能一眼认出是哪份资料 -------------------
assert.equal(defaultKnowledgeBaseName({ text: { items: [{ title: "LED 参数手册 V3", body: "x" }] } }), "LED 参数手册 V3");
assert.ok(
  defaultKnowledgeBaseName({ text: { items: [{ title: "A", body: "x" }, { title: "B", body: "y" }] } }).includes("2 份资料"),
  "多份语料要让名字体现数量，不能只写第一份"
);
assert.match(defaultKnowledgeBaseName({ text: { items: [] } }), /^训练 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u, "没有标题才退回时间戳");

// --- 14. 新建库默认**私用**且创建者自动启用 --------------------------------
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const kb = await resolveKnowledgeBaseForRun({
    actor: { id: "u1", teamId: "t1" },
    spec: { text: { items: [{ title: "付款口径", body: "30% 定金" }] } }
  });
  assert.equal(kb.name, "付款口径");
  assert.equal(kb.visibility, "owner", "含商务口径的成果不能默认公开");
  assert.ok(state.enabled.get("u1")!.has(kb.id), "自己训出来的成果默认就该生效，否则用户以为功能坏了");
}

// --- 15. 不能把语料发进别人的库（会污染别人的出稿口径）----------------------
{
  const { repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const other = await repository.createKnowledgeBase({
    teamId: "t1", ownerId: "u2", name: "别人的库", visibility: "team", runId: ""
  });
  await assert.rejects(
    () => resolveKnowledgeBaseForRun({ actor: { id: "u1", teamId: "t1" }, spec: {}, kbId: other.id }),
    /只能把语料发进自己创建的知识库/u
  );
  await assert.rejects(
    () => resolveKnowledgeBaseForRun({ actor: { id: "u1", teamId: "t1" }, spec: {}, kbId: "kb_not_exist" }),
    /不存在/u
  );
}

// --- 16. 公开/私用只能创建者切；别人的库改不动 -----------------------------
{
  const { repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const shared = await repository.createKnowledgeBase({
    teamId: "t1", ownerId: "u2", name: "客服口径", visibility: "owner", runId: ""
  });
  // u1 看得见（若公开）但改不动。
  await assert.rejects(
    () => renameOrShareKnowledgeBaseForTest("u1", shared.id, { visibility: "team" }),
    /只有创建者/u
  );
  // 创建者自己可以公开。
  const updated = await renameOrShareKnowledgeBaseForTest("u2", shared.id, { visibility: "team", name: "客服口径（公开）" });
  assert.equal(updated.visibility, "team");
  assert.equal(updated.name, "客服口径（公开）");
}

/** 小包装：把 actor 写全，避免每处都重复 teamId。 */
function renameOrShareKnowledgeBaseForTest(userId: string, id: string, patch: { name?: string; visibility?: "owner" | "team" }) {
  return renameOrShareKnowledgeBase({ id: userId, teamId: "t1" }, id, patch);
}

// --- 17. 只能启用**看得见**的库；有被拒就绝不推插件（半套清单更危险）--------
{
  const { repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const mine = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u1", name: "我的", visibility: "owner", runId: "" });
  const publicOther = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u2", name: "别人公开的", visibility: "team", runId: "" });
  const privateOther = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u3", name: "别人私用的", visibility: "owner", runId: "" });

  let pushed: string[] | null = null;
  const rejectedRun = await saveEnabledKnowledgeBases({
    actor: { id: "u1", teamId: "t1" },
    kbIds: [mine.id, publicOther.id, privateOther.id],
    pushToPlugin: async (kbIds) => { pushed = kbIds; return { ok: true }; }
  });
  assert.equal(rejectedRun.pluginPushed, false, "有被拒的知识库时不能推插件：半套清单推过去比不推更危险");
  assert.equal(pushed, null, "被拒时不应该调用传输层");
  assert.equal(rejectedRun.rejected.length, 1);
  assert.equal(rejectedRun.rejected[0].id, privateOther.id, "别人的私用库必须被拒绝，不能静默过滤");
  assert.ok(rejectedRun.rejected[0].reason.includes("没有公开给你") || rejectedRun.rejected[0].reason.includes("不存在"));

  const okRun = await saveEnabledKnowledgeBases({
    actor: { id: "u1", teamId: "t1" },
    kbIds: [mine.id, publicOther.id],
    pushToPlugin: async (kbIds) => { pushed = kbIds; return { ok: true }; }
  });
  assert.equal(okRun.pluginPushed, true);
  assert.deepEqual([...(pushed as unknown as string[])].sort(), [mine.id, publicOther.id].sort());
  assert.deepEqual((await repository.listEnabledKnowledgeBaseIds("u1")).sort(), [mine.id, publicOther.id].sort(), "清单必须落库");
}

// --- 18. 插件不可达必须如实回报，不能假装保存成功 ---------------------------
{
  const { repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const mine = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u1", name: "我的", visibility: "owner", runId: "" });
  const result = await saveEnabledKnowledgeBases({
    actor: { id: "u1", teamId: "t1" },
    kbIds: [mine.id],
    pushToPlugin: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3100"); }
  });
  assert.equal(result.pluginPushed, false);
  assert.ok(result.pluginError.includes("ECONNREFUSED"), "插件没起来要让用户看见原因，不能静默当成功");
  // 但 CRM 侧清单已经存下了 —— 恢复插件后不需要用户重新勾一遍。
  assert.deepEqual(await repository.listEnabledKnowledgeBaseIds("u1"), [mine.id]);
}

// --- 19. 空清单是合法状态：等于「不用任何知识库出稿」------------------------
{
  const { repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u1", name: "我的", visibility: "owner", runId: "" });
  const result = await saveEnabledKnowledgeBases({
    actor: { id: "u1", teamId: "t1" },
    kbIds: [],
    pushToPlugin: async () => ({ ok: true })
  });
  assert.deepEqual(result.enabled, []);
  assert.equal(result.pluginPushed, true, "零启用是合法选择，要照实推给插件（否则插件无法区分未配置与零启用）");
}

// --- 20. 删除知识库：先让插件下线，再删库 -----------------------------------
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const kb = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u1", name: "待删除", visibility: "team", runId: "" });
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: kb.id, sourcesJson: "{}" });
  const base = {
    runId: run.id,
    teamId: "t1",
    ownerId: "u1",
    kind: "qa" as const,
    tags: [] as string[],
    languages: [] as string[],
    confidence: 0.9,
    sourceType: "file" as const,
    sourceRef: null,
    rationale: "",
    gapFlag: false,
    reviewedBy: "",
    reviewedAt: "",
    createdAt: new Date().toISOString()
  };
  state.candidates = [
    { ...base, id: "c1", question: "q1", answer: "a1", fingerprint: "f1", status: "published" as const, publishedEntryId: "entry_1" },
    { ...base, id: "c2", question: "q2", answer: "a2", fingerprint: "f2", status: "published" as const, publishedEntryId: "entry_2" },
    { ...base, id: "c3", question: "q3", answer: "a3", fingerprint: "f3", status: "pending" as const, publishedEntryId: "" }
  ];
  // 另一个账号也勾了这个公开库：删库必须把所有人的勾选一起清掉。
  state.enabled.set("u2", new Set([kb.id]));
  const archived: string[][] = [];
  const result = await deleteKnowledgeBase({
    actor: { id: "u1", teamId: "t1" },
    id: kb.id,
    archiveEntries: async (ids) => {
      archived.push(ids);
    }
  });
  assert.deepEqual(archived, [["entry_1", "entry_2"]], "插件要先下线全部已发布条目（顺序反了就是幽灵语料）");
  assert.equal(result.archivedEntries, 2);
  assert.equal(result.detachedRuns, 1, "批次要解除归库但保留");
  assert.equal(state.knowledgeBases.has(kb.id), false, "库本身要删掉");
  assert.deepEqual([...(state.enabled.get("u2") ?? [])], [], "别人的启用勾选也要一起清");
  assert.equal(state.candidates.find((item) => item.id === "c1")?.status, "approved", "已发布退回 approved（留痕）");
  assert.equal(state.candidates.find((item) => item.id === "c3")?.status, "pending", "待确认的候选不受影响");
  assert.equal(state.runs.get(run.id)?.kbId, "", "批次还在，只是不再归这个库");
}

// --- 21. 只有创建者能删 -----------------------------------------------------
{
  const { repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const kb = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u1", name: "别人的", visibility: "team", runId: "" });
  await assert.rejects(
    () => deleteKnowledgeBase({ actor: { id: "u2", teamId: "t1" }, id: kb.id, archiveEntries: async () => {} }),
    (error: Error & { status?: number }) => error.status === 403,
    "别人的公开库可以启用，但不能删"
  );
  assert.ok(await repository.getKnowledgeBase(kb.id, "t1"), "被拒后库必须还在");
}

// --- 22. 插件下线失败就中止：不能留下「CRM 删了、插件还在读」 --------------
{
  const { state, repository } = createFakeRepository();
  setKbTrainingRepository(repository);
  const kb = await repository.createKnowledgeBase({ teamId: "t1", ownerId: "u1", name: "插件挂了", visibility: "owner", runId: "" });
  const run = await repository.createRun({ teamId: "t1", ownerId: "u1", kbId: kb.id, sourcesJson: "{}" });
  state.candidates = [{
    id: "c1",
    runId: run.id,
    teamId: "t1",
    ownerId: "u1",
    kind: "qa",
    question: "q",
    answer: "a",
    tags: [],
    languages: [],
    confidence: 0.9,
    sourceType: "file",
    sourceRef: null,
    rationale: "",
    gapFlag: false,
    fingerprint: "f1",
    status: "published",
    publishedEntryId: "entry_1",
    reviewedBy: "",
    reviewedAt: "",
    createdAt: new Date().toISOString()
  }];
  await assert.rejects(
    () => deleteKnowledgeBase({
      actor: { id: "u1", teamId: "t1" },
      id: kb.id,
      archiveEntries: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3100");
      }
    }),
    (error: Error & { status?: number }) => error.status === 502 && /ECONNREFUSED/u.test(error.message),
    "插件不可达要如实报 502，而不是删了库把语料留在插件里"
  );
  assert.ok(await repository.getKnowledgeBase(kb.id, "t1"), "中止时库必须还在");
  assert.equal(state.candidates[0]!.status, "published", "候选状态不能提前改（重试要能收敛）");
}

setKbTrainingRepository(null);

console.log(JSON.stringify({
  ok: true,
  pureFunctions: "分段 / 提示词 / 输出校验 / 预勾选 / 指纹同口径",
  orchestration: "引擎降级 / 分批 / 越界丢弃 / 出处门槛 / 幂等",
  publish: "血缘回写 / 无出处拒绝 / 单条失败不污染整批",
  knowledgeBase: "命名 / 默认私用 / 归属校验 / 仅创建者可改 / 启用清单可见性闸门 / 插件推送可见 / 删除先下线后删库"
}, null, 2));
