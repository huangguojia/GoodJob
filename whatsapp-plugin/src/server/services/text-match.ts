/**
 * 文本匹配原语：训练话术库与训练库共用同一套检索，避免两处各写一份、越改越不一致。
 *
 * 这里的两个决定都是踩过坑之后定下来的，改之前请先看注释：
 * - **中文必须按「相邻两字」切**：中文没有词边界，按空格/标点切会把整句变成一个 token，
 *   于是任何两句中文的共同特征都是 0，中文检索等于没做（历史 bug）。
 * - **相似度用「较短一侧被覆盖率」而不是对称 Dice**：客户一句话往往比库里的标准问法短得多，
 *   对称公式会把「完全被覆盖」的短句压到很低分，该自动回的反而回不了。
 */

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 拉丁语系的词至少要有这么长才算特征，避免 "the/for/and" 之类把相似度抬起来。 */
const MIN_LATIN_TOKEN_LENGTH = 3;

export { CJK_PATTERN };

/** 切特征词。返回去重后的集合（顺序无关）。 */
export function tokenize(value: string): string[] {
  const result = new Set<string>();
  for (const segment of String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!segment) continue;
    if (CJK_PATTERN.test(segment)) {
      const characters = [...segment];
      if (characters.length === 1) {
        result.add(characters[0]);
        continue;
      }
      for (let index = 0; index + 1 < characters.length; index += 1) {
        result.add(characters[index] + characters[index + 1]);
      }
      continue;
    }
    if (segment.length >= MIN_LATIN_TOKEN_LENGTH) result.add(segment);
  }
  return [...result];
}

/** 两侧共同特征的数量。 */
export function sharedTokens(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

/** 「较短一侧被覆盖的比例」，范围 0-1。 */
export function coverage(matched: number, leftSize: number, rightSize: number): number {
  const shortest = Math.min(leftSize, rightSize);
  return shortest ? Math.min(1, matched / shortest) : 0;
}

/** 一句查询与一句候选的匹配得分。两侧都只切一次，便于批量比较。 */
export interface TextScore {
  matched: number;
  similarity: number;
}

export function scoreText(queryTokens: string[], candidate: string): TextScore {
  const candidateTokens = tokenize(candidate);
  const matched = sharedTokens(queryTokens, candidateTokens);
  return { matched, similarity: coverage(matched, queryTokens.length, candidateTokens.length) };
}

/* ---------------------------------------------------------------------------
 * 贸易域中英双向词典扩展（跨语言检索的第一层，见 docs/CROSS-LANGUAGE-MATCH-DESIGN.md）。
 *
 * 解决的具体问题：客户用英文问 "What's your MOQ?"，训练库 qa 是「起订量是多少」——
 * 两侧 token 交集恒 0，纯词法必不召回。这里把查询词按词典扩出等价词（moq→起订量、
 * lead time→交期……），扩出来的词**命中计半权**，防止等价词放大误匹配。
 *
 * 两个刻意的设计决定：
 * - **只扩查询侧，不扩条目侧**：库里是标准写法，扩它会引入噪音；查询侧是客户的自由口语，才需要救。
 * - **不做运行时外部翻译**（MyMemory/Google）：把客户消息发第三方有隐私口径问题，且引入网络依赖；
 *   词典是纯本地、零延迟、可测试。覆盖不到的长尾靠条目录入多语言问法（二期）。
 * --------------------------------------------------------------------------- */

/** 外贸高频问法域的中英等价词组。pattern 测原文，terms 是等价写法（中英都要有）。 */
const TRADE_TERM_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /\bmoq\b|起订|最小订|最小量/iu, terms: ["moq", "minimum order", "起订量", "最小起订"] },
  { pattern: /lead\s?time|货期|交期|交货期|生产周期/iu, terms: ["lead time", "delivery time", "交期", "货期"] },
  { pattern: /\bprice\b|\bpricing\b|报价|价格|多少钱|单价/iu, terms: ["price", "quotation", "报价", "价格"] },
  { pattern: /\bsample[s]?\b|样品|打样/iu, terms: ["sample", "样品", "打样"] },
  { pattern: /catalog|brochure|leaflet|目录|画册|彩页/iu, terms: ["catalog", "brochure", "目录", "画册"] },
  { pattern: /shipping|freight|运费|海运|空运/iu, terms: ["shipping", "freight", "运费"] },
  { pattern: /payment|付款|支付|账期|定金|deposit/iu, terms: ["payment", "deposit", "付款", "定金"] },
  { pattern: /discount|cheaper|折扣|便宜|优惠/iu, terms: ["discount", "折扣", "优惠"] },
  { pattern: /certificat|certificate|认证|证书|ce\b|rohs/iu, terms: ["certificate", "certification", "认证", "证书"] },
  { pattern: /warrant|质保|保修|担保/iu, terms: ["warranty", "质保", "保修"] },
  { pattern: /customs|清关|报关|关税/iu, terms: ["customs", "报关", "清关"] },
  { pattern: /packag|packing|包装|装箱|纸箱/iu, terms: ["packing", "package", "包装", "装箱"] },
  { pattern: /\border\b|orders\b|订单|下单/iu, terms: ["order", "orders", "订单", "下单"] },
  { pattern: /deliver|发货|到货|送达/iu, terms: ["delivery", "发货", "到货"] },
  { pattern: /after.?sales|售后|维保/iu, terms: ["after-sales", "售后"] },
  { pattern: /\bagent\b|\bdistributor\b|代理|经销商/iu, terms: ["agent", "distributor", "代理", "经销商"] },
  { pattern: /\boem\b|\bodm\b|贴牌|代工|定制/iu, terms: ["oem", "odm", "贴牌", "代工"] },
  { pattern: /material|材质|材料|用什么料/iu, terms: ["material", "材质", "材料"] },
  { pattern: /\bsize\b|尺寸|规格尺寸|多大/iu, terms: ["size", "尺寸"] },
  { pattern: /color|colour|颜色/iu, terms: ["color", "颜色"] },
  { pattern: /factory|manufacturer|supplier|工厂|厂家|供应商|生产商/iu, terms: ["factory", "manufacturer", "supplier", "工厂", "厂家", "供应商"] },
  { pattern: /\bquote\b|quotation|报价单/iu, terms: ["quote", "quotation", "报价单"] }
];

/**
 * 把查询的 token 集按词典扩出等价词。
 * 返回 `original`（原样返回）与 `expanded`（与原词不重复）。
 *
 * 扩展词与原词**同权计分**（不是半权）：半权下旗舰场景「英文 MOQ → 中文起订量」
 * 只有 2 个 bigram × 0.5 = 1.0，过不了 `MIN_QA_MATCHED_TOKENS=2` 的门槛，词典等于白做。
 * 误召回由另外两道闸挡住：① 单条扩展词命中 1 < 2，天然过不了共同特征门槛；
 * ② 相似度分母把扩展词也算进去（querySize = 原词数 + 扩展词数）——扩展词越多，
 * 相似度被稀释得越狠，随便蹭词典的候选过不了 `MIN_QA_SIMILARITY`。
 */
export function expandTokens(tokens: string[], originalText: string): { original: string[]; expanded: string[] } {
  const text = String(originalText ?? "").normalize("NFKC").toLowerCase();
  const known = new Set(tokens);
  const expanded = new Set<string>();
  for (const rule of TRADE_TERM_EXPANSIONS) {
    if (!rule.pattern.test(text)) continue;
    for (const term of rule.terms) {
      for (const token of tokenize(term)) {
        if (!known.has(token)) expanded.add(token);
      }
    }
  }
  return { original: tokens, expanded: [...expanded] };
}

/**
 * 短语包含判断：忽略大小写，并把连续空白折叠成单个空格后比较。
 *
 * 刻意**不**把空白整体删掉：那样 "e shi" 这类短语会命中 "freeshipping" 内部，
 * 出现用户无法解释的误拦。折叠只解决「同一句话里空格数量不同」，不解决「有空格 vs 没空格」，
 * 后者由录入方保证（禁用短语照原文写即可）。
 */
export function containsPhrase(haystack: string, needle: string): boolean {
  const normalizedNeedle = String(needle ?? "").toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalizedNeedle) return false;
  return String(haystack ?? "").toLowerCase().replace(/\s+/gu, " ").includes(normalizedNeedle);
}
