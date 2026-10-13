import { z } from "zod";
import type { ComposeMessage } from "./auto-chat-service.js";
import {
  CLI_MODEL_DEFAULT,
  CliEngine,
  RESOURCE_SCOUT_SKILL,
  cliSkillDirective,
  sanitizeCliEffort,
  sanitizeCliModel
} from "./cli-engine.js";
import {
  CrmUnavailableError,
  ResourceHubClient,
  toCrmConversation,
  type CrmRecommendationResponse,
  type CrmResourceCandidate,
  type CrmResourceMatch,
  type CrmResourceReason,
  type CrmResourceStatsResponse,
  type CrmRevealResponse,
  type ResourceFeedbackItem,
  type ResourceSourceType
} from "./crm-resources.js";
import { extractJsonObject } from "./json-extract.js";

/**
 * 「这次该发哪几份资料」的插件侧编排。
 *
 * 分两层，两层的失败方式**完全不同**，所以必须分开对待：
 *
 * 1. **召回**（走 CRM `POST /api/agent/resources/recommend`，纯算法 ≤300ms）：
 *    拿回候选 + 打分 + 机器可判定的理由。这一层挂了，就是「没有资料可推」，面板出一行原因。
 * 2. **复排 + 说人话**（走本机 CLI，10–60s）：
 *    从候选里挑 1–3 份、写一句业务员看得懂的理由、给一句能直接发的话。
 *    这一层挂了**不影响第 1 层**：候选照常展示，只是理由退化成 CRM 给的 headline。
 *
 * 这个文件里所有对外方法**永不抛错**。原因和第 1 层一样：资料推荐是回复链上的一件
 * 「锦上添花」，它坏了绝不能把「回复」这件事一起拖下水。失败一律进 `warnings[]`，
 * 面板上显示成「资料推荐未取到：…」，而回复照常出。
 */

/** 面板一次最多展示几条。够用就好：给十条等于让业务员自己再挑一遍。 */
const DEFAULT_LIMIT = 5;
/** 塞进提示词的候选上限。CRM 可以召回更多，但提示词塞太多会让模型挑花眼、也变慢。 */
const MAX_CANDIDATES_IN_PROMPT = 12;
/** 复排超时。比回复生成略宽：还要读一遍技能方法论。 */
const CURATE_TIMEOUT_MS = 60_000;

/**
 * 建议话术里的「金额」检测。
 *
 * 为什么专门拦这个：`suggestedLine` 是**要直接发给客户**的一句话，而历史报价是旧价。
 * 让模型写「报价是 $8.5/pcs」出来，就是拿去年的价钱去承诺今年的单。宁可清空这句话
 * （业务员自己补），也不放一句带金额的文本过去。
 *
 * 只拦机器能判定的：货币符号 / 货币代码紧跟数字。其余（语气、是否夸大）交给技能方法论与人工。
 */
const AMOUNT_PATTERN =
  /(?:[$€¥￥]\s?\d|\b(?:USD|EUR|CNY|RMB|JPY|GBP|AUD|CAD)\b\s*[\d.,]+|[\d.,]+\s*\b(?:USD|EUR|CNY|RMB|JPY|GBP|AUD|CAD)\b)/iu;

const curateSchema = z.object({
  picks: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(200),
        why: z.string().trim().max(400).default(""),
        suggestedLine: z.string().trim().max(800).default("")
      })
    )
    .max(20)
    .default([]),
  reply: z.string().trim().max(1_200).default("")
});

/**
 * 一条给面板用的候选资源。
 *
 * **没有 `url` 字段** —— 真实地址只能经 CRM 的 reveal 接口取，而且只在业务员真的点了
 * 「打开 / 复制链接」时才取。这一条在 `CrmResourceCandidate` 那层就已经成立了，
 * 这里刻意不补回来（补回来就等于把地址悄悄塞进了推荐结果）。
 */
export interface SuggestedResource {
  id: string;
  sourceType: ResourceSourceType;
  /** `sourceType:id`。给模型看、也用于回填时去重。 */
  key: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  fileType: string;
  version: string;
  author: string;
  updatedAt: string;
  accessCount: number;
  hasExternalLink: boolean;
  score: number;
  /** CRM 给的一句结论，如「「led」「规格书」都在这份资料里」。没复排时面板显示它。 */
  headline: string;
  match: CrmResourceMatch;
  reasons: CrmResourceReason[];
  hitTerms: string[];
  /** CLI 复排给出的挑选理由（空串 = 未复排）。 */
  why: string;
  /** CLI 复排给出的、可直接发给客户的一句话（**永不自作主张发送**，由业务员决定）。 */
  suggestedLine: string;
}

export interface ResourceSearchResult {
  resources: SuggestedResource[];
  retrieval: CrmRecommendationResponse["retrieval"] | null;
  customer: { matched: boolean; id: string; company: string };
  /** 降级原因。非空不代表失败——回复/推荐照常出，只是这块依据缺失或有折损。 */
  warnings: string[];
  tookMs: number;
}

export interface ResourceSuggestResult extends ResourceSearchResult {
  /**
   * 复排产出的一句**给业务员看的备注**（中文）。
   *
   * 刻意不叫 `reply`：这是「这批资料我都看了，建议先发规格书」这种内部说明，
   * 不是发给客户的话。发给客户的话在 `resources[].suggestedLine`（逐份一条）。
   * 历史教训：字段名叫 reply 时，界面很自然就会把它渲染成"推荐回复"，两句话就串了。
   */
  curatorNote: string;
  replyEngine: "cli" | "none";
  /** CLI **自报**的模型（唯一直接证据）。 */
  model: string | null;
  /** 复排是否真的跑过。面板靠它区分「AI 挑过」与「只是算法排序」。 */
  curated: boolean;
}

export interface ResourceSearchInput {
  /** 目录式检索用的关键词。给了 `messages` 时忽略。 */
  q?: string;
  /** 现场对话（扩展从页面上读到的）。给了就走「按对话推荐」。 */
  messages?: ComposeMessage[];
  customerId?: string;
  conversationKey?: string;
  limit?: number;
  sourceTypes?: ResourceSourceType[];
  signal?: "inbound" | "compose" | "manual";
}

export interface ResourceSuggestInput extends Omit<ResourceSearchInput, "q"> {
  /** 是否走 CLI 复排（慢）。默认 true：面板要的是「挑好的」，不是一坨候选。 */
  withAi?: boolean;
  model?: string;
  effort?: string;
}

interface Retrieval {
  candidates: CrmResourceCandidate[];
  retrieval: CrmRecommendationResponse["retrieval"] | null;
  customer: { matched: boolean; id: string; company: string };
}

/** 候选的稳定键。跨来源的 id 可能撞车，所以键里必须带 sourceType。 */
export function resourceKey(candidate: { sourceType: string; id: string }): string {
  return `${candidate.sourceType}:${candidate.id}`;
}

/**
 * 建议话术的硬闸门。返回清空后的内容与「是否拦下过」。
 * 抽成纯函数是为了能被回测直接打到——这条规则一旦失效，是会发出过期报价的。
 */
export function sanitizeSuggestedLine(line: string): { line: string; dropped: boolean } {
  const text = String(line ?? "").trim();
  if (!text) return { line: "", dropped: false };
  return AMOUNT_PATTERN.test(text) ? { line: "", dropped: true } : { line: text, dropped: false };
}

export function toSuggested(candidate: CrmResourceCandidate): SuggestedResource {
  return {
    id: candidate.id,
    sourceType: candidate.sourceType,
    key: resourceKey(candidate),
    title: candidate.title,
    category: candidate.category,
    summary: candidate.summary,
    tags: [...(candidate.tags ?? [])],
    fileType: candidate.fileType,
    version: candidate.version,
    author: candidate.author,
    updatedAt: candidate.updatedAt,
    accessCount: candidate.accessCount,
    hasExternalLink: Boolean(candidate.hasExternalLink),
    score: candidate.score,
    headline: candidate.headline,
    match: candidate.match,
    reasons: [...(candidate.reasons ?? [])],
    hitTerms: [...(candidate.hitTerms ?? [])],
    why: "",
    suggestedLine: ""
  };
}

/**
 * 复排提示词。**候选清单必须整体嵌进提示词** —— 这是一次生成，不是 Agent 会话，
 * 不能让模型自己去「调工具拿清单」：那道往返在 `--print --max-turns 2` 下走不完，
 * 且失败方式是静默地少挑几份，非常难查。
 *
 * 抽成导出的纯函数，回测才能直接断言「候选真的进提示词了」，而不是只看返回值猜。
 */
export function buildResourceCuratePrompt(
  messages: ComposeMessage[],
  candidates: CrmResourceCandidate[],
  limit: number
): string {
  // 上限收在这里，而不是只由调用方负责：这个函数是「提示词大小」的唯一知情人，
  // 把裁剪留在外面，早晚会有另一条调用路径忘了裁，然后一次请求撑爆上下文。
  const shortlist = candidates.slice(0, MAX_CANDIDATES_IN_PROMPT);
  const conversation = toCrmConversation(messages);
  const latestCustomer = [...conversation].reverse().find((message) => message.role === "customer");
  const payload = {
    candidateMaterials: shortlist.map((candidate) => ({
      key: resourceKey(candidate),
      title: candidate.title,
      sourceType: candidate.sourceType,
      category: candidate.category,
      summary: candidate.summary,
      tags: candidate.tags,
      fileType: candidate.fileType,
      version: candidate.version,
      relevance: Number(candidate.score.toFixed(3)),
      whyRetrieved: candidate.reasons.map((reason) => reason.text).slice(0, 3)
    })),
    recentConversation: conversation,
    customerLatestMessage: latestCustomer?.text ?? ""
  };
  return [
    cliSkillDirective(RESOURCE_SCOUT_SKILL),
    "",
    "Task: decide which of the team's prepared materials to send in this WhatsApp conversation.",
    `Pick at most ${limit} items from \`candidateMaterials\`. Items that are not in that list do not exist.`,
    "If nothing in the list fits this conversation, return an empty `picks` array. That is a valid, correct answer.",
    'Return one JSON object only, exactly this shape: {"picks":[{"id":string,"why":string,"suggestedLine":string}],"reply":string}',
    "- `id`: copy the candidate's `key` verbatim.",
    "- `why`: one sentence for the salesperson, in Chinese, saying why this material fits THIS conversation. Quote the title/tags and something the customer actually said.",
    "- `suggestedLine`: one short sentence in the customer's own language that the salesperson could send as-is. It must NOT contain prices, discounts, lead times or stock levels — leave it empty instead.",
    "- `reply`: an optional one-sentence Chinese note for the salesperson summarising your choice. Empty string when there is nothing worth saying.",
    "- Do not call any tool other than loading your skill. Do not search the workspace, do not read files, do not explain.",
    "",
    JSON.stringify(payload)
  ].join("\n");
}

export class ResourceRecommendService {
  constructor(
    /** CRM 资源中心通道。缺省 = 没有资料推荐，但整条回复链照常。 */
    private readonly hub?: ResourceHubClient,
    /** 本机 CLI。缺省时只做算法排序（快的那一半），不报错。 */
    private readonly cli?: CliEngine
  ) {}

  get configured(): boolean {
    return Boolean(this.hub?.configured);
  }

  /** 不可用时说明原因，界面直接显示。 */
  unavailableReason(): string {
    return this.hub ? this.hub.unavailableReason() : "插件未接入 CRM 资源中心";
  }

  /**
   * 推荐效果报表（只读透传，docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）。
   *
   * 与 recommend/reveal 那些方法不同：这里**允许抛错**。它是独立的管理页数据，
   * 没有挂在回复链上 —— 失败时把上游原因如实抛给路由（502），比在插件侧伪造一份
   * 「全 0 的假报表」诚实得多。
   */
  async stats(ownerUserId: string, days = 30): Promise<CrmResourceStatsResponse> {
    if (!this.hub) throw new CrmUnavailableError(this.unavailableReason());
    return this.hub.stats(ownerUserId, days);
  }

  /**
   * 只要资料（快，不调模型）。给面板一个「立刻有东西」的初值。
   *
   * 两种模式：
   * - 给了 `messages` → 按对话推荐（走 CRM 的四路打分）；
   * - 没给 `messages` → 目录式检索（走 `GET /api/agent/resources`），给面板的「全部资料」用。
   */
  async search(ownerUserId: string, input: ResourceSearchInput): Promise<ResourceSearchResult> {
    const started = Date.now();
    const { retrieval, warnings } = await this.collect(ownerUserId, input);
    return {
      resources: retrieval.candidates.map(toSuggested),
      retrieval: retrieval.retrieval,
      customer: retrieval.customer,
      warnings,
      tookMs: Date.now() - started
    };
  }

  /**
   * 回复 + 资料一次给全（慢，可能走 CLI）。
   *
   * `withAi: false` 时等价于 `search`，只多两个恒定字段。刻意保留同一个出口：
   * 扩展只有一条通道，不该为了「这次不要 AI」去换接口。
   */
  async suggest(ownerUserId: string, input: ResourceSuggestInput): Promise<ResourceSuggestResult> {
    const started = Date.now();
    // 只取一次数：复排用的候选与面板展示的候选**必须是同一批**，否则会出现
    // 「挑出来的那份不在列表里」这种自己都解释不清的界面。
    const { retrieval, warnings } = await this.collect(ownerUserId, input);
    const result: ResourceSuggestResult = {
      resources: retrieval.candidates.map(toSuggested),
      retrieval: retrieval.retrieval,
      customer: retrieval.customer,
      warnings,
      tookMs: 0,
      curatorNote: "",
      replyEngine: "none",
      model: null,
      curated: false
    };
    const finish = (): ResourceSuggestResult => {
      result.tookMs = Date.now() - started;
      return result;
    };
    if (input.withAi === false) return finish();
    if (!retrieval.candidates.length) return finish();
    if (!this.cli) {
      result.warnings.push("本机 CLI 未接入，资料挑选已降级为算法排序");
      return finish();
    }
    try {
      const curated = await this.curate(input, retrieval.candidates);
      result.resources = curated.resources;
      result.curatorNote = curated.curatorNote;
      result.replyEngine = "cli";
      result.model = curated.model;
      result.curated = true;
      result.warnings.push(...curated.warnings);
    } catch (error) {
      // 与 CRM 失败同一条纪律：复排坏了只是「挑得没那么准」，不是「没有资料」。
      result.warnings.push(`资料挑选（CLI）失败，已降级为算法排序：${detailOf(error)}`);
    }
    return finish();
  }

  /**
   * 唯一的取数口，**永不抛错**：按对话推荐（四路打分）或按关键词列目录。
   * 失败时返回空候选 + 一句可显示的原因，而不是把异常抛给调用方。
   */
  private async collect(ownerUserId: string, input: ResourceSearchInput): Promise<{ retrieval: Retrieval; warnings: string[] }> {
    const empty: Retrieval = { candidates: [], retrieval: null, customer: { matched: false, id: "", company: "" } };
    const warnings: string[] = [];
    if (!this.hub) {
      warnings.push("资料推荐未取到：插件未接入 CRM 资源中心");
      return { retrieval: empty, warnings };
    }
    const reason = this.hub.unavailableReason();
    if (reason) {
      warnings.push(`资料推荐未取到：${reason}`);
      return { retrieval: empty, warnings };
    }
    try {
      const retrieval = await this.retrieve(ownerUserId, input);
      warnings.push(...(retrieval.warnings ?? []));
      return { retrieval, warnings };
    } catch (error) {
      warnings.push(`资料推荐未取到：${detailOf(error)}`);
      return { retrieval: empty, warnings };
    }
  }

  /** 实际发请求的地方。失败**向上抛**，由 `collect` 统一收口成 warnings。 */
  private async retrieve(ownerUserId: string, input: ResourceSearchInput): Promise<Retrieval & { warnings?: string[] }> {
    const conversation = toCrmConversation(input.messages ?? []);
    if (conversation.length) {
      const response = await this.hub!.recommend(ownerUserId, {
        conversation,
        customerId: input.customerId,
        conversationKey: input.conversationKey,
        limit: input.limit ?? DEFAULT_LIMIT,
        sourceTypes: input.sourceTypes,
        signal: input.signal ?? "manual"
      });
      return {
        candidates: response.recommendations ?? [],
        retrieval: response.retrieval ?? null,
        customer: response.customer ?? { matched: false, id: "", company: "" },
        warnings: response.warnings ?? []
      };
    }
    const listed = await this.hub!.list(ownerUserId, { q: input.q, limit: input.limit ?? 20 });
    return { candidates: listed.resources ?? [], retrieval: null, customer: { matched: false, id: "", company: "" } };
  }

  /**
   * 取真实地址（或内联正文）。**整个系统里唯一一次把外链交出去的地方。**
   *
   * 扩展不能自己连 CRM（它没有 `CRM_JWT_SECRET`，也不该有），所以必须由插件代取。
   * 这里**故意不吞错**：面板要区分「暂时取不到，重试一下」与「这份资料没有外链」，
   * 所以返回 `{ ok: false, reason }` 而不是抛异常，也不需要调用方去 catch。
   */
  async reveal(
    ownerUserId: string,
    sourceType: ResourceSourceType,
    id: string,
    body: { reason?: string; conversationKey?: string } = {}
  ): Promise<{ ok: true; resource: CrmRevealResponse["resource"]; access: CrmRevealResponse["access"]; accessId: string } | { ok: false; reason: string }> {
    if (!this.hub) return { ok: false, reason: "插件未接入 CRM 资源中心" };
    const reason = this.hub.unavailableReason();
    if (reason) return { ok: false, reason };
    try {
      const revealed = await this.hub.reveal(ownerUserId, sourceType, id, body);
      return { ok: true, resource: revealed.resource, access: revealed.access, accessId: revealed.accessId };
    } catch (error) {
      return { ok: false, reason: detailOf(error) };
    }
  }

  /**
   * 采纳/忽略埋点。**永不抛错、也永不阻塞界面**：埋点丢一次不影响任何功能，
   * 但让它把「复制链接」这个动作卡住就本末倒置了。
   */
  async feedback(ownerUserId: string, items: ResourceFeedbackItem[], conversationKey = ""): Promise<void> {
    if (!this.hub || !items.length) return;
    if (this.hub.unavailableReason()) return;
    try {
      await this.hub.feedback(ownerUserId, items, conversationKey);
    } catch {
      // 故意吞掉：埋点是旁路。
    }
  }

  /**
   * CLI 复排。**唯一能改动 `resources` 的地方**，且只允许在候选集合内部重排/裁剪：
   * 模型给出的 id 不在候选里一律丢弃 —— 这是防「臆造一份根本不存在的资料」的闸门。
   */
  private async curate(
    input: ResourceSuggestInput,
    candidates: CrmResourceCandidate[]
  ): Promise<{ resources: SuggestedResource[]; curatorNote: string; model: string; warnings: string[] }> {
    const shortlist = candidates.slice(0, MAX_CANDIDATES_IN_PROMPT);
    const limit = Math.max(1, Math.min(shortlist.length, input.limit ?? DEFAULT_LIMIT));
    const prompt = buildResourceCuratePrompt(input.messages ?? [], shortlist, limit);
    const run = await this.cli!.run({
      prompt,
      model: sanitizeCliModel(input.model),
      effort: sanitizeCliEffort(input.effort),
      // 单次生成：给 2 轮余量（有的模型会先输出一句话再给 JSON）。
      maxTurns: 2,
      timeoutMs: CURATE_TIMEOUT_MS
    });
    const parsed = curateSchema.parse(JSON.parse(extractJsonObject(run.text)));
    const warnings: string[] = [];
    const byKey = new Map(shortlist.map((candidate) => [resourceKey(candidate), candidate]));
    const byId = new Map(shortlist.map((candidate) => [candidate.id, candidate]));

    const picked: SuggestedResource[] = [];
    const seen = new Set<string>();
    let invented = 0;
    let stripped = 0;
    for (const pick of parsed.picks) {
      const hit = byKey.get(pick.id) ?? byId.get(pick.id);
      if (!hit) {
        invented += 1;
        continue;
      }
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      const safe = sanitizeSuggestedLine(pick.suggestedLine);
      if (safe.dropped) stripped += 1;
      picked.push({ ...toSuggested(hit), why: pick.why, suggestedLine: safe.line });
      if (picked.length >= limit) break;
    }
    if (invented) warnings.push(`已丢弃 ${invented} 条不在候选清单里的资料（模型可能臆造）`);
    if (stripped) warnings.push(`${stripped} 条建议话术含金额字样已清空（防把历史报价当成新承诺发出去）`);

    return {
      resources: picked,
      curatorNote: parsed.reply,
      model: run.model || sanitizeCliModel(input.model) || CLI_MODEL_DEFAULT,
      warnings
    };
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
