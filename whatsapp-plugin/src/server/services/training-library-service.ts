import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  TrainingCitation,
  TrainingLibraryEntry,
  TrainingLibraryImportResult,
  TrainingLibraryKind,
  TrainingLibraryMatch,
  TrainingLibraryMatchResult,
  TrainingLibraryStatus
} from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { containsPhrase, coverage, expandTokens, isDomainTerm, isStopTerm, tokenize } from "./text-match.js";

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
    /**
     * 归属知识库（CRM 训练成果发布时带上）。
     *
     * ⚠️ 如果来源合法：同一个 owner 的**同一条指纹只会有一行**（去重是身份，不是功能）。
     * 所以同一条问答被两个知识库发布时，先来的那个库"拥有"它 —— 这是刻意选择：
     * 让后来的悄悄偷走归属，会让「停用某个库」的结果变得无法预测。
     */
    kbId: z.string().trim().max(191).optional(),
    kind: trainingLibraryKindSchema,
    question: z.string().trim().max(2_000).optional(),
    answer: z.string().trim().min(1).max(8_000),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    languages: z.array(z.string().trim().min(1).max(16)).max(10).optional(),
    priority: z.number().int().min(0).max(1_000).optional(),
    enabled: z.boolean().optional(),
    /**
     * 出处三件套（哪个文件 / 哪一段 / 来源描述），随 CRM 训练成果发布带过来。
     * 只服务人看的引用卡片，**不进运行端提示词**；空串 = 历史条目 / 人工录入没有出处。
     */
    sourceTitle: z.string().trim().max(255).optional(),
    sourceAnchor: z.string().trim().max(64).optional(),
    sourceNote: z.string().trim().max(512).optional()
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
  /**
   * 状态过滤。**缺省只出 active**（提示词与列表的默认口径）；
   * 管理页要看候选池时显式传 `"all"`。
   */
  status?: TrainingLibraryStatus | "all";
}

/** 引用切片 / 标题的长度上限：一条出处最多占这么多字，不然「可展开」就变成了「又一篇正文」。 */
const CITATION_TITLE_LIMIT = 80;

/** 按字（而不是字节）截断，超出补省略号。码点安全：不会把一个 emoji / 汉字劈成两半。 */
function clipText(value: string, limit: number): string {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  return `${[...text].slice(0, limit).join("")}…`;
}

/**
 * 出处的标题：问答对用客户问法（那才是用户认得出这条的线索），
 * 其余三类是「一条说法」，用答案首句当标题 —— 政策/口径本来就没有问法。
 */
function citationTitle(entry: TrainingLibraryEntry): string {
  const head = entry.kind === "qa" ? entry.question : entry.answer;
  return clipText(head, CITATION_TITLE_LIMIT) || clipText(entry.answer, CITATION_TITLE_LIMIT);
}

/** 命中计数按 500 一片发 SQL：条目可能上千条，`IN (...)` 太长会被 MySQL 的 max_allowed_packet 顶回来。 */
function chunkIds(ids: string[], size: number): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += size) chunks.push(unique.slice(index, index + size));
  return chunks;
}

function fingerprintOf(kind: TrainingLibraryKind, question: string, answer: string): string {
  const normalized = [
    kind,
    question.replace(/\s+/gu, " ").trim().toLowerCase(),
    answer.replace(/\s+/gu, " ").trim().toLowerCase()
  ].join("\u0000");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// 候选清洗（导入闸门的第一道：机器做机械减法）
//
// 只做**能判定对错**的规则，不做判断类改写 —— 判断留给人工确认那一步。
// 实测档案样本里混着这些东西，它们进提示词只会教坏模型：
//   「[2026-03-04 10:22] 报价单.pdf (2.3MB)」
//   「照片 IMG_2031.jpg (1.2 MB)」
//   「好的，那我们先按这个方案走，后面有问题再联系…」
//   「[图片]」「👍」「对方撤回了一条消息」
// ---------------------------------------------------------------------------

/** 行首时间戳 / 日期分隔（聊天导出最常见的噪声）。 */
const LEADING_TIMESTAMP = /^\s*(?:\[\d{4}[-/]\d{1,2}[-/]\d{1,2}[^\]]*\]|\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*[-–]?)\s*/u;
/** 附件名 + 体积：`报价单.pdf (2.3MB)` / `IMG_2031.jpg 1.2 MB`。 */
const ATTACHMENT_WITH_SIZE = /^[^\n]{0,80}?\.(?:pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|webp|zip|rar|mp4|mov|heic)\s*\(\s*\d+(?:\.\d+)?\s*(?:kb|mb|gb)\s*\)\s*$/iu;
/** 站内系统短语：不是客户或业务员说的话。 */
const SYSTEM_PHRASES = [
  "对方撤回了一条消息",
  "撤回了一条消息",
  "消息已发出，但被对方拒收",
  "该消息已被删除",
  "你已添加了",
  "以上是打招呼的内容",
  "加入了群聊",
  "移出了群聊",
  "撤回了一条消息",
  "此消息已过期"
];
/** 纯占位（图片/视频/语音/位置/名片 + 纯 emoji）。 */
const PLACEHOLDER_ONLY = /^(?:\[(?:图片|视频|语音|文件|位置|名片|链接|表情|动画表情|贴纸|GIF|视频通话|语音通话)\]|[\p{Extended_Pictographic}\p{Emoji_Component}\s]+)$/u;
/** 结尾像被截断：省略号 / 悬空的连接词 / 未闭合的引号或括号。 */
const TRUNCATED_TAIL = /(?:\.{3,}|…+|因为|所以|但是|如果|以及|而且)$/u;
/**
 * 最短内容阈值，单位是**等效字符**而不是字符个数。
 *
 * 为什么不能直接数长度：中文一个字承载的信息量大约是英文三个字母。
 * 一刀切 6 个字符会把「不承诺交期」这种**完全合法**的 5 字政策丢掉
 * （实测：档案护栏「不承诺交期」被吞，导入结果里凭空多出 1 条 skipped），
 * 但直接降到 4 又会放进「好的」「收到」「OK」。所以按脚本折算：
 * CJK 记 3、其它记 1，阈值 12 —— 恰好等于「4 个汉字」或「12 个拉丁字符」。
 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/u;
const MIN_SAMPLE_WEIGHT = 12;

/** 样本的等效字符数：CJK 记 3、其它记 1。用于「这条够不够长」的判断。 */
function sampleWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += CJK_CHAR.test(char) ? 3 : 1;
  return weight;
}

/** 从样本里抽候选标签（纯关键词命中，可解释、可测试）。 */
const TAG_KEYWORDS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "报价", pattern: /报价|价格|单价|price|quot/iu },
  { tag: "交期", pattern: /交期|货期|工期|lead\s*time|deliver/iu },
  { tag: "认证", pattern: /认证|证书|资质|certificat|rohs|\bce\b|\biso\b/iu },
  { tag: "包装", pattern: /包装|装箱|外箱|pack|carton/iu },
  { tag: "样品", pattern: /样品|打样|sample/iu },
  { tag: "起订量", pattern: /起订|最小订|\bmoq\b/iu },
  { tag: "规格", pattern: /规格|参数|型号|spec|datasheet|dimension/iu },
  { tag: "付款", pattern: /付款|定金|尾款|账期|payment|\bt\/t\b|\bl\/c\b/iu },
  { tag: "物流", pattern: /运费|物流|海运|空运|fob|\bcif\b|shipping/iu },
  { tag: "售后", pattern: /售后|质保|保修|退换|warrant/iu }
];

function normalizeSampleText(value: string): string {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      let next = line.replace(LEADING_TIMESTAMP, "").replace(/[ \t]+/gu, " ").trim();
      // 附件占位行直接丢（保留空行由后面的 filter(Boolean) 处理）
      if (ATTACHMENT_WITH_SIZE.test(next)) next = "";
      return next;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 清洗一条档案样本。返回 `null` 表示「这条不值得进候选池」。
 * 清洗不通过不算错误 —— 它只是没进候选，导入结果里计入 skipped。
 */
export function cleanProfileSample(
  kind: TrainingLibraryKind,
  rawQuestion: string,
  rawAnswer: string
): { question: string; answer: string; tags: string[] } | null {
  const question = normalizeSampleText(rawQuestion).slice(0, 2_000);
  const answer = normalizeSampleText(rawAnswer).slice(0, 8_000);
  if (!answer) return null;
  if (kind === "qa" && !question) return null;
  if (sampleWeight(answer) < MIN_SAMPLE_WEIGHT) return null;
  if (kind === "qa" && question.length < 2) return null;

  const probe = `${question}\n${answer}`;
  for (const phrase of SYSTEM_PHRASES) {
    if (probe.includes(phrase)) return null;
  }
  if (PLACEHOLDER_ONLY.test(answer)) return null;
  if (TRUNCATED_TAIL.test(answer)) return null;
  if (kind === "qa" && TRUNCATED_TAIL.test(question)) return null;

  const tags = TAG_KEYWORDS.filter((item) => item.pattern.test(probe)).map((item) => item.tag).slice(0, 6);
  return { question, answer, tags };
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
      accountId: filter.accountId ?? undefined,
      status: filter.status
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
    if (existing && !id) {
      // 撞指纹 = 已经在了。但**归属要补**：见 assignTrainingLibraryEntryKb 的注释。
      const incomingKbId = input.kbId?.trim() ?? "";
      if (incomingKbId && !existing.kbId) {
        const assigned = await this.repository.assignTrainingLibraryEntryKb(existing.id, ownerUserId, incomingKbId);
        if (assigned) {
          const fresh = await this.get(ownerUserId, existing.id);
          return { entry: fresh ?? existing, created: false };
        }
      }
      return { entry: existing, created: false };
    }

    const timestamp = new Date().toISOString();
    const saved = await this.repository.saveTrainingLibraryEntry({
      id: existing?.id ?? randomUUID(),
      ownerUserId,
      accountId,
      accountName: existing?.accountName ?? null,
      // 已有归属优先；否则采纳这次带来的 kbId。
      // 「已有归属优先」是为了让"停用某个库"的结果可预测（见 schema 注释）；
      // 「采纳这次带来的」是为了让**本次改动之前**发布的条目在被重新发布时能补上归属 ——
      // 否则它们永远是"未分组"，而我的规则里未分组条目始终参与出稿，等于关不掉。
      kbId: existing?.kbId || input.kbId?.trim() || "",
      kind: input.kind,
      question,
      answer,
      tags: input.tags ?? [],
      languages: input.languages ?? [],
      priority: input.priority ?? 100,
      // 编辑时没显式改启用状态就沿用原值，别让一次「改错别字」把条目悄悄停用。
      enabled: input.enabled ?? existing?.enabled ?? true,
      // 人工录入 / 编辑的条目直接 active：人在录入那一刻就是确认动作。
      // 编辑已有条目时沿用原状态 —— 别让一次改错别字把它从候选池里「确认」掉。
      status: existing?.status ?? "active",
      // 人工录入即「校订过」（P3 分层加权 ×1.0）。编辑已有条目时沿用原值：
      // 改个错别字不该把「这条其实是机器导入的」这个事实抹掉。
      verified: existing?.verified ?? true,
      // 来源与命中次数是观测数据，不能被一次编辑抹掉。
      source: existing?.source ?? "manual",
      // 出处三件套同口径：这次没带就沿用原值，观测数据不能被编辑抹掉；
      // 空串 = 历史条目 / 人工录入没有出处。
      sourceTitle: input.sourceTitle?.trim() ?? existing?.sourceTitle ?? "",
      sourceAnchor: input.sourceAnchor?.trim() ?? existing?.sourceAnchor ?? "",
      sourceNote: input.sourceNote?.trim() ?? existing?.sourceNote ?? "",
      hitCount: existing?.hitCount ?? 0,
      adoptedCount: existing?.adoptedCount ?? 0,
      lastHitAt: existing?.lastHitAt ?? null,
      lastAdoptedAt: existing?.lastAdoptedAt ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      fingerprint
    });
    return { entry: saved, created: !existing };
  }

  /**
   * 批量确认 / 丢弃候选（训练页的「候选确认」区）。
   *
   * `confirm` → `active` **且 `enabled=true`**（从这一刻起真的进提示词）；
   * `drop` → `archived` 且停用（保留整行留痕，不进检索，也不会被下次导入又当新条目加回来 —— 指纹还在）。
   *
   * ⚠️ 两个字段必须一起改：检索读 `enabled`，列表默认口径读 `status`。
   * 只翻 status 的话用户点了「确认」，条目既不出现在默认列表里、也进不了提示词 ——
   * 表现就是「点了没反应」，人工确认这道闸门等于白装。
   */
  async reviewCandidates(
    ownerUserId: string,
    ids: string[],
    action: "confirm" | "drop"
  ): Promise<{ changed: number; status: TrainingLibraryStatus }> {
    const status: TrainingLibraryStatus = action === "confirm" ? "active" : "archived";
    const changed = await this.repository.setTrainingLibraryStatus(ownerUserId, ids, status, action === "confirm");
    return { changed, status };
  }

  async remove(ownerUserId: string, id: string): Promise<void> {
    const removed = await this.repository.deleteTrainingLibraryEntry(id, ownerUserId);
    if (!removed) throw new DomainError("TRAINING_LIBRARY_ENTRY_NOT_FOUND", 404, "Training library entry not found");
  }

  /**
   * 把训练档案里的问答样本导入训练库。
   * 这是「导出 → 训练 → 入库」链路的第三步：档案是一次性快照，进了库才成为可维护的长期资产。
   * 幂等：同一条问答重复导入只算一次。
   *
   * **导入 = 进候选池**（`status='candidate'`、`enabled=false`）：
   * 档案是机器从聊天记录里抽的，里面必然混着时间戳、附件名体积、被截断的半句话
   * （已实测：45 条 100% 来自自动导入、0 条人工确认）。以前它们**直接生效进提示词**，
   * 是污染最快的入口。现在机器只做「机械减法」（清洗 + 去重 + 抽标签），
   * **人做「责任加法」**：训练页一次确认 20 条约 2 分钟，确认后才 active。
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
    const candidateIds: string[] = [];
    for (const input of inputs) {
      const cleaned = cleanProfileSample(input.kind, input.question, input.answer);
      if (!cleaned) {
        skipped += 1;
        continue;
      }
      const { question, answer } = cleaned;
      const fingerprint = fingerprintOf(input.kind, question, answer);
      if (await this.repository.findTrainingLibraryByFingerprint(ownerUserId, fingerprint)) {
        skipped += 1;
        continue;
      }
      const timestamp = new Date().toISOString();
      const id = randomUUID();
      await this.repository.saveTrainingLibraryEntry({
        id,
        ownerUserId,
        accountId: profile.accountId,
        accountName: null,
        // 档案导入进来的条目不属于任何知识库：它是插件自己的老路径，
        // 按"未分组"处理（始终参与出稿），与它在本改动之前的行为一致。
        kbId: "",
        kind: input.kind,
        question,
        answer,
        tags: cleaned.tags,
        languages: input.languages,
        priority: 100,
        // 候选默认不启用：enabled 与 status 两个字段一个都不放过，
        // 因为检索路径读的是 enabled，而状态过滤读的是 status —— 漏一个就等于没拦住。
        enabled: false,
        status: "candidate",
        // 机器导入的一律没校订（P3 分层加权 ×0.4 且只认精确命中）；
        // 人工在训练页点了「确认」才由 setTrainingLibraryStatus 翻成 true。
        verified: false,
        source: "profile",
        hitCount: 0,
        adoptedCount: 0,
        lastHitAt: null,
        lastAdoptedAt: null,
        // 档案导入没有「哪个文件哪一段」可追：三件套留空，展示层按空处理。
        sourceTitle: "",
        sourceAnchor: "",
        sourceNote: "",
        createdAt: timestamp,
        updatedAt: timestamp,
        fingerprint
      });
      candidateIds.push(id);
      created += 1;
    }
    return { created, skipped, total: inputs.length, candidateIds };
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
    // 只取 active：候选池（candidate）与已丢弃（archived）一律不进提示词。
    // 这一步是「人工确认」这道闸门真正生效的地方 —— 不给它把关，前面的清洗都是白做。
    //
    // 语料范围由**账号的启用知识库清单**决定（见 repository.listResolvableTrainingLibraryEntries）：
    // 清单里可以有自己的库，也可以有别人公开后自己勾选的库 —— 训练成果的分享就落在这里。
    const subscriptionRows = await this.repository.listTrainingKbSubscriptionRows(ownerUserId);
    const configured = subscriptionRows.length > 0;
    const enabledKbIds = subscriptionRows.filter((id) => id !== "");
    const { entries, skippedByScope } = await this.repository.listResolvableTrainingLibraryEntries(ownerUserId, {
      enabledKbIds,
      configured,
      accountId
    });
    const hits = this.rankQa(inboundBody, entries.filter((entry) => entry.kind === "qa"));
    // snippet 按**与这句客户消息的相关度**排序后取 Top N。
    // 旧版是无脑取前 6 条（按 priority/updated_at），等于把库里最早改的几句口径
    // 无条件塞进每一次回复 —— 那是最快污染入口（G13②）。
    const snippets = this.selectSnippets(inboundBody, entries.filter((entry) => entry.kind === "snippet"));
    // policy 是硬约束，保持全量注入；超上限只提示不截断（截断政策比多占 token 危险得多）。
    const allPolicies = entries.filter((entry) => entry.kind === "policy");
    const policies = allPolicies.slice(0, MAX_PROMPT_POLICIES);
    const warnings: string[] = [];
    if (allPolicies.length > MAX_PROMPT_POLICIES) {
      warnings.push(`政策条目 ${allPolicies.length} 条，已超过单次注入上限 ${MAX_PROMPT_POLICIES}，建议合并同义政策`);
    }
    const allSnippets = entries.filter((entry) => entry.kind === "snippet");
    if (allSnippets.length > MAX_PROMPT_SNIPPETS) {
      warnings.push(`口径片段共 ${allSnippets.length} 条，本次按相关度取 ${snippets.length} 条`);
    }
    const forbidden = entries
      .filter((entry) => entry.kind === "forbidden" && entry.question && containsPhrase(inboundBody, entry.question))
      .map((entry) => {
        const matchedTerms = tokenize(entry.question);
        return { entry, similarity: 1, matched: matchedTerms.length, matchedTerms };
      });
    const forbiddenPhrases = entries
      .filter((entry) => entry.kind === "forbidden")
      .map((entry) => entry.answer.trim())
      .filter(Boolean);

    // 知识库清单的影响必须让用户看得见：否则「我明明有这个库却没命中」只能靠猜。
    //
    // ⚠️ `configured=false`（从未同步过清单）**刻意不报警告** —— 那不是降级，
    //    它就是本改动之前的行为（自己的语料全用），而它又是绝大多数账号的默认状态。
    //    把它写成 warnings 会让一条永不消失的"告警"常驻在每次试问上，
    //    真正要看的那条（「有 N 条因所属知识库未启用而未参与」）就被淹掉了。
    //    这个事实由 `kbScope` 结构化回报，界面按"检索范围"中性表述。
    const legacyCount = entries.filter((entry) => !entry.kbId).length;
    if (configured && !enabledKbIds.length) {
      warnings.push("当前账号一个知识库都没启用，本次只用未分组的自有语料");
    }
    if (configured && legacyCount > 0) {
      warnings.push(`另有 ${legacyCount} 条未分组语料始终参与（它们不属于任何知识库）`);
    }
    if (skippedByScope > 0) {
      warnings.push(`有 ${skippedByScope} 条语料因所属知识库未启用而未参与本次检索`);
    }

    const expandedHitsTotal = hits.reduce((total, hit) => total + (hit.expandedHits ?? 0), 0);
    const verdict = [
      `命中 ${hits.length} 条问答${hits.length ? `（最高相似度 ${hits[0].similarity.toFixed(2)}${expandedHitsTotal > 0 ? "，含词典等价命中" : ""}）` : ""}`,
      `引用 ${snippets.length} 条口径`,
      `${policies.length} 条政策`,
      forbidden.length ? `${forbidden.length} 条禁用场景命中` : ""
    ]
      .filter(Boolean)
      .join("；");
    return {
      query: inboundBody,
      hits,
      snippets,
      policies,
      forbidden,
      forbiddenPhrases,
      citations: this.buildCitations(inboundBody, { hits, snippets, policies, forbidden }),
      verdict,
      warnings,
      /**
       * 知识库清单对本次检索的影响。让"没命中"这件事可归因：
       * 是被清单挡掉的（`skippedByScope`），还是根本没进语料（`considered` 为 0）。
       */
      kbScope: {
        configured,
        enabledKbIds,
        considered: entries.length,
        skippedByScope
      }
    };
  }

  /**
   * 把这一轮检索到的四类条目压成一份**可展开的出处清单**。
   *
   * 三类用途，一个结构：
   * 1. 界面「来源」点开看到的就是它（条目 → 出处 → 原文三层的第一层）；
   * 2. P3 的引用校验以它的 `refId` 集合为准（草稿回引的 id 必须 ⊆ 这个集合）；
   * 3. 成绩单的「来源命中率」拿它跟 golden 的期望出处比对。
   *
   * 顺序是**刻意的插入序**（问答 → 口径 → 政策 → 禁用），不做二次排序：
   * 界面本来就按类分组展示，重排只会让「第一条 = 主依据」这个约定失效。
   *
   * ⚠️ 注意 policy / forbidden 是**约束型出处**（每次回复都会带上，与这句来文无关），
   * 只有 qa / snippet 才是**内容型出处**。所以「依据不足该弃答」的判定不能写成
   * `citations.length === 0`（有政策时永远不为空），要看有没有内容型命中。
   */
  private buildCitations(
    inboundBody: string,
    parts: {
      hits: TrainingLibraryMatch[];
      snippets: TrainingLibraryEntry[];
      policies: TrainingLibraryEntry[];
      forbidden: TrainingLibraryMatch[];
    }
  ): TrainingCitation[] {
    const queryTokens = tokenize(inboundBody);
    const { expanded } = expandTokens(queryTokens, inboundBody);
    const querySet = new Set([...queryTokens, ...expanded]);

    /** 口径片段的分数 = 命中特征占查询特征的比例（与 selectSnippets 的排序依据同源）。 */
    const snippetOverlap = (entry: TrainingLibraryEntry): { score: number; hitTerms: string[] } => {
      if (!querySet.size) return { score: 0, hitTerms: [] };
      const tokens = new Set(tokenize(`${entry.question} ${entry.answer}`));
      const terms = [...querySet].filter((token) => tokens.has(token));
      return { score: Math.round((terms.length / querySet.size) * 1000) / 1000, hitTerms: terms.slice(0, 12) };
    };

    const citations: TrainingCitation[] = [];
    const seen = new Set<string>();
    const push = (
      entry: TrainingLibraryEntry,
      extra: { score: number; hitTerms: string[] }
    ): void => {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      citations.push({
        sourceType: "training_library",
        refId: entry.id,
        kind: entry.kind,
        title: citationTitle(entry),
        snippet: clipText(entry.answer, 200),
        anchor: entry.kind === "qa" ? "" : clipText(entry.question, 80),
        score: Math.round(extra.score * 1000) / 1000,
        hitTerms: extra.hitTerms.slice(0, 12),
        verified: entry.verified,
        adopted: entry.adoptedCount > 0,
        hitCount: entry.hitCount,
        // 出处三件套：有就带出去，引用卡片显示「《文件》§段落 · 描述」；空串按没有处理。
        sourceTitle: entry.sourceTitle || undefined,
        sourceAnchor: entry.sourceAnchor || undefined,
        sourceNote: entry.sourceNote || undefined
      });
    };

    for (const hit of parts.hits) push(hit.entry, { score: hit.similarity, hitTerms: hit.matchedTerms });
    for (const entry of parts.snippets) push(entry, snippetOverlap(entry));
    // 政策与禁用短语是硬约束：全量注入、没有「命中词」这回事，分数恒为 1（不代表相关度）。
    for (const entry of parts.policies) push(entry, { score: 1, hitTerms: [] });
    for (const hit of parts.forbidden) push(hit.entry, { score: 1, hitTerms: hit.matchedTerms });
    return citations;
  }

  /**
   * 口径片段的选取：先按与客户消息的相关度排序，相关度相同再按优先级。
   *
   * 全都不相关（客户这句跟任何口径都打不着）时退回「按优先级取前 N」——
   * 这是刻意的：口径片段本来就是固定说法，没有相关信号时按优先级拿并不是错，
   * 但**不能**因此把「明显更相关的另一条」挤掉。
   */
  selectSnippets(inboundBody: string, entries: TrainingLibraryEntry[]): TrainingLibraryEntry[] {
    if (entries.length <= MAX_PROMPT_SNIPPETS) return entries;
    const queryTokens = tokenize(inboundBody);
    const { expanded } = expandTokens(queryTokens, inboundBody);
    const querySet = new Set([...queryTokens, ...expanded]);
    const scored = entries.map((entry) => {
      const entryTokens = new Set(tokenize(`${entry.question} ${entry.answer}`));
      let overlap = 0;
      for (const token of querySet) if (entryTokens.has(token)) overlap += 1;
      return { entry, overlap };
    });
    if (!scored.some((item) => item.overlap > 0)) return entries.slice(0, MAX_PROMPT_SNIPPETS);
    return scored
      .sort((left, right) => right.overlap - left.overlap
        || right.entry.priority - left.entry.priority
        || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
      .slice(0, MAX_PROMPT_SNIPPETS)
      .map((item) => item.entry);
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
    // 极短问法（「price?」「moq?」「payment?」——客户真就这么发）原始特征词只有 1~2 个。
    // 按「至少 2 个共同特征」的常规门槛，它们在**任何**语料下都凑不够，补语料也没用：
    // 这是尺子的刻度问题，不是库的问题。所以对短查询开一个口子，但必须同时满足：
    //   ① 查询本身很短（≤2 个特征词），长句不享受；
    //   ② 命中的词里有贸易域强特征（price/报价/moq/交期…），否则「hello there」也能命中一切；
    //   ③ 条目本身得像**一句问法**（≤80 字）。实测库里有 600 字的聊天记录只是恰好含
    //      "quotation" 就被命中——那是上下文，不是问法，放宽门槛时绝不能让它们进来。
    //
    // 「短」的口径按**实义词**算，不按 token 总数：`how much per unit?` 切出 4 个词，
    // 但 how/much/per 都是虚词，真正有信息量的只有 unit —— 它是短查询，不是长句。
    // 按 token 总数算会让这类最典型的问价说法永远走不到短查询通道（实测 0 命中）。
    const meaningfulQueryCount = queryTokens.filter((token) => !isStopTerm(token)).length;
    const shortQuery = queryTokens.length <= 2 || meaningfulQueryCount <= 1;
    const looksLikeQuestion = (entry: TrainingLibraryEntry): boolean => entry.question.trim().length <= 80;
    // 客户用什么语言问，就先用同语言的条目回：规则通道是**原样复用 answer**，
    // 不会翻译。中英两条相似度打平时若取了英文条目，中文客户会收到英文报价（实测踩到）。
    const queryIsZh = /[\u4e00-\u9fff]/u.test(inboundBody);
    /**
     * 客户这条消息里有没有提到**型号**（TR700 / LF100 / RS485 这类字母+数字的组合）。
     *
     * 用途只有一个：防止"没型号的问题"被绑死型号的条目录走。实测客户只发 `price?`，
     * 排序把「Please quote your best FOB price for TR700」顶到第一，直接甩出 TR700 的
     * 1650 元 —— 客户问的是哪台都不知道，报错型号价的代价远大于少答一句。
     * 数字不算型号（`100 units` 是数量），必须是**字母与数字都在同一 token** 才认。
     */
    const MODEL_TOKEN = /[a-z]{1,6}\d{2,}|\d{2,}[a-z]{1,6}/u;
    const queryHasModel = queryTokens.some((token) => MODEL_TOKEN.test(token));
    return entries
      .map((entry) => {
        const entryTokens = tokenize(entry.question);
        const matchedTerms = entryTokens.filter((token) => querySet.has(token));
        const expandedMatched = expanded.filter((token) => entryTokens.includes(token)).length;
        // 强特征命中数：门槛与同分时的次序依据。虚词凑出来的「2 个共同特征」不该排在
        // 「真的命中 price / 报价」的条目前面（实测就是这么把报价问法排到展会回复上的）。
        const strongMatched = matchedTerms.filter((token) => isDomainTerm(token)).length;
        const entryIsZh = entry.languages.includes("zh") || /[\u4e00-\u9fff]/u.test(entry.question);
        const languageMatch = entryIsZh === queryIsZh ? 1 : 0;
        // 跨语言命中：客户英文问、库里只有中文条目（或反过来）。中文按相邻两字切，
        // **一个概念只贡献 1~2 个 bigram**（「质保期」→ 质保/保期），所以按
        // 「至少 2 个共同特征」判死等于要求英文客户每个问题都得撞上两个不同概念。
        // 实测 "What is the warranty period?" 只命中「质保」一个词，库里有答案却返回空。
        const crossLanguage = entryIsZh !== queryIsZh;
        // 1 = 客户没提型号、这条却绑死了型号：可以留在候选里，但必须排在不绑型号的条目后面。
        const modelMismatch = !queryHasModel && entryTokens.some((token) => MODEL_TOKEN.test(token)) ? 1 : 0;
        // 计入门槛的只算实义词：`how much` 两个词都是虚词，旧口径下它们能凑够"2 个共同特征"，
        // 于是任何含 how/much 的句子都能过关 —— 门槛被虚词架空。
        const meaningfulMatched = matchedTerms.filter((token) => !isStopTerm(token)).length;
        return {
          entry,
          matched: matchedTerms.length,
          meaningfulMatched,
          // 命中的词原样带出去：界面要展示「为什么是这条」，只说一个分数是没法核验的。
          matchedTerms,
          similarity: coverage(matchedTerms.length, querySize, entryTokens.length),
          strongMatched,
          languageMatch,
          crossLanguage,
          modelMismatch,
          ...(expandedMatched > 0 ? { expandedHits: expandedMatched } : {})
        };
      })
      .filter((item) => {
        const similar = item.similarity >= MIN_QA_SIMILARITY;
        if (!similar) return false;
        /**
         * 短问法只认**问法条目**。
         *
         * 客户发 `price?`（2 个词）时，覆盖率的分母很小，一条 200 字的聊天记录只要
         * 恰好含 price/quote 两个词，分数就能压过真正的标准问法 —— 实测被顶上来的是
         * 「We would like to do DDP method deliver to our factory…」那段清关对话，
         * 回复直接变成一段与问价无关的闲聊。两个词的提问拿聊天记录来答，本身就是错的
         * 对应关系，不是分数高低问题。
         */
        if (shortQuery && !looksLikeQuestion(item.entry)) return false;
        // 常规：至少两个**实义**共同特征 —— 虚词凑数不算（旧口径下 "how much" 能架空门槛）。
        // 例外：只有一个实义词但命中了贸易域强特征，且条目确实是一句问法。
        // 标准问句常常只有一个实体词（"What is your MOQ?" 只有 MOQ），不能因此判死。
        const normal =
          item.matched >= MIN_QA_MATCHED_TOKENS &&
          (item.meaningfulMatched >= MIN_QA_MATCHED_TOKENS ||
            (item.strongMatched >= 1 && looksLikeQuestion(item.entry)));
        // 极短问法（"price?"）只有一个词，永远凑不够两个特征：命中强特征且条目是问法就放行。
        const short = shortQuery && item.strongMatched >= 1 && looksLikeQuestion(item.entry);
        /**
         * 跨语言通道：三个条件同时成立才放行 ——
         * ① 命中的是**词典扩展词**（`expandedHits >= 1`），说明是"英文概念对上了中文说法"，
         *    而不是 the/what 这类虚词撞车；
         * ② 命中的词里至少有一个**贸易域强特征**（质保/下单/认证/价格…），
         *    保证不是靠一个泛词蒙混进来的；
         * ③ 查询本身的**实义词不超过 2 个**。这一条是给「只蹭到一个词」上锁的：
         *    `What is the warranty period?` 只有 warranty/period 两个实义词，命中「质保」
         *    就是这句话的全部意思；而 `Could you send me a price list when convenient`
         *    一长串实义词只蹭到「价格」，说的是"发价目表"而不是"价格怎么样"，
         *    这种必须继续拦在门外（既有测试专门守着它）。
         * 条目仍须是问法（≤80 字），600 字的聊天记录不享受这条口子。
         */
        const crossLanguageHit =
          item.crossLanguage &&
          (item.expandedHits ?? 0) >= 1 &&
          item.strongMatched >= 1 &&
          meaningfulQueryCount <= 2 &&
          looksLikeQuestion(item.entry);
        return normal || short || crossLanguageHit;
      })
      .sort(
        (left, right) =>
          // 先按相关度：相似度才回答「这句问法有多接近」。强特征只在同分时打破平局 ——
          // 把它放第一位会压制真正更像的那条（实测「多少钱一台」输给了只有一个强词的泛问条目）。
          right.languageMatch - left.languageMatch ||
          // 型号不匹配的条目排在后面：`price?` 这种没型号的问法先拿泛问条目（它会反问型号），
          // 而不是直接把某一台的价报出去。两者都匹配或都不匹配时这一项恒为 0，不影响既有次序。
          left.modelMismatch - right.modelMismatch ||
          right.similarity - left.similarity ||
          right.strongMatched - left.strongMatched ||
          right.entry.priority - left.entry.priority
      )
      .slice(0, MAX_PROMPT_QA);
  }

  /**
   * 命中计数：只在条目真的被用上时加，界面靠它清理「建了从来没被用过」的死条目。
   *
   * **四类都要计**（P0 的实质改动）。旧版只有 qa 命中被计，于是：
   * 口径片段与政策天天进提示词，`hit_count` 却永远是 0 → 清理清单判不准、
   * 「90 天 0 命中就该退役」这条规则会把天天在用的政策误杀。
   *
   * `adopted` 是**另一件事**：条目被检索到 ≠ 它帮上了忙。草稿真被发出去时才算采纳，
   * 两者分开记，界面才能回答「这条是我建着玩的还是真在用」。
   */
  async recordHits(ids: string[], options: { adopted?: boolean } = {}): Promise<void> {
    for (const chunk of chunkIds(ids, 500)) {
      await this.repository.bumpTrainingLibraryHits(chunk, options);
    }
  }

  // `forbiddenHits()` 已删除（2026-10-16，P0）：
  // 它做的是「拿生成的回复去比对禁用短语」，而这件事已经在 `auto-chat-service.ts::applyGuardrails()`
  // 里用**同一次 resolve 的结果**（`library.forbiddenPhrases` + `containsPhrase`）做了。
  // 两处实现同一件事的代价是：多一次全库查询、以及某天两边口径漂移。
  // 保留一个永不调用的公开方法只会让人以为还有一条纪律在别处生效 —— 所以删掉，不留死代码。

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
