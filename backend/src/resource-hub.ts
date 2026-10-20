import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { canSeeOwner, isPlatformIdentity } from "./auth.js";
import { listAgentKnowledgeDocuments } from "./agent-knowledge.js";
import type { CrmStore } from "./store.js";
import type { SessionUser } from "./types.js";

// ---------------------------------------------------------------------------
// 资源中心（Resource Hub）：把 CRM 里四套「提前维护好的资料」收敛成一条可检索
// 的资源流，供 WhatsApp 插件在聊天过程中按对话内容主动推荐。
//
//   文件中心 knowledge_assets  /  Skill 资源 skill_resources
//   智能体知识 agent_knowledge_documents + 系统知识目录  /  产品库 products
//
// 设计约束（与 docs/RESOURCE-HUB-DESIGN.md 对齐）：
//  1. 检索核心全是纯函数（只吃一个资源数组），不依赖数据库即可单测。
//  2. 真实外链只有 revealHubResource 一个出口；HubResource 结构里根本不带 URL。
//  3. 两张新表（resource_embeddings / resource_retrieval_events）走独立仓库，
//     **不进 persistAll 全表重写体系**（LONGBLOB 塞进去会让每次 persistence 多搬几十 MB）。
// ---------------------------------------------------------------------------

export const RESOURCE_SOURCE_TYPES = ["file", "skill", "knowledge", "product"] as const;
export type ResourceSourceType = (typeof RESOURCE_SOURCE_TYPES)[number];

export const RESOURCE_EVENT_TYPES = ["exposed", "revealed", "accepted", "dismissed", "sent"] as const;
export type ResourceEventType = (typeof RESOURCE_EVENT_TYPES)[number];

/** 审计埋点保留期（天）。超期由 pruneResourceEvents 清理。 */
export const RESOURCE_RETENTION_DAYS = 90;

/**
 * 埋点清理的截止时刻：早于它的算过期。抽成纯函数（两个仓库共用）是为了让
 * 「保留期窗口」这件事可单测 —— 尤其是 `Math.max(1, …)` 的下限：
 * 配 0 或负数时不能把全表清光。
 */
export function resourceEventPruneCutoff(retentionDays = RESOURCE_RETENTION_DAYS, now = Date.now()): Date {
  return new Date(now - Math.max(1, retentionDays) * 86_400_000);
}
/** 单源单次最多扫多少行。超出的部分靠「最近更新优先」覆盖，这是有意识的取舍。 */
export const MAX_SCAN_PER_SOURCE = 400;
/** 向量只对词法预筛后的这些候选做精排，避免全表加载向量。 */
export const MAX_VECTOR_CANDIDATES = 200;
/** 检索内部预算；超时返回已完成的部分 + warnings，绝不 500。 */
export const RESOURCE_SEARCH_BUDGET_MS = 2_000;
/** 向量模型标识。批 2 的补齐任务与检索两侧必须用同一个值，否则查不到向量。 */
export const RESOURCE_HUB_EMBEDDING_MODEL = "goodjob-resource-hub-v1";
/** 排序权重（四路和为 1）。 */
export const RESOURCE_SCORE_WEIGHTS = { lexical: 0.52, structured: 0.2, semantic: 0.16, vector: 0.12 } as const;

/* --------- 两池与反馈：权重而非硬上限 --------- */
/** 长尾池（未校订的 file 资料）权重。比硬上限（第 N 份之后直接消失）诚实得多。 */
export const LONG_TAIL_SCORE_WEIGHT = 0.5;
/** 该客户明确反馈「没帮助」后的权重。UI 承诺过「下次排后面」，这里兑现它。 */
export const DISMISSED_SCORE_FACTOR = 0.4;
/** 反馈回流：曝光够多却零采纳 → 降权；采纳够多 → 轻微加权（封顶 1）。 */
export const FEEDBACK_DEMOTE_MIN_REVEALED = 20;
export const FEEDBACK_DEMOTE_FACTOR = 0.5;
export const FEEDBACK_BOOST_MIN_ACCEPTED = 5;
export const FEEDBACK_BOOST_MIN_REVEALED = 5;
export const FEEDBACK_BOOST_FACTOR = 1.15;
/**
 * 词法归一化的「有效查询词数」（P3-1）。
 *
 * 旧口径的分母是**全部**查询词 idf 之和：20 词的会话里命中 1 个高权词只有 ~0.05，
 * 全体候选挤在淘汰阈值 0.01 附近。新口径只取 idf 最高的这 5 个当分母 ——
 * 短查询（≤5 词）分母不变，行为与旧版**逐位一致**，所以能安全地做 A/B 开关。
 */
export const LEXICAL_V2_TOP_TERMS = 5;

/** 领域语义展开词典：客户/业务员口语 → 资料里更常见的写法。只做「同义改写」这一类，不做联想。 */
const DOMAIN_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /spec|datasheet|规格|参数|技术资料/iu, terms: ["规格书", "specification", "datasheet", "technical"] },
  { pattern: /quot|price|报价|价格|单价/iu, terms: ["报价单", "quotation", "price", "pricelist"] },
  { pattern: /drawing|blueprint|图纸|图面/iu, terms: ["图纸", "drawing", "blueprint", "dimension"] },
  { pattern: /catalog|brochure|目录|画册/iu, terms: ["目录", "catalog", "brochure", "leaflet"] },
  { pattern: /customs|declaration|报关|清关|单证/iu, terms: ["报关", "customs", "declaration", "invoice"] },
  { pattern: /certificat|certif|认证|证书/iu, terms: ["认证", "certificate", "compliance", "rohs", "ce"] },
  { pattern: /packing|packag|包装|装箱/iu, terms: ["包装", "packing", "package", "carton"] },
  { pattern: /sample|样品|打样/iu, terms: ["样品", "sample", "prototype"] },
  { pattern: /manual|instruction|说明书|安装/iu, terms: ["说明书", "manual", "instruction", "guide"] },
  { pattern: /contract|合同|协议/iu, terms: ["合同", "contract", "agreement", "terms"] },
  { pattern: /photo|image|图片|照片/iu, terms: ["图片", "photo", "image", "picture"] },
  { pattern: /video|视频|演示/iu, terms: ["视频", "video", "demo"] },
  { pattern: /training|train|培训|教程|训练/iu, terms: ["培训", "training", "tutorial", "guide"] },
  { pattern: /deliver|leadtime|交期|货期|周期/iu, terms: ["交期", "leadtime", "delivery", "production"] },
  { pattern: /moq|起订|最小订/iu, terms: ["起订量", "moq", "minimum"] }
];

/** 字段权重：标题最重，标签其次。归一化分母取最大值（2.0），得到 0–1 的命中权重。 */
const FIELD_WEIGHTS = { title: 2, tags: 1.6, category: 1.2, summary: 1, body: 0.6 } as const;
const MAX_FIELD_WEIGHT = FIELD_WEIGHTS.title;

// ---------------------------------------------------------------------------
// 统一资源结构
// ---------------------------------------------------------------------------

/**
 * 统一资源。**刻意不带 sourceUrl / downloadUrl** —— 真实外链只能通过
 * `revealHubResource` 取，目录与推荐两个接口在类型层面就没法泄漏。
 */
export interface HubResource {
  id: string;
  sourceType: ResourceSourceType;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  /** pdf / word / excel / image / video / archive / link / other / inline */
  fileType: string;
  version: string;
  author: string;
  updatedAt: string;
  accessCount: number;
  hasExternalLink: boolean;
  ownerId: string;
  teamId: string;
  /** 内部检索用；绝不进响应（序列化函数会剔掉） */
  searchText: string;
  /** 知识文档的正文，reveal 时内联返回；其余源为空 */
  inlineContent: string;
  /**
   * 人工校订标记（只有 file 源有意义）。两池分层依据：
   * verified=true → 核心池 ×1.0；false/缺省 → 长尾池 ×0.5。
   * 非 file 源恒为 true（skill / knowledge / product 由各自维护界面把关）。
   */
  verified?: boolean;
}

export type ResourceReasonKind = "lexical" | "structured" | "semantic" | "vector";

export interface ResourceReason {
  kind: ResourceReasonKind;
  /** 给业务员看的依据行；必须能追到真实发生过的匹配 */
  text: string;
}

export interface ResourceMatch {
  lexical: number;
  structured: number;
  semantic: number;
  vector: number;
}

/** 对外（响应里）的资源形态：剔掉 searchText / inlineContent。 */
export type PublicHubResource = Omit<HubResource, "searchText" | "inlineContent">;

export interface RecommendedResource extends PublicHubResource {
  score: number;
  /** 两池归属：core=已校订/非 file 源；longtail=未校订的 file 资料（已打折）。 */
  pool: "core" | "longtail";
  headline: string;
  match: ResourceMatch;
  reasons: ResourceReason[];
  /** 命中的关键词，供界面渲染成 chip；空数组表示只靠结构化分项上榜 */
  hitTerms: string[];
}

export interface CollectFilter {
  /** 只看某几类源；缺省全开 */
  sourceTypes?: ResourceSourceType[];
  category?: string;
  fileType?: string;
}

// ---------------------------------------------------------------------------
// 分词：与 agent-knowledge.ts 的 knowledgeTerms 同口径（NFKC + 小写 + 中文相邻 bigram + 拉丁词）
// ---------------------------------------------------------------------------

export function resourceTerms(value: string): Set<string> {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9][a-z0-9_.-]+|[\p{Script=Han}]{2,}/gu) || []);
  for (const group of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < group.length - 1; index += 1) terms.add(group.slice(index, index + 2));
  }
  return terms;
}

/**
 * 把查询拆成「原词」与「词典扩展词」两组。
 * 原词命中的部分算词法分，扩展词命中的部分算语义分 —— 这样「语义」这一分项
 * 有明确可解释的来源，而不是一个说不清的相似度数字。
 */
export function expandQueryTerms(raw: string): { original: Set<string>; expanded: Set<string>; notes: string[] } {
  const text = String(raw || "").normalize("NFKC").toLowerCase();
  const original = resourceTerms(text);
  const expanded = new Set<string>();
  const notes: string[] = [];
  for (const rule of DOMAIN_EXPANSIONS) {
    if (!rule.pattern.test(text)) continue;
    const added: string[] = [];
    for (const term of rule.terms) {
      for (const token of resourceTerms(term)) {
        if (original.has(token)) continue;
        expanded.add(token);
        added.push(term);
      }
    }
    if (added.length) notes.push(...new Set(added));
  }
  return { original, expanded, notes: [...new Set(notes)] };
}

/** 每次资源内容变化都会改变，用作 embedding 缓存键。 */
export function resourceContentHash(resource: HubResource): string {
  return createHash("sha256").update(`${resource.sourceType}|${resource.id}|${resource.searchText}`).digest("hex");
}

export function toPublicResource(resource: HubResource): PublicHubResource {
  const { searchText, inlineContent, ...rest } = resource;
  void searchText;
  void inlineContent;
  return rest;
}

// ---------------------------------------------------------------------------
// 采集：三层过滤（团队隔离 → 状态 → 能力码），四源合并
// ---------------------------------------------------------------------------

function sortByUpdatedDesc<T extends { updatedAt?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function textOf(...parts: Array<string | string[] | undefined>): string {
  return parts
    .map((part) => (Array.isArray(part) ? part.join(" ") : String(part || "")))
    .filter(Boolean)
    .join("\n");
}

/**
 * 知识资产的有效团队。
 *
 * `team_id` 的 schema 默认值是 `'all'`（mysql-store.ts ensureColumn 的历史兜底），
 * 而可见性判定要求 `teamId === actor.teamId` 且平台身份被 `isPlatformIdentity` 排除
 * —— 于是默认值反而让资料**双处不可见**（文件中心 + 推荐）。
 * 这里把 `'all'` / 空值一律视为「未归属」，回落到 owner 的团队；
 * owner 也查不到时才保留 `'all'`（真孤儿，由迁移里的
 * `repairKnowledgeAssetTeamOwnership` 修复并记入孤儿清单）。
 */
export function knowledgeAssetTeamId(
  store: CrmStore,
  asset: { ownerId: string; teamId?: string }
): string {
  const own = String(asset.teamId || "").trim();
  if (own && own !== "all") return own;
  const owner = store.users.find((item) => item.id === asset.ownerId);
  return owner?.teamId || "all";
}

/** 文件中心：只出 published；团队隔离 + 对象归属。 */
function collectKnowledgeAssets(store: CrmStore, actor: SessionUser): HubResource[] {
  return store.knowledgeAssets
    .filter((asset) => asset.status === "published")
    .filter((asset) => {
      const teamId = knowledgeAssetTeamId(store, asset);
      if (teamId !== actor.teamId || isPlatformIdentity(actor)) return false;
      return true;
    })
    .map((asset) => {
      const owner = store.users.find((item) => item.id === asset.ownerId);
      return {
        id: asset.id,
        sourceType: "file" as const,
        title: asset.title,
        category: asset.category || "",
        summary: asset.description || "",
        tags: Array.isArray(asset.tags) ? asset.tags : [],
        fileType: asset.fileType || "other",
        version: asset.version || "",
        author: owner?.name || "",
        updatedAt: asset.updatedAt || asset.createdAt || "",
        accessCount: Number(asset.accessCount || 0),
        hasExternalLink: Boolean(asset.sourceUrl) && asset.sourceType !== "legacy",
        ownerId: asset.ownerId,
        teamId: knowledgeAssetTeamId(store, asset),
        searchText: textOf(asset.title, asset.category, asset.description, asset.tags, asset.fileType),
        inlineContent: "",
        verified: asset.verified === true
      };
    });
}

/** Skill 资源：只出 published；仅本团队。 */
function collectSkillResources(store: CrmStore, actor: SessionUser): HubResource[] {
  return store.skillResources
    .filter((resource) => resource.status === "published" && resource.teamId === actor.teamId)
    .map((resource) => ({
      id: resource.id,
      sourceType: "skill" as const,
      title: resource.name,
      category: resource.category || "",
      summary: resource.summary || "",
      tags: Array.isArray(resource.tags) ? resource.tags : [],
      fileType: "skill",
      version: resource.version || "",
      author: resource.author || "",
      updatedAt: resource.updatedAt || resource.createdAt || "",
      accessCount: Number(resource.accessCount || 0),
      hasExternalLink: Boolean(resource.downloadUrl),
      ownerId: resource.ownerId,
      teamId: resource.teamId,
      searchText: textOf(
        resource.name,
        resource.category,
        resource.summary,
        resource.tags,
        resource.usageGuide,
        resource.trainingGuide,
        resource.acquisitionInstructions
      ),
      inlineContent: textOf(resource.usageGuide, resource.trainingGuide)
    }));
}

/**
 * 智能体知识：**直接复用 agent-knowledge 的既有可见性**（`listAgentKnowledgeDocuments`），
 * 不自己重写过滤条件 —— 自己写一份，早晚会比既有界面多漏或少漏。
 * 只取 published。
 */
function collectKnowledgeDocuments(store: CrmStore, actor: SessionUser): HubResource[] {
  const visible = listAgentKnowledgeDocuments(store, actor, { status: "published" });
  return visible.map((document) => ({
    id: document.id,
    sourceType: "knowledge" as const,
    title: document.title,
    category: document.module || document.kind,
    summary: document.summary || "",
    tags: Array.isArray(document.keywords) ? document.keywords : [],
    fileType: "inline",
    version: document.version || "",
    author: document.publishedBy || "",
    updatedAt: document.updatedAt || document.publishedAt || "",
    accessCount: Number(document.usageCount || 0),
    hasExternalLink: false,
    ownerId: document.ownerId,
    teamId: document.teamId,
    searchText: textOf(
      document.title,
      document.module,
      document.kind,
      document.summary,
      document.content,
      document.keywords,
      document.successCriteria,
      document.failureCases
    ),
    inlineContent: document.content || ""
  }));
}

/** 产品：与 `GET /api/tools/products` **同一套可见性**（canSeeOwner），不另立标准。 */
function collectProducts(store: CrmStore, actor: SessionUser): HubResource[] {
  return store.products
    .filter((product) => canSeeOwner(actor, product.ownerId, product.teamId))
    .map((product) => ({
      id: product.id,
      sourceType: "product" as const,
      title: product.nameEn || product.nameZh || product.model || "未命名产品",
      category: product.category || "",
      summary: product.descriptionEn || product.descriptionZh || "",
      tags: Array.isArray(product.tags) ? product.tags : [],
      fileType: "product",
      version: product.model || "",
      author: "",
      updatedAt: product.updatedAt || "",
      accessCount: 0,
      hasExternalLink: false,
      ownerId: product.ownerId,
      teamId: product.teamId,
      searchText: textOf(
        product.nameZh,
        product.nameEn,
        product.model,
        product.category,
        product.descriptionZh,
        product.descriptionEn,
        product.tags,
        product.hsCode
      ),
      inlineContent: textOf(product.descriptionZh, product.descriptionEn)
    }));
}

/**
 * 可达性闸：推荐位只给「点了能拿到东西」的资料。
 * 规则与 reveal 的交付能力逐条对齐（reveal 给不出东西的资料不该占推荐位）：
 *  - file：有外链且不是 legacy（否则 reveal 必返 no_link 409，用户点下去就是一句报错）
 *  - skill：有 downloadUrl（同上）
 *  - knowledge：有内联正文（知识条目靠正文交付，空正文等于没内容）
 *  - product：恒过（产品卡本身就是可推荐内容；无描述时面板提示「暂无详情」，不算断链）
 *
 * ⚠️ reveal 路径**不过滤** —— 「没链接」要返回 409 让用户知道原因，
 * 而不是从推荐里悄悄消失、连「为什么推了却打不开」都看不出来。
 */
export function resourceReachable(resource: HubResource): boolean {
  if (resource.sourceType === "file" || resource.sourceType === "skill") return resource.hasExternalLink;
  if (resource.sourceType === "knowledge") return Boolean(String(resource.inlineContent || "").trim());
  return true;
}

/** 采集当前账号可见的全部资源（四源合并，按源各截断 MAX_SCAN_PER_SOURCE）。 */
export function collectHubResources(store: CrmStore, actor: SessionUser, filter: CollectFilter = {}): HubResource[] {
  return collectHubResourcesDetailed(store, actor, filter).resources;
}

export interface HubCollection {
  resources: HubResource[];
  /** 各源「可见但超出 MAX_SCAN_PER_SOURCE 未进候选」的条数（键只在 >0 时出现）。 */
  truncated: Partial<Record<ResourceSourceType, number>>;
}

/**
 * 带截断元信息的采集。截断计数按「排序后、类目过滤前」算 ——
 * 那才是「因更新过早被挤出候选集」的真实条数（类目过滤是用户主动收窄，不算截断）。
 */
export function collectHubResourcesDetailed(store: CrmStore, actor: SessionUser, filter: CollectFilter = {}): HubCollection {
  const wanted = new Set<ResourceSourceType>(
    filter.sourceTypes?.length ? filter.sourceTypes : [...RESOURCE_SOURCE_TYPES]
  );
  const rows: HubResource[] = [];
  const truncated: Partial<Record<ResourceSourceType, number>> = {};
  const take = (sourceType: ResourceSourceType, visible: HubResource[]) => {
    const sorted = sortByUpdatedDesc(visible);
    rows.push(...sorted.slice(0, MAX_SCAN_PER_SOURCE));
    const dropped = Math.max(0, sorted.length - MAX_SCAN_PER_SOURCE);
    if (dropped > 0) truncated[sourceType] = dropped;
  };
  if (wanted.has("file")) take("file", collectKnowledgeAssets(store, actor));
  if (wanted.has("skill")) take("skill", collectSkillResources(store, actor));
  if (wanted.has("knowledge")) take("knowledge", collectKnowledgeDocuments(store, actor));
  if (wanted.has("product")) take("product", collectProducts(store, actor));

  const category = String(filter.category || "").trim().toLowerCase();
  const fileType = String(filter.fileType || "").trim().toLowerCase();
  const resources = rows.filter((row) => {
    if (category && row.category.toLowerCase() !== category) return false;
    if (fileType && row.sourceType === "file" && row.fileType.toLowerCase() !== fileType) return false;
    return true;
  });
  return { resources, truncated };
}

// ---------------------------------------------------------------------------
// 排序：词法 + 结构化 + 语义 + 向量
// ---------------------------------------------------------------------------

export interface ScoreOptions {
  query: string;
  limit: number;
  /** 本团队「已发给客户」计数，键 `${sourceType}:${id}` */
  sentCounts?: Map<string, number>;
  /** 该客户此前收到过的资源，键 `${sourceType}:${id}` */
  customerResourceKeys?: Set<string>;
  /** 该客户明确标过「没帮助」的资源 —— 降权。与上面那个「接触过」是两回事。 */
  dismissedKeys?: Set<string>;
  /**
   * 近 30 天反馈摘要（键 `${sourceType}:${id}`）。用于「曝光多、零采纳」自动降权。
   * 由调用方从 eventStats 缓存取；读不到就不传，检索照常。
   */
  feedback?: Map<string, { revealed: number; accepted: number; dismissed: number }>;
  /** 质检开关：开启后词法分按「命中的查询词 idf 之和」归一，长会话不再被稀释（P3-1）。 */
  lexicalV2?: boolean;
  /**
   * 该客户历史报价单里出现过的产品词。
   * 用真实往来数据做结构化加分（而不是猜"这个客户大概属于哪个行业"）：
   * 报过 LED 工程灯 → 推 LED 规格书。数据来源 `store.quoteHistory`。
   */
  customerProductTerms?: Set<string>;
  /** 已加载的向量，键 `${sourceType}:${id}` */
  vectors?: Map<string, Float32Array>;
  /** 查询向量；与 vectors 同时存在才启用向量分项 */
  queryVector?: Float32Array | null;
}

interface FieldTerms {
  title: Set<string>;
  tags: Set<string>;
  category: Set<string>;
  summary: Set<string>;
  body: Set<string>;
}

function splitFieldTerms(resource: HubResource): FieldTerms {
  return {
    title: resourceTerms(resource.title),
    tags: resourceTerms(resource.tags.join(" ")),
    category: resourceTerms(resource.category),
    summary: resourceTerms(resource.summary),
    body: resourceTerms(resource.inlineContent)
  };
}

/** 词在文档里的命中权重：取它出现过的字段里最重的那一档。 */
function hitWeight(fields: FieldTerms, term: string): number {
  if (fields.title.has(term)) return FIELD_WEIGHTS.title;
  if (fields.tags.has(term)) return FIELD_WEIGHTS.tags;
  if (fields.category.has(term)) return FIELD_WEIGHTS.category;
  if (fields.summary.has(term)) return FIELD_WEIGHTS.summary;
  if (fields.body.has(term)) return FIELD_WEIGHTS.body;
  return 0;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function resourceKey(sourceType: ResourceSourceType, id: string): string {
  return `${sourceType}:${id}`;
}

/**
 * 四路打分并排序。**纯函数**：同样的输入必然得到同样的输出顺序
 * （同分按 accessCount → updatedAt → id 三级兜底），否则前端卡片会「跳来跳去」。
 */
export function scoreHubResources(resources: HubResource[], options: ScoreOptions): RecommendedResource[] {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 6));
  const { original, expanded } = expandQueryTerms(options.query);
  const hasQuery = original.size > 0;
  const fields = new Map(resources.map((resource) => [resourceKey(resource.sourceType, resource.id), splitFieldTerms(resource)]));

  // idf：资料没变就不该重算；这里按候选集即时算，命中缓存的场景由调用方负责（见 resourceQueryCache）。
  const documentFrequency = new Map<string, number>();
  const allQueryTerms = new Set([...original, ...expanded]);
  for (const terms of fields.values()) {
    const union = new Set([...terms.title, ...terms.tags, ...terms.category, ...terms.summary, ...terms.body]);
    for (const term of allQueryTerms) if (union.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  const idf = (term: string) => Math.log((resources.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1;
  const originalIdfSum = [...original].reduce((sum, term) => sum + idf(term), 0);
  const expandedIdfSum = [...expanded].reduce((sum, term) => sum + idf(term), 0);
  /**
   * P3-1：词法归一化分母。旧版=全部查询词 idf 之和；新版=idf 最高的 LEXICAL_V2_TOP_TERMS 个。
   * 短查询两者相等，所以开关不会把已调好的短句排序搅乱。
   */
  const lexicalDenominator = options.lexicalV2
    ? [...original]
      .map((term) => idf(term))
      .sort((left, right) => right - left)
      .slice(0, LEXICAL_V2_TOP_TERMS)
      .reduce((sum, value) => sum + value, 0)
    : originalIdfSum;

  const scored = resources.map((resource) => {
    const key = resourceKey(resource.sourceType, resource.id);
    const fieldTerms = fields.get(key) as FieldTerms;

    let lexicalRaw = 0;
    const lexicalHits: string[] = [];
    for (const term of original) {
      const weight = hitWeight(fieldTerms, term);
      if (!weight) continue;
      lexicalRaw += (weight / MAX_FIELD_WEIGHT) * idf(term);
      lexicalHits.push(term);
    }
    let semanticRaw = 0;
    const semanticHits: string[] = [];
    for (const term of expanded) {
      const weight = hitWeight(fieldTerms, term);
      if (!weight) continue;
      semanticRaw += (weight / MAX_FIELD_WEIGHT) * idf(term);
      semanticHits.push(term);
    }

    const lexical = lexicalDenominator > 0 ? Math.max(0, Math.min(1, lexicalRaw / lexicalDenominator)) : 0;
    const semantic = expandedIdfSum > 0 ? Math.max(0, Math.min(1, semanticRaw / expandedIdfSum)) : 0;

    const reasons: ResourceReason[] = [];
    const structuredParts: number[] = [];

    const inCustomerHistory = Boolean(options.customerResourceKeys?.has(key));
    if (inCustomerHistory) {
      structuredParts.push(0.5);
      // 措辞对齐事实：customerResourceKeys 收的是 sent + revealed，是「接触过/看过」，
      // 不是「收到过」。说成「收到过」会让业务员以为已经发过，实际只是自己点开看过（G8）。
      reasons.push({ kind: "structured", text: "该客户此前查看过同类资料" });
    }
    if (options.customerProductTerms?.size) {
      // 只拿标题与标签去比（摘要/正文里偶然出现同一个词不算「该客户要的东西」）
      const titleAndTags = new Set([...fieldTerms.title, ...fieldTerms.tags]);
      const overlap: string[] = [];
      for (const term of options.customerProductTerms) if (titleAndTags.has(term)) overlap.push(term);
      if (overlap.length) {
        // 命中 1 个词给 0.18，3 个及以上封顶 0.3：防止长公司名/长型号把这一项刷满
        structuredParts.push(Math.min(0.3, 0.18 + (overlap.length - 1) * 0.06));
        reasons.push({
          kind: "structured",
          text: `该客户历史报价里出现过 ${overlap.slice(0, 3).map((term) => `「${term}」`).join("、")}`
        });
      }
    }
    const sentCount = Number(options.sentCounts?.get(key) || 0);
    if (sentCount > 0) {
      const prior = Math.min(0.25, (Math.log1p(sentCount) / Math.log1p(20)) * 0.25);
      structuredParts.push(prior);
      reasons.push({ kind: "structured", text: `本团队已发出过 ${sentCount} 次` });
    }
    const structured = Math.max(0, Math.min(1, structuredParts.reduce((sum, value) => sum + value, 0)));

    const vectorA = options.vectors?.get(key);
    const vector = vectorA && options.queryVector ? Number(cosine(vectorA, options.queryVector).toFixed(4)) : 0;

    if (lexical > 0) {
      const shown = lexicalHits.slice(0, 3).map((term) => `「${term}」`).join("、");
      reasons.push({ kind: "lexical", text: `标题/标签/摘要命中 ${shown}` });
    }
    if (semantic > 0) {
      const shown = semanticHits.slice(0, 3).map((term) => `「${term}」`).join("、");
      reasons.push({ kind: "semantic", text: `按业务词典等价命中 ${shown}` });
    }
    if (vector > 0.35) reasons.push({ kind: "vector", text: `语义相近（${vector.toFixed(2)}）` });

    let score =
      RESOURCE_SCORE_WEIGHTS.lexical * lexical +
      RESOURCE_SCORE_WEIGHTS.structured * structured +
      RESOURCE_SCORE_WEIGHTS.semantic * semantic +
      RESOURCE_SCORE_WEIGHTS.vector * vector;

    /* ---------- 两池分层：长尾池的未校订 file 资料打折，而不是被隐藏 ---------- */
    const pool: "core" | "longtail" =
      resource.sourceType === "file" && resource.verified !== true ? "longtail" : "core";
    if (pool === "longtail") score *= LONG_TAIL_SCORE_WEIGHT;

    /* ---------- 明确被客户否掉的，排后面（兑现扩展上「下次会排后面」的承诺） ---------- */
    const dismissed = Boolean(options.dismissedKeys?.has(key));
    if (dismissed) {
      score *= DISMISSED_SCORE_FACTOR;
      reasons.push({ kind: "structured", text: "该客户反馈过这类资料「没帮助」" });
    }

    /* ---------- 反馈回流：曝光多零采纳的自然沉下去，采纳多的浮上来 ---------- */
    const feedback = options.feedback?.get(key);
    if (feedback) {
      if (feedback.revealed >= FEEDBACK_DEMOTE_MIN_REVEALED && feedback.accepted === 0) {
        score *= FEEDBACK_DEMOTE_FACTOR;
        reasons.push({ kind: "structured", text: `看过 ${feedback.revealed} 次都没被采用，已降权` });
      } else if (feedback.accepted >= FEEDBACK_BOOST_MIN_ACCEPTED && feedback.revealed >= FEEDBACK_BOOST_MIN_REVEALED) {
        score = Math.min(1, score * FEEDBACK_BOOST_FACTOR);
      }
    }

    const hitTerms = [...new Set([...lexicalHits, ...semanticHits])].slice(0, 6);
    const headlineParts: string[] = [];
    if (hitTerms.length) headlineParts.push(`${hitTerms.slice(0, 3).map((term) => `「${term}」`).join("、")}都在这份资料里`);
    if (inCustomerHistory) headlineParts.push("该客户此前查看过同类资料");
    else if (structuredParts.length && !hitTerms.length) headlineParts.push("本团队常用资料");

    return {
      ...toPublicResource(resource),
      score: Number(score.toFixed(4)),
      pool,
      headline: headlineParts.join("，"),
      match: {
        lexical: Number(lexical.toFixed(4)),
        structured: Number(structured.toFixed(4)),
        semantic: Number(semantic.toFixed(4)),
        vector
      },
      reasons,
      hitTerms
    };
  });

  const kept = hasQuery ? scored.filter((row) => row.score > 0.01) : scored;
  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
    const updated = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    if (updated !== 0) return updated;
    return String(a.id).localeCompare(String(b.id));
  });
  return kept.slice(0, limit);
}

// ---------------------------------------------------------------------------
// reveal：真实外链的唯一出口
// ---------------------------------------------------------------------------

export type RevealFailure = "not_found" | "no_link";

export type RevealAccess =
  | { kind: "external"; url: string; shareCode: string }
  | { kind: "inline"; content: string };

export interface RevealResult {
  resource: { id: string; sourceType: ResourceSourceType; title: string; fileType: string };
  access: RevealAccess;
}

/**
 * 取真实地址并记一次访问。
 * 「不存在」与「无权」刻意都返回 `not_found` —— 不给出可探测的差异。
 * 调用方负责 `await store.persist()`。
 */
export function revealHubResource(
  store: CrmStore,
  actor: SessionUser,
  sourceType: ResourceSourceType,
  id: string
): { ok: true; result: RevealResult } | { ok: false; reason: RevealFailure } {
  const found = collectHubResources(store, actor, { sourceTypes: [sourceType] }).find((row) => row.id === id);
  if (!found) return { ok: false, reason: "not_found" };

  if (sourceType === "file") {
    const asset = store.knowledgeAssets.find((item) => item.id === id);
    if (!asset || !asset.sourceUrl || asset.sourceType === "legacy") return { ok: false, reason: "no_link" };
    asset.accessCount = Number(asset.accessCount || 0) + 1;
    asset.lastAccessedAt = new Date().toISOString();
    return {
      ok: true,
      result: {
        resource: { id, sourceType, title: found.title, fileType: found.fileType },
        access: {
          kind: "external",
          url: asset.sourceUrl,
          shareCode: asset.sourceType === "baidu_share" ? asset.shareCode || "" : ""
        }
      }
    };
  }

  if (sourceType === "skill") {
    const resource = store.skillResources.find((item) => item.id === id && item.teamId === actor.teamId);
    if (!resource || !resource.downloadUrl) return { ok: false, reason: "no_link" };
    resource.accessCount = Number(resource.accessCount || 0) + 1;
    resource.lastAccessedAt = new Date().toISOString();
    return {
      ok: true,
      result: {
        resource: { id, sourceType, title: found.title, fileType: found.fileType },
        access: { kind: "external", url: resource.downloadUrl, shareCode: resource.extractionCode || "" }
      }
    };
  }

  // knowledge / product 没有外链：直接把正文交出去，同样记一次访问。
  if (sourceType === "knowledge") {
    // ⚠️ 系统知识文档来自 agent-knowledge/ 磁盘目录，**不在 store.agentKnowledgeDocuments 里**。
    // 只有托管文档才有 usageCount 可加；找不到托管记录不代表这份资源不存在。
    const document = store.agentKnowledgeDocuments.find((item) => item.id === id);
    if (document) {
      document.usageCount = Number(document.usageCount || 0) + 1;
      document.lastUsedAt = new Date().toISOString();
    }
  }
  return {
    ok: true,
    result: {
      resource: { id, sourceType, title: found.title, fileType: found.fileType },
      access: { kind: "inline", content: found.inlineContent }
    }
  };
}

// ---------------------------------------------------------------------------
// 独立仓库：向量表 + 埋点表（不进 persistAll）
// ---------------------------------------------------------------------------

export interface ResourceEventInput {
  /** 可由调用方预生成（如 reveal 要把它当 accessId 返回给用户） */
  id?: string;
  ownerId: string;
  teamId: string;
  conversationKey?: string;
  resourceType: ResourceSourceType;
  resourceId: string;
  eventType: ResourceEventType;
  score?: number;
  channel?: string;
}

export interface ResourceEmbeddingInput {
  resourceType: ResourceSourceType;
  resourceId: string;
  model: string;
  contentHash: string;
  vector: Float32Array;
}

export function encodeResourceVector(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

export function decodeResourceVector(buffer: Buffer): Float32Array {
  const dim = Math.floor(buffer.byteLength / 4);
  const out = new Float32Array(dim);
  for (let index = 0; index < dim; index += 1) out[index] = buffer.readFloatLE(index * 4);
  return out;
}

export function ensureResourceHubSchema(pool: Pool) {
  const embeddings = pool.query(`CREATE TABLE IF NOT EXISTS resource_embeddings (
    resource_type VARCHAR(20) NOT NULL,
    resource_id VARCHAR(90) NOT NULL,
    model VARCHAR(120) NOT NULL,
    dim INT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    vector_blob LONGBLOB NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (resource_type, resource_id, model),
    INDEX idx_resource_embeddings_model (model, updated_at)
  )`);
  const events = pool.query(`CREATE TABLE IF NOT EXISTS resource_retrieval_events (
    id VARCHAR(64) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    conversation_key VARCHAR(120) NOT NULL DEFAULT '',
    resource_type VARCHAR(20) NOT NULL,
    resource_id VARCHAR(90) NOT NULL,
    event_type VARCHAR(20) NOT NULL,
    score DECIMAL(8,4) NOT NULL DEFAULT 0,
    channel VARCHAR(30) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    INDEX idx_resource_events_owner (owner_id, created_at),
    INDEX idx_resource_events_resource (resource_type, resource_id, event_type),
    INDEX idx_resource_events_team (team_id, event_type, created_at)
  )`);
  return Promise.all([embeddings, events]);
}

/**
 * 埋点与向量的读写口。两种实现：
 *  - `MysqlResourceHubRepository`：正式档位，落 `resource_retrieval_events` / `resource_embeddings`。
 *  - `MemoryResourceHubRepository`：内存档位（`CRM_STORE=memory` 与所有 `-test.ts`）。
 *    必须存在，否则「feedback 埋点 → 排序先验」这条闭环在测试环境里根本没有落点，无法自测。
 */
export interface ResourceHubRepository {
  sentCounts(teamId: string): Promise<Map<string, number>>;
  customerResourceKeys(teamId: string, conversationKey: string): Promise<Set<string>>;
  /**
   * 该客户在本团队会话里明确标过「没帮助」的资源。
   *
   * 单独一个集合而不是并进 customerResourceKeys —— 那一个表示「此前接触过」（可加权），
   * 这一个表示「明确被否掉」（要降权）。混在一起就会把否决当成认可（G8）。
   */
  dismissedKeys(teamId: string, conversationKey: string): Promise<Set<string>>;
  recordEvents(items: ResourceEventInput[]): Promise<number>;
  listEvents(teamId: string, limit?: number): Promise<ResourceEventRow[]>;
  /** 按资源聚合五类事件计数（`since` 之后），一次 GROUP BY 出全部口径，不逐资源循环查询。 */
  eventStats(teamId: string, since: Date): Promise<Map<string, ResourceEventStatsEntry>>;
  pruneEvents(retentionDays?: number): Promise<number>;
  saveEmbeddings(items: ResourceEmbeddingInput[]): Promise<number>;
  loadEmbeddings(model: string, resourceType: ResourceSourceType, ids: string[]): Promise<Map<string, { vector: Float32Array; contentHash: string }>>;
}

export interface ResourceEventRow {
  id: string;
  ownerId: string;
  teamId: string;
  conversationKey: string;
  resourceType: ResourceSourceType;
  resourceId: string;
  eventType: ResourceEventType;
  score: number;
  channel: string;
  createdAt: string;
}

/** 单个资源的五类事件计数（报表口径，见 docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）。 */
export type ResourceEventCounts = Record<ResourceEventType, number>;

export interface ResourceEventStatsEntry extends ResourceEventCounts {
  resourceType: ResourceSourceType;
  resourceId: string;
}

/** 空的计数骨架；保证聚合结果里五类字段永远齐全，调用方不用判 undefined。 */
export function emptyEventCounts(): ResourceEventCounts {
  return { exposed: 0, revealed: 0, accepted: 0, dismissed: 0, sent: 0 };
}

export class MysqlResourceHubRepository implements ResourceHubRepository {
  constructor(private readonly pool: Pool) {}

  /** 本团队「已发给客户」计数：`${sourceType}:${resourceId}` → 次数 */
  async sentCounts(teamId: string): Promise<Map<string, number>> {
    const [rows] = await this.pool.execute(
      `SELECT resource_type, resource_id, COUNT(*) AS hits FROM resource_retrieval_events
        WHERE team_id = ? AND event_type = 'sent' GROUP BY resource_type, resource_id`,
      [teamId]
    );
    const out = new Map<string, number>();
    for (const row of rows as Array<Record<string, unknown>>) {
      out.set(`${String(row.resource_type)}:${String(row.resource_id)}`, Number(row.hits || 0));
    }
    return out;
  }

  /** 该客户此前收到过的资源（本团队口径）。 */
  async customerResourceKeys(teamId: string, conversationKey: string): Promise<Set<string>> {
    if (!conversationKey) return new Set();
    const [rows] = await this.pool.execute(
      `SELECT DISTINCT resource_type, resource_id FROM resource_retrieval_events
        WHERE team_id = ? AND conversation_key = ? AND event_type IN ('sent', 'revealed')`,
      [teamId, conversationKey]
    );
    const out = new Set<string>();
    for (const row of rows as Array<Record<string, unknown>>) {
      out.add(`${String(row.resource_type)}:${String(row.resource_id)}`);
    }
    return out;
  }

  /** 该客户明确标过「没帮助」的资源（用于降权，别把否决当认可）。 */
  async dismissedKeys(teamId: string, conversationKey: string): Promise<Set<string>> {
    if (!conversationKey) return new Set();
    const [rows] = await this.pool.execute(
      `SELECT DISTINCT resource_type, resource_id FROM resource_retrieval_events
        WHERE team_id = ? AND conversation_key = ? AND event_type = 'dismissed'`,
      [teamId, conversationKey]
    );
    const out = new Set<string>();
    for (const row of rows as Array<Record<string, unknown>>) {
      out.add(`${String(row.resource_type)}:${String(row.resource_id)}`);
    }
    return out;
  }

  async recordEvents(items: ResourceEventInput[]): Promise<number> {
    if (!items.length) return 0;
    const now = new Date();
    let recorded = 0;
    for (const item of items) {
      await this.pool.execute(
        `INSERT INTO resource_retrieval_events
          (id, owner_id, team_id, conversation_key, resource_type, resource_id, event_type, score, channel, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id || `rre_${randomUUID().replace(/-/gu, "").slice(0, 24)}`,
          item.ownerId,
          item.teamId,
          String(item.conversationKey || "").slice(0, 120),
          item.resourceType,
          item.resourceId,
          item.eventType,
          Number(item.score || 0),
          String(item.channel || "").slice(0, 30),
          now
        ]
      );
      recorded += 1;
    }
    return recorded;
  }

  async listEvents(teamId: string, limit = 200): Promise<ResourceEventRow[]> {
    const [rows] = await this.pool.execute(
      `SELECT * FROM resource_retrieval_events WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`,
      [teamId, Math.max(1, Math.min(1000, limit))]
    );
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      teamId: String(row.team_id),
      conversationKey: String(row.conversation_key || ""),
      resourceType: String(row.resource_type) as ResourceSourceType,
      resourceId: String(row.resource_id),
      eventType: String(row.event_type) as ResourceEventType,
      score: Number(row.score || 0),
      channel: String(row.channel || ""),
      createdAt: new Date(row.created_at as string).toISOString()
    }));
  }

  /** 按资源聚合五类事件；一次 GROUP BY，行数 = 出现过的资源数。 */
  async eventStats(teamId: string, since: Date): Promise<Map<string, ResourceEventStatsEntry>> {
    const [rows] = await this.pool.execute(
      `SELECT resource_type, resource_id, event_type, COUNT(*) AS hits FROM resource_retrieval_events
        WHERE team_id = ? AND created_at >= ? GROUP BY resource_type, resource_id, event_type`,
      [teamId, since]
    );
    const out = new Map<string, ResourceEventStatsEntry>();
    for (const row of rows as Array<Record<string, unknown>>) {
      const key = `${String(row.resource_type)}:${String(row.resource_id)}`;
      const entry = out.get(key) ?? {
        resourceType: String(row.resource_type) as ResourceSourceType,
        resourceId: String(row.resource_id),
        ...emptyEventCounts()
      };
      const eventType = String(row.event_type) as ResourceEventType;
      if (eventType in entry) entry[eventType] = Number(row.hits || 0);
      out.set(key, entry);
    }
    return out;
  }

  /** 审计埋点保留期清理；由调用方按天触发。 */
  async pruneEvents(retentionDays = RESOURCE_RETENTION_DAYS): Promise<number> {
    const [result] = await this.pool.execute(
      `DELETE FROM resource_retrieval_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [Math.max(1, retentionDays)]
    );
    return Number((result as { affectedRows?: number }).affectedRows || 0);
  }

  async saveEmbeddings(items: ResourceEmbeddingInput[]): Promise<number> {
    if (!items.length) return 0;
    const now = new Date();
    for (const item of items) {
      await this.pool.execute(
        `INSERT INTO resource_embeddings
          (resource_type, resource_id, model, dim, content_hash, vector_blob, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE dim = VALUES(dim), content_hash = VALUES(content_hash),
           vector_blob = VALUES(vector_blob), updated_at = VALUES(updated_at)`,
        [
          item.resourceType,
          item.resourceId,
          item.model,
          item.vector.length,
          item.contentHash,
          encodeResourceVector(item.vector),
          now
        ]
      );
    }
    return items.length;
  }

  /**
   * 按 (类型, id) 批量取向量；**单条 IN 查询**，不循环单查。
   * 返回 `contentHash` 让调用方判断是否需要重嵌。
   */
  async loadEmbeddings(
    model: string,
    resourceType: ResourceSourceType,
    ids: string[]
  ): Promise<Map<string, { vector: Float32Array; contentHash: string }>> {
    const out = new Map<string, { vector: Float32Array; contentHash: string }>();
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return out;
    const placeholders = unique.map(() => "?").join(",");
    const [rows] = await this.pool.query(
      `SELECT resource_id, content_hash, vector_blob FROM resource_embeddings
        WHERE model = ? AND resource_type = ? AND resource_id IN (${placeholders})`,
      [model, resourceType, ...unique]
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      out.set(`${resourceType}:${String(row.resource_id)}`, {
        vector: decodeResourceVector(row.vector_blob as Buffer),
        contentHash: String(row.content_hash || "")
      });
    }
    return out;
  }
}

let resourceHubRepository: ResourceHubRepository | null = null;

/**
 * 内存实现。语义与 MySQL 版逐条对齐（尤其是 `sent` 计数与 `revealed` 历史），
 * 否则「内存档位行为一致」这句话就是空的。
 */
export class MemoryResourceHubRepository implements ResourceHubRepository {
  private readonly events: ResourceEventRow[] = [];
  private readonly embeddings = new Map<string, { vector: Float32Array; contentHash: string }>();

  async sentCounts(teamId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const row of this.events) {
      if (row.teamId !== teamId || row.eventType !== "sent") continue;
      const key = `${row.resourceType}:${row.resourceId}`;
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  }

  async customerResourceKeys(teamId: string, conversationKey: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (!conversationKey) return out;
    for (const row of this.events) {
      if (row.teamId !== teamId || row.conversationKey !== conversationKey) continue;
      if (row.eventType !== "sent" && row.eventType !== "revealed") continue;
      out.add(`${row.resourceType}:${row.resourceId}`);
    }
    return out;
  }

  async dismissedKeys(teamId: string, conversationKey: string): Promise<Set<string>> {
    const out = new Set<string>();
    if (!conversationKey) return out;
    for (const row of this.events) {
      if (row.teamId !== teamId || row.conversationKey !== conversationKey) continue;
      if (row.eventType !== "dismissed") continue;
      out.add(`${row.resourceType}:${row.resourceId}`);
    }
    return out;
  }

  async recordEvents(items: ResourceEventInput[]): Promise<number> {
    for (const item of items) {
      this.events.push({
        id: item.id || `rre_${randomUUID().replace(/-/gu, "").slice(0, 24)}`,
        ownerId: item.ownerId,
        teamId: item.teamId,
        conversationKey: String(item.conversationKey || "").slice(0, 120),
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        eventType: item.eventType,
        score: Number(item.score || 0),
        channel: String(item.channel || "").slice(0, 30),
        createdAt: new Date().toISOString()
      });
    }
    return items.length;
  }

  async listEvents(teamId: string, limit = 200): Promise<ResourceEventRow[]> {
    return this.events
      .filter((row) => row.teamId === teamId)
      .slice(-Math.max(1, Math.min(1000, limit)))
      .reverse();
  }

  async eventStats(teamId: string, since: Date): Promise<Map<string, ResourceEventStatsEntry>> {
    const out = new Map<string, ResourceEventStatsEntry>();
    for (const row of this.events) {
      if (row.teamId !== teamId) continue;
      if (new Date(row.createdAt).getTime() < since.getTime()) continue;
      const key = `${row.resourceType}:${row.resourceId}`;
      const entry = out.get(key) ?? { resourceType: row.resourceType, resourceId: row.resourceId, ...emptyEventCounts() };
      entry[row.eventType] += 1;
      out.set(key, entry);
    }
    return out;
  }

  async pruneEvents(retentionDays = RESOURCE_RETENTION_DAYS): Promise<number> {
    const cutoff = resourceEventPruneCutoff(retentionDays).getTime();
    const before = this.events.length;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (new Date(this.events[index].createdAt).getTime() < cutoff) this.events.splice(index, 1);
    }
    return before - this.events.length;
  }

  async saveEmbeddings(items: ResourceEmbeddingInput[]): Promise<number> {
    for (const item of items) {
      this.embeddings.set(`${item.model}|${item.resourceType}|${item.resourceId}`, {
        vector: item.vector,
        contentHash: item.contentHash
      });
    }
    return items.length;
  }

  async loadEmbeddings(model: string, resourceType: ResourceSourceType, ids: string[]) {
    const out = new Map<string, { vector: Float32Array; contentHash: string }>();
    for (const id of [...new Set(ids.filter(Boolean))]) {
      const found = this.embeddings.get(`${model}|${resourceType}|${id}`);
      if (found) out.set(`${resourceType}:${id}`, found);
    }
    return out;
  }
}

const memoryResourceHubRepository = new MemoryResourceHubRepository();

export function setResourceHubRepository(repository: ResourceHubRepository | null) {
  resourceHubRepository = repository;
}

/** MySQL 仓库未挂载时（内存档位 / 单测）回落内存实现，保证埋点闭环在任何档位都成立。 */
export function getResourceHubRepository(): ResourceHubRepository {
  return resourceHubRepository || memoryResourceHubRepository;
}

export function createMysqlResourceHubRepository(pool: Pool) {
  return new MysqlResourceHubRepository(pool);
}
