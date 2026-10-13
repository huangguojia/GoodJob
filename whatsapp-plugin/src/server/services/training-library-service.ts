import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  TrainingLibraryEntry,
  TrainingLibraryImportResult,
  TrainingLibraryKind,
  TrainingLibraryMatch,
  TrainingLibraryMatchResult
} from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { containsPhrase, coverage, expandTokens, tokenize } from "./text-match.js";

/** 进提示词的问答参考样本上限：够模型学会口径，又不会把提示词撑爆。 */
const MAX_PROMPT_QA = 5;
/** 相似度低于这个值就不当命中——宁可要求人工，也不要拿一条不相干的问答去糊弄客户。 */
const MIN_QA_SIMILARITY = 0.15;
/** 问答对至少要有这么多共同特征才算命中，防止单字偶合。 */
const MIN_QA_MATCHED_TOKENS = 2;
/** 口径片段 / 政策进提示词的上限。 */
const MAX_PROMPT_SNIPPETS = 6;
const MAX_PROMPT_POLICIES = 10;

export const trainingLibraryKindSchema = z.enum(["qa", "snippet", "policy", "forbidden"]);

/**
 * 训练库条目的入参。`question` 只有问答对是必需的：
 * 口径片段 / 政策 / 禁用词都是「一条说法」而不是一个问句；
 * 禁用词的 question 是**可选的触发场景描述**（客户这么说就该转人工）。
 */
export const trainingLibraryInputSchema = z
  .object({
    accountId: z.string().trim().min(1).nullable().optional(),
    kind: trainingLibraryKindSchema,
    question: z.string().trim().max(2_000).optional(),
    answer: z.string().trim().min(1).max(8_000),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    languages: z.array(z.string().trim().min(1).max(16)).max(10).optional(),
    priority: z.number().int().min(0).max(1_000).optional(),
    enabled: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if (value.kind === "qa" && !value.question?.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["question"], message: "问答对必须填写客户问法" });
    }
  });

export type TrainingLibraryInput = z.infer<typeof trainingLibraryInputSchema>;

export interface TrainingLibrarySearchInput {
  /** 只取「通用 + 该账号」的条目；不传就是全部。 */
  accountId?: string | null;
  enabledOnly?: boolean;
}

function fingerprintOf(kind: TrainingLibraryKind, question: string, answer: string): string {
  const normalized = [
    kind,
    question.replace(/\s+/gu, " ").trim().toLowerCase(),
    answer.replace(/\s+/gu, " ").trim().toLowerCase()
  ].join("\u0000");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** 短语包含判断在 `./text-match.js`（`containsPhrase`）：护栏与禁用词检查必须与检索用同一套归一化。 */

/**
 * 训练库：自动回复的**专门语料库**。
 *
 * 与 `training_profiles` 的分工是刻意的：
 * - profile 是「按会话导出的风格快照」——提供语气、写作准则、样本语感；
 * - 训练库是「跨会话、跨账号可复用的长期资产」——提供「客户这么问该怎么答」的内容本身。
 *
 * 所以检索顺序是**训练库优先、档案兜底**：库里的条目是（人工或导入后）确认过的口径，
 * 比从聊天记录里自动抽出来的样本更可信；库里确实没有时才落回档案样本，
 * 这样升级不会让已有配置的行为突然变差。
 */
export class TrainingLibraryService {
  constructor(private readonly repository: Repository) {}

  async list(ownerUserId: string, filter: TrainingLibrarySearchInput & { kinds?: TrainingLibraryKind[] } = {}): Promise<TrainingLibraryEntry[]> {
    return this.repository.listTrainingLibraryEntries(ownerUserId, {
      kinds: filter.kinds,
      enabledOnly: filter.enabledOnly ?? false,
      accountId: filter.accountId ?? undefined
    });
  }

  async get(ownerUserId: string, id: string): Promise<TrainingLibraryEntry> {
    const entry = await this.repository.getTrainingLibraryEntry(id, ownerUserId);
    if (!entry) throw new DomainError("TRAINING_LIBRARY_ENTRY_NOT_FOUND", 404, "Training library entry not found");
    return entry;
  }

  /**
   * 新增或更新一条。
   *
   * 同一条问答（kind + 问法 + 答案，忽略大小写与空白差异）不会重复入库：
   * 反复导入同一份聊天记录是很自然的操作，不该让库膨胀成几十条一模一样的东西。
   * 撞上已有条目时**不报错**，直接返回既有那条，由路由用 201/200 区分「新建」与「已存在」。
   */
  async save(
    ownerUserId: string,
    input: TrainingLibraryInput,
    id?: string
  ): Promise<{ entry: TrainingLibraryEntry; created: boolean }> {
    const accountId = input.accountId?.trim() ? input.accountId.trim() : null;
    if (accountId) {
      const account = await this.repository.getAccount(accountId, ownerUserId);
      if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Channel account not found");
    }
    const question = input.question?.trim() ?? "";
    const answer = input.answer.trim();
    const fingerprint = fingerprintOf(input.kind, question, answer);

    const existing = id
      ? await this.get(ownerUserId, id)
      : await this.repository.findTrainingLibraryByFingerprint(ownerUserId, fingerprint);
    if (existing && !id) return { entry: existing, created: false };

    const timestamp = new Date().toISOString();
    const saved = await this.repository.saveTrainingLibraryEntry({
      id: existing?.id ?? randomUUID(),
      ownerUserId,
      accountId,
      accountName: existing?.accountName ?? null,
      kind: input.kind,
      question,
      answer,
      tags: input.tags ?? [],
      languages: input.languages ?? [],
      priority: input.priority ?? 100,
      // 编辑时没显式改启用状态就沿用原值，别让一次「改错别字」把条目悄悄停用。
      enabled: input.enabled ?? existing?.enabled ?? true,
      // 来源与命中次数是观测数据，不能被一次编辑抹掉。
      source: existing?.source ?? "manual",
      hitCount: existing?.hitCount ?? 0,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      fingerprint
    });
    return { entry: saved, created: !existing };
  }

  async remove(ownerUserId: string, id: string): Promise<void> {
    const removed = await this.repository.deleteTrainingLibraryEntry(id, ownerUserId);
    if (!removed) throw new DomainError("TRAINING_LIBRARY_ENTRY_NOT_FOUND", 404, "Training library entry not found");
  }

  /**
   * 把训练档案里的问答样本导入训练库。
   * 这是「导出 → 训练 → 入库」链路的第三步：档案是一次性快照，进了库才成为可维护的长期资产。
   * 幂等：同一条问答重复导入只算一次。
   */
  async importFromProfile(ownerUserId: string, profileId: string): Promise<TrainingLibraryImportResult> {
    const profile = await this.repository.getTrainingProfile(profileId, ownerUserId);
    if (!profile) throw new DomainError("TRAINING_PROFILE_NOT_FOUND", 404, "Training profile not found");
    const inputs = [
      ...profile.examples.map((example) => ({
        kind: "qa" as const,
        question: example.inbound,
        answer: example.reply,
        languages: profile.languages
      })),
      // 档案识别出来的护栏本身就是「必须遵守的政策」，一并入库才不用手工重录一遍。
      ...profile.guardrails.map((guardrail) => ({
        kind: "policy" as const,
        question: "",
        answer: guardrail,
        languages: profile.languages
      }))
    ];
    let created = 0;
    let skipped = 0;
    for (const input of inputs) {
      const question = input.question.replace(/\s+/gu, " ").trim().slice(0, 2_000);
      const answer = input.answer.replace(/\s+/gu, " ").trim().slice(0, 8_000);
      if (!answer || (input.kind === "qa" && !question)) {
        skipped += 1;
        continue;
      }
      const fingerprint = fingerprintOf(input.kind, question, answer);
      if (await this.repository.findTrainingLibraryByFingerprint(ownerUserId, fingerprint)) {
        skipped += 1;
        continue;
      }
      const timestamp = new Date().toISOString();
      await this.repository.saveTrainingLibraryEntry({
        id: randomUUID(),
        ownerUserId,
        accountId: profile.accountId,
        accountName: null,
        kind: input.kind,
        question,
        answer,
        tags: [],
        languages: input.languages,
        priority: 100,
        enabled: true,
        source: "profile",
        hitCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        fingerprint
      });
      created += 1;
    }
    return { created, skipped, total: inputs.length };
  }

  /**
   * 针对一句客户消息，取「这次回复要用到的库里内容」。
   *
   * 四种类型的用途各不相同，别混：
   * - `qa`：命中才用（共同特征 + 相似度双门槛）。规则通道直接拿它回，模型通道当参考样本；
   * - `snippet`：全部带上，由模型按客户语言改写（口径片段本来就是固定说法）；
   * - `policy`：全部带上，并入护栏；
   * - `forbidden`：`answer` 是禁用短语，既用来拦生成的回复，也用来判断「客户这么问就该转人工」。
   */
  async resolve(ownerUserId: string, inboundBody: string, accountId?: string | null): Promise<TrainingLibraryMatchResult> {
    const entries = await this.list(ownerUserId, { enabledOnly: true, accountId });
    const hits = this.rankQa(inboundBody, entries.filter((entry) => entry.kind === "qa"));
    const snippets = entries.filter((entry) => entry.kind === "snippet").slice(0, MAX_PROMPT_SNIPPETS);
    const policies = entries.filter((entry) => entry.kind === "policy").slice(0, MAX_PROMPT_POLICIES);
    const forbidden = entries
      .filter((entry) => entry.kind === "forbidden" && entry.question && containsPhrase(inboundBody, entry.question))
      .map((entry) => ({ entry, similarity: 1, matched: tokenize(entry.question).length }));
    const forbiddenPhrases = entries
      .filter((entry) => entry.kind === "forbidden")
      .map((entry) => entry.answer.trim())
      .filter(Boolean);

    const expandedHitsTotal = hits.reduce((total, hit) => total + (hit.expandedHits ?? 0), 0);
    const verdict = [
      `命中 ${hits.length} 条问答${hits.length ? `（最高相似度 ${hits[0].similarity.toFixed(2)}${expandedHitsTotal > 0 ? "，含词典等价命中" : ""}）` : ""}`,
      `引用 ${snippets.length} 条口径`,
      `${policies.length} 条政策`,
      forbidden.length ? `${forbidden.length} 条禁用场景命中` : ""
    ]
      .filter(Boolean)
      .join("；");
    return { query: inboundBody, hits, snippets, policies, forbidden, forbiddenPhrases, verdict };
  }

  /**
   * 问答对排序：共同特征与相似度都要过门槛，再按相似度、优先级倒序。
   *
   * 查询侧先做词典扩展（docs/CROSS-LANGUAGE-MATCH-DESIGN.md）：客户用英文问 "MOQ"、
   * 库里是「起订量」这类跨语言场景才能召回。扩展词与原词**同权**计入共同特征，
   * 但相似度分母把扩展词也算进去 —— 扩展词越多相似度被稀释越狠，误召回由相似度门槛挡住。
   * 扩展集为空时与旧口径完全一致（纯中文对纯中文的既有行为一个字不变）。
   */
  rankQa(inboundBody: string, entries: TrainingLibraryEntry[]): TrainingLibraryMatch[] {
    const queryTokens = tokenize(inboundBody);
    if (!queryTokens.length) return [];
    const { expanded } = expandTokens(queryTokens, inboundBody);
    const querySet = new Set([...queryTokens, ...expanded]);
    const querySize = queryTokens.length + expanded.length;
    return entries
      .map((entry) => {
        const entryTokens = tokenize(entry.question);
        const matched = entryTokens.filter((token) => querySet.has(token)).length;
        const expandedMatched = expanded.filter((token) => entryTokens.includes(token)).length;
        return {
          entry,
          matched,
          similarity: coverage(matched, querySize, entryTokens.length),
          ...(expandedMatched > 0 ? { expandedHits: expandedMatched } : {})
        };
      })
      .filter((item) => item.matched >= MIN_QA_MATCHED_TOKENS && item.similarity >= MIN_QA_SIMILARITY)
      .sort((left, right) => right.similarity - left.similarity || right.entry.priority - left.entry.priority)
      .slice(0, MAX_PROMPT_QA);
  }

  /**
   * 生成的回复里是否出现禁用短语。
   * 这是**机器可判定**的那一类约束：报价、承诺语之类写进库里，命中就拦下不自动发送。
   */
  async forbiddenHits(ownerUserId: string, reply: string, accountId?: string | null): Promise<TrainingLibraryEntry[]> {
    const entries = await this.list(ownerUserId, { kinds: ["forbidden"], enabledOnly: true, accountId });
    return entries.filter((entry) => containsPhrase(reply, entry.answer));
  }

  /** 命中计数：只在条目真的被用上时加，界面靠它清理「建了从来没被用过」的死条目。 */
  async recordHits(ids: string[]): Promise<void> {
    await this.repository.bumpTrainingLibraryHits(ids);
  }

  /** 把库导成一份 Markdown 知识包：可以当成交付物传给别人，也可以直接当技能包素材。 */
  async exportMarkdown(ownerUserId: string): Promise<string> {
    const entries = await this.list(ownerUserId);
    const sections: Array<{ kind: TrainingLibraryKind; title: string }> = [
      { kind: "policy", title: "政策（必须遵守）" },
      { kind: "forbidden", title: "禁用语 / 红线" },
      { kind: "qa", title: "标准问答对" },
      { kind: "snippet", title: "口径片段" }
    ];
    const lines = [
      "# 自动回复训练库",
      "",
      `> 导出时间：${new Date().toISOString()}`,
      `> 条目总数：${entries.length}`,
      "",
      "本文件由「每刻沟通」插件导出，是该团队自动回复的语料。",
      "问答对用于匹配客户问法（“客户这么问 → 我们这么答”），口径片段用于改写，",
      "政策与禁用语是硬约束：命中禁用词的回复一律不自动发送。",
      ""
    ];
    for (const section of sections) {
      const items = entries.filter((entry) => entry.kind === section.kind);
      if (!items.length) continue;
      lines.push(`## ${section.title}`, "");
      for (const entry of items) {
        if (entry.kind === "qa") {
          lines.push(`### 客户问：${entry.question}`, "", entry.answer, "");
        } else if (entry.kind === "forbidden") {
          lines.push(`- 禁用：\`${entry.answer}\`${entry.question ? `（客户说到「${entry.question}」即转人工）` : ""}`);
        } else {
          lines.push(`- ${entry.question ? `**${entry.question}**：` : ""}${entry.answer}`);
        }
        if (entry.tags.length) lines.push(`  - 标签：${entry.tags.join(" / ")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}

export { MAX_PROMPT_QA, MAX_PROMPT_SNIPPETS, MIN_QA_MATCHED_TOKENS, MIN_QA_SIMILARITY };
