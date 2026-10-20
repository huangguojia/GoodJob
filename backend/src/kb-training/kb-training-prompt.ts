import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 知识库训练：**全部纯函数**（分段 / 提示词 / 输出校验 / 预勾选规则）
//
// 刻意与数据库、CLI、HTTP 全部解耦 —— 放在这里的东西必须能脱离环境单测。
// 理由是这一层最容易出错且最需要被证伪：模型返回的东西一律不可信，
// 校验规则写错了会**静默污染语料库**（比报错危险得多）。
// ---------------------------------------------------------------------------

export type KbKind = "qa" | "snippet" | "policy" | "forbidden";

export const KB_KINDS: KbKind[] = ["qa", "snippet", "policy", "forbidden"];

/** 每 20 段 1 次 CLI 调用 —— **禁止每条一调**（100 段约 5 次，不是 100 次）。 */
export const KB_SEGMENTS_PER_CALL = 20;

/** 单段字符上限：太碎会让模型看不到上下文，太大会超提示词预算。 */
export const KB_SEGMENT_MAX_CHARS = 1_200;

/** 单次训练最多切多少段（防一份超大文档把批次拖爆）；超了截断并记 warning。 */
export const KB_MAX_SEGMENTS = 400;

/** 低于此置信度一律不预勾选（人也别被"机器觉得还行"带着走）。 */
export const KB_MIN_CONFIDENCE = 0.5;

/** 预勾选门槛：高置信 + 文件出处 + 不涉商务承诺。 */
export const KB_PRESELECT_CONFIDENCE = 0.9;

const FINGERPRINT_LENGTH = 32;

/** 与插件侧同口径：sha256(kind + question + answer)[:32]，先折叠空白再转小写。 */
export function candidateFingerprint(kind: string, question: string, answer: string): string {
  const normalize = (value: string): string => String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
  const normalized = [kind, normalize(question), normalize(answer)].join("\u0000");
  return createHash("sha256").update(normalized).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

// ---------------------------------------------------------------------------
// 分段（结构感知）
// ---------------------------------------------------------------------------

export interface KbSourceItem {
  /** 来源标题（资料标题或用户自填），用于出处展示 */
  title: string;
  /** 正文 */
  body: string;
  /** 关联的文件中心资料 id（可空：纯粘贴正文时没有关联资料） */
  assetId?: string;
  /** 资料版本（来自 knowledge_assets.version） */
  version?: string;
  /** 来源描述（选填，用户自填）：这份资料从哪来。只用于出处展示，不进提炼提示词。 */
  note?: string;
}

export interface KbSegment {
  /** 1-based 序号。模型回引的就是它 —— 校验越界的依据。 */
  index: number;
  /** 出处标题（来自 item.title） */
  title: string;
  assetId: string;
  version: string;
  /** 来源描述（来自 item.note，可空串） */
  note: string;
  /** 段落锚点，如「§3」 */
  anchor: string;
  text: string;
  /** 该段归属的源条目下标（0-based），用于回填出处 */
  itemIndex: number;
}

/**
 * 结构感知分段：先按空行切段，再按字符预算合并，**不切断同一段落**。
 *
 * 为什么不按固定长度硬切：硬切会把一条完整口径劈成两半，
 * 模型拿到半句话只能编（这正是"分块过碎"那个坑）。
 * 段落本身过大（超过预算）时才退化到按句号切。
 */
export function segmentDocuments(items: KbSourceItem[]): { segments: KbSegment[]; truncated: boolean } {
  const segments: KbSegment[] = [];
  let truncated = false;

  for (const [itemIndex, item] of items.entries()) {
    const paragraphs = String(item.body || "")
      .replace(/\r\n?/gu, "\n")
      .split(/\n{2,}/u)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    let buffer = "";
    const flush = (): void => {
      const text = buffer.trim();
      buffer = "";
      if (!text) return;
      if (segments.length >= KB_MAX_SEGMENTS) {
        truncated = true;
        return;
      }
      const index = segments.length + 1;
      segments.push({
        index,
        title: item.title,
        assetId: item.assetId || "",
        version: item.version || "",
        note: item.note || "",
        anchor: `§${index}`,
        text,
        itemIndex
      });
    };

    for (const paragraph of paragraphs) {
      // 单段就超预算：按句末标点再切（中文句号/分号/换行都算边界）。
      if (paragraph.length > KB_SEGMENT_MAX_CHARS) {
        flush();
        for (const piece of splitLongParagraph(paragraph)) {
          buffer = piece;
          flush();
        }
        continue;
      }
      if (buffer && buffer.length + paragraph.length + 2 > KB_SEGMENT_MAX_CHARS) flush();
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return { segments, truncated };
}

function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[。！？；.!?;])\s*/u).filter((piece) => piece.trim());
  const pieces: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > KB_SEGMENT_MAX_CHARS) {
      pieces.push(buffer);
      buffer = "";
    }
    buffer = buffer ? `${buffer}${sentence}` : sentence;
  }
  if (buffer) pieces.push(buffer);
  return pieces.length ? pieces : [paragraph.slice(0, KB_SEGMENT_MAX_CHARS)];
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const KB_SYSTEM_CONTRACT = [
  "你是外贸 B2B 客服知识库的整理员。你的任务是从给定的资料段落里，抽取可以直接拿来回复客户的知识条目。",
  "",
  "**只输出 JSON，不要任何解释、不要 markdown 代码围栏。** 结构：",
  `{"candidates":[{"kind":"qa|snippet|policy|forbidden","question":"客户问法","answer":"标准答法","tags":["标签"],"languages":["zh"],"confidence":0.0,"source_seg":1,"rationale":"为什么值得进库"}]}`,
  "",
  "四种 kind 的用途（别混）：",
  "- qa：一问一答。question 必须是**客户会怎么问**（不是标题），answer 是**可直接发出的标准答法**。资料里找不到答案就不要编。",
  "- snippet：固定口径（付款方式、包装、交期说明这类固定说法），question 写场景标签，answer 写口径原文。",
  "- policy：硬约束（不得给具体价格、不得承诺独家等）。",
  "- forbidden：禁用词或禁用承诺（answer 写禁用短语本身）。",
  "",
  "硬性要求：",
  "1. `source_seg` 必须是**给定段落的编号**；资料里没有依据的条目**不要输出**——宁缺勿造。",
  "2. `answer` 里出现的数字、型号、期限必须与资料原文一致，**不得推断**。",
  "3. `confidence` 是 0 到 1 的小数：资料里写得很明确给 0.9 以上；需要概括或多段拼出来给 0.5–0.8；拿不准给 0.5 以下。",
  "4. 语气与资料一致；资料是英文就用英文，是中文就用中文（languages 如实标注）。",
  "5. 抽不出任何条目时输出 {\"candidates\":[]}，不要硬凑。"
].join("\n");

/** 组装一次批量提炼的提示词。段落以「[编号] 标题（锚点）」开头，方便模型回引。 */
export function buildKbPrompt(segments: KbSegment[], options: { documentTitle?: string } = {}): string {
  const blocks = segments.map((segment) =>
    `[${segment.index}] 标题：${segment.title || "（未命名）"}（锚点 ${segment.anchor}）\n${segment.text}`
  );
  return [
    KB_SYSTEM_CONTRACT,
    "",
    "---- 以下是要整理的全部段落 ----",
    options.documentTitle ? `（来源资料：${options.documentTitle}）` : "",
    blocks.join("\n\n"),
    "---- 段落结束 ----",
    "",
    "现在输出 JSON。"
  ].filter((line) => line !== "").join("\n");
}

// ---------------------------------------------------------------------------
// 输出校验（代码侧，不信任模型）
// ---------------------------------------------------------------------------

export interface KbExtractedCandidate {
  kind: KbKind;
  question: string;
  answer: string;
  tags: string[];
  languages: string[];
  confidence: number;
  /** 通过校验后解析出的段落下标（0-based，可直接索引批次） */
  segmentOrdinal: number;
  rationale: string;
  fingerprint: string;
}

export interface KbParseResult {
  items: KbExtractedCandidate[];
  /** 模型提出但被代码拒收的条数（缺字段 / 未知 kind / 越界 / 非对象） */
  discarded: number;
  /** 其中**引用了不存在的段落**的条数（编造出处）。是 discarded 的子集。 */
  invented: number;
  /** 整批不可读时的原因（JSON 坏 / 顶层结构不对）；非空表示这批一条都没用上。 */
  error: string;
}

/**
 * 提取模型输出里的 JSON 对象。模型经常把 JSON 包在 ```json 围栏里，或前后带客套话 ——
 * 这里做**宽松定位 + 严格解析**：定位到第一个 `{` 到最后一个 `}`，再整体 JSON.parse。
 * 解析不出来就返回 null（由调用方算作整批失败，而不是猜一个半截结果）。
 */
export function extractJsonObject(raw: string): unknown | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 30);
}

/**
 * 校验一批模型输出。
 *
 * 判据全部是**代码可判定**的，不依赖模型自觉：
 * - 顶层不是 `{candidates:[...]}` → 整批错误；
 * - 非对象 / 未知 kind / question 或 answer 为空（qa 必须有问法）→ 丢弃；
 * - `source_seg` 不是整数或超出本批段数 → 丢弃并计 invented；
 * - confidence 缺失、非数字或 NaN → **丢弃**（缺字段一律不放行；绝不默认高置信）。
 *
 * 注意：`confidence < KB_MIN_CONFIDENCE` **不丢弃**（它仍是有效语料，只是不预勾选），
 * 由 `shouldPreselect` 决定要不要自动勾选。
 */
export function parseKbOutput(raw: string, segments: KbSegment[]): KbParseResult {
  const result: KbParseResult = { items: [], discarded: 0, invented: 0, error: "" };
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    result.error = "模型没有返回可解析的 JSON";
    return result;
  }
  const container = asRecord(parsed);
  const rawItems = container.candidates;
  if (!Array.isArray(rawItems)) {
    result.error = "JSON 顶层缺少 candidates 数组";
    return result;
  }

  for (const entry of rawItems) {
    const candidate = asRecord(entry);
    if (!Object.keys(candidate).length) { result.discarded += 1; continue; }
    const kind = String(candidate.kind || "").trim() as KbKind;
    if (!KB_KINDS.includes(kind)) { result.discarded += 1; continue; }

    const question = String(candidate.question ?? "").trim().slice(0, 2_000);
    const answer = String(candidate.answer ?? "").trim().slice(0, 4_000);
    if (!answer) { result.discarded += 1; continue; }
    // qa 必须有问法；其余三类 question 是场景标签，允许为空但会退化成通用标签。
    if (kind === "qa" && !question) { result.discarded += 1; continue; }

    const rawSeg = candidate.source_seg;
    const segmentOrdinal = typeof rawSeg === "number" ? rawSeg : Number.parseInt(String(rawSeg ?? ""), 10);
    if (!Number.isInteger(segmentOrdinal) || segmentOrdinal < 1 || segmentOrdinal > segments.length) {
      // 引用了不存在的段落：这条答案在资料里找不到依据，**必须丢**。
      result.discarded += 1;
      result.invented += 1;
      continue;
    }

    const rawConfidence = candidate.confidence;
    const confidence = typeof rawConfidence === "number"
      ? rawConfidence
      : Number.parseFloat(String(rawConfidence ?? ""));
    if (!Number.isFinite(confidence)) { result.discarded += 1; continue; }

    result.items.push({
      kind,
      question,
      answer,
      tags: asStringArray(candidate.tags),
      languages: asStringArray(candidate.languages),
      confidence: Math.min(Math.max(confidence, 0), 1),
      segmentOrdinal,
      rationale: String(candidate.rationale ?? "").trim().slice(0, 1_000),
      fingerprint: candidateFingerprint(kind, question, answer)
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 预勾选规则（降低人工负担，但不替人做决定）
// ---------------------------------------------------------------------------

/**
 * 商务红线：命中即**不预勾选**（也就不会被批量放行）。
 *
 * 刻意宽松地匹配「价格 / 折扣 / 交期承诺 / 独家 / 赔付」这几类措辞：
 * 它们一旦被自动放行，插件会拿它去回复真实客户，代价不可逆。
 * 宁可让人多看一眼，也不让机器替人做商务承诺。
 */
const COMMERCIAL_REDLINE_PATTERNS: RegExp[] = [
  /价格|报价|多少钱|折扣|优惠|底价|降价/iu,
  /price|discount|quotation|quote the price|cheapest|lowest price/iu,
  /承诺|保证|包退|包换|赔付|赔偿|全额退款|承担全部/iu,
  /guarantee|warrant(?:y|ee)? compensation|full refund|we will pay/iu,
  /独家|总代理|独占|排他/iu,
  /exclusive (?:agent|distributor|rights)/iu
];

/** 该条是否命中商务红线（用于预勾选与审核提示）。 */
export function hitsCommercialRedline(text: string): boolean {
  const value = String(text || "");
  return COMMERCIAL_REDLINE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 预勾选规则（方案 §7.2）：`confidence ≥ 0.9` **且** 文件出处 **且** 未命中商务红线。
 *
 * ⚠️ 只决定"默认勾上"，不决定"直接发布"——发布永远要人点。
 * `confidence < KB_MIN_CONFIDENCE` 一律不预勾选（低置信不许搭便车）。
 */
export function shouldPreselect(candidate: { confidence: number; sourceType: string; question: string; answer: string }): boolean {
  if (candidate.confidence < KB_PRESELECT_CONFIDENCE) return false;
  if (candidate.sourceType !== "file") return false;
  return !hitsCommercialRedline(`${candidate.question}\n${candidate.answer}`);
}
