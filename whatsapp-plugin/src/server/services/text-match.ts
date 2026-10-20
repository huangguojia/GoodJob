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
  { pattern: /\bmoq\b|minimum\s+order|起订|最小订|最小量|起订量/iu, terms: ["moq", "minimum order", "起订量", "最小起订"] },
  { pattern: /lead\s?time|货期|交期|交货期|生产周期/iu, terms: ["lead time", "delivery time", "交期", "货期", "生产周期"] },
  // `how much / cost / rate` 是客户问价最常见、但旧词典漏掉的三种说法：
  // 它们不含 "price" 也不含「价格」，于是整句扩展为空，短问法直接 0 命中。
  // `quote / quotation / quoting` 必须留在**问价**组里：旧写法把它们单独归到「报价单」组，
  // 于是 "Can you give me a quotation for the TR700?" 只扩出 quote/报价单，扩不到 price，
  // TR700 价格条目共同特征为 0，反而被「你想买什么」这类泛问抢答（10/20 自测实测）。
  { pattern: /\bprice\b|\bpricing\b|\bhow much\b|\bcosts?\b|\brates?\b|\bquote|\bquotation|\bquoting\b|报价|价格|多少钱|单价|价钱|价目/iu, terms: ["price", "quotation", "quote", "报价", "价格"] },
  { pattern: /\bsample[s]?\b|样品|打样/iu, terms: ["sample", "样品", "打样"] },
  { pattern: /catalog|brochure|leaflet|目录|画册|彩页/iu, terms: ["catalog", "brochure", "目录", "画册"] },
  { pattern: /shipping|freight|运费|海运|空运/iu, terms: ["shipping", "freight", "运费", "海运", "空运"] },
  { pattern: /payment|付款|支付|账期|定金|deposit/iu, terms: ["payment", "deposit", "付款", "定金", "账期"] },
  { pattern: /discount|cheaper|折扣|便宜|优惠/iu, terms: ["discount", "折扣", "优惠", "便宜"] },
  // ⚠️ `ce` 必须有左边界：旧写法 `ce\b` 会命中 "pri**ce**"、"servi**ce**"、"sin**ce**" 的结尾，
  // 于是问价被悄悄扩展成「认证/证书」，查询特征数翻倍、相似度被稀释到门槛以下 ——
  // 这是「price? 永远 0 命中」的一半原因（另一半是 2 特征门槛）。
  { pattern: /certificat|certificate|认证|证书|\bce\b|rohs/iu, terms: ["certificate", "certification", "认证", "证书"] },
  { pattern: /warrant|质保|保修|担保/iu, terms: ["warranty", "质保", "保修"] },
  { pattern: /customs|清关|报关|关税/iu, terms: ["customs", "报关", "清关"] },
  { pattern: /packag|packing|包装|装箱|纸箱/iu, terms: ["packing", "package", "包装", "装箱"] },
  { pattern: /\border\b|orders\b|订单|下单/iu, terms: ["order", "orders", "订单", "下单"] },
  { pattern: /deliver|发货|到货|送达/iu, terms: ["delivery", "发货", "到货"] },
  { pattern: /after.?sales|售后|维保/iu, terms: ["after-sales", "售后"] },
  { pattern: /\bagent\b|\bdistributor\b|代理|经销商/iu, terms: ["agent", "distributor", "代理", "经销商"] },
  // `定制` 在 pattern 里、却不在 terms 里：客户问 "can you customize?" 时扩不出 oem，
  // 中文库里写「支持定制吗」也反向对不上 —— 两处都断，补进 terms 才通。
  { pattern: /\boem\b|\bodm\b|贴牌|代工|定制/iu, terms: ["oem", "odm", "贴牌", "代工", "定制"] },
  { pattern: /material|材质|材料|用什么料/iu, terms: ["material", "材质", "材料"] },
  { pattern: /\bsize\b|尺寸|规格尺寸|多大/iu, terms: ["size", "尺寸"] },
  { pattern: /color|colour|颜色/iu, terms: ["color", "颜色"] },
  { pattern: /factory|manufacturer|supplier|工厂|厂家|供应商|生产商/iu, terms: ["factory", "manufacturer", "supplier", "工厂", "厂家", "供应商"] },
  { pattern: /\bquote\b|quotation|报价单/iu, terms: ["quote", "quotation", "报价单"] }
];

/**
 * 低区分度特征词（虚词 / 客套词 / 通用疑问词）。
 *
 * 为什么需要：`Please quote your best FOB price for 200 pcs` 与一条「请拍仪表上的二维码」
 * 的历史回复共享 please / your / best / for —— 光靠虚词就凑够两个特征，排序被整条带跑。
 *
 * **不从 `tokenize` 里删**：切词口径要稳定（话术库与训练库共用，测试也锁着这个口径），
 * 这里只在排序与短问法判定时把它们当"不算数"的词处理。
 */
const STOP_TERMS = new Set([
  "please", "kindly", "thanks", "thank", "hello", "dear", "sir", "madam",
  "the", "and", "for", "with", "your", "yours", "you", "our", "ours", "we",
  "what", "whats", "how", "much", "are", "is", "was", "were", "can", "could",
  "would", "will", "this", "that", "these", "those", "have", "has", "had",
  "from", "about", "into", "best", "good", "great", "ok", "okay", "yes",
  "not", "any", "some", "send", "gave", "give", "tell", "let", "know",
  "need", "want", "looking", "look", "get", "got", "make", "made", "just",
  "now", "then", "there", "here", "also", "me", "my", "mine", "it", "its",
  "be", "been", "do", "does", "did", "if", "or", "per",
  "多少", "是多", "什么", "怎么", "么样", "可以", "你们", "我们", "他们",
  "这个", "那个", "哪个", "请问", "一下", "是否", "有没", "没有", "就是",
  "还是", "如果", "大概", "左右", "需要", "想要", "一个", "一些", "的话"
]);

/** 贸易域强特征词：词典里所有等价写法的切词结果。短问法放宽门槛时只认这些词。 */
const DOMAIN_TERMS = new Set(
  TRADE_TERM_EXPANSIONS.flatMap((rule) => rule.terms.flatMap((term) => tokenize(term)))
);

/** 这个词是不是「说了等于没说」的虚词。 */
export function isStopTerm(token: string): boolean {
  return STOP_TERMS.has(token);
}

/** 这个词是不是贸易域强特征（price / 报价 / moq / 交期 ……）。 */
export function isDomainTerm(token: string): boolean {
  return DOMAIN_TERMS.has(token);
}

/**
 * 把查询的 token 集按词典扩出等价词。
 * 返回 `original`（原样返回）与 `expanded`（与原词不重复）。
 *
 * 扩展词与原词**同权计分**（不是半权）：半权下旗舰场景「英文 MOQ → 中文起订量」
 * 只有 2 个 bigram × 0.5 = 1.0，过不了 `MIN_QA_MATCHED_TOKENS=2` 的门槛，词典等于白做。
 * 误召回由另外两道闸挡住：① 相似度分母把扩展词也算进去（querySize = 原词数 + 扩展词数）
 * ——扩展词越多，相似度被稀释得越狠，随便蹭词典的候选过不了 `MIN_QA_SIMILARITY`；
 * ② 单条扩展词命中只有 1 个共同特征，默认过不了 `MIN_QA_MATCHED_TOKENS=2`。
 *
 * ⚠️ 第 ② 条有**跨语言例外**（10/20 自测后加）：中文按相邻两字切，一个概念只贡献
 * 1~2 个 bigram，英文问 "warranty" 恰好只对上「质保」一个词。死守 2 个特征等于
 * 「库里有答案但永远不回」。例外只开在 `rankQa` 的跨语言分支，且要求命中**词典扩展词 +
 * 贸易域强特征 + 条目是问法**三件事同时成立，纯中文对纯中文的既有行为一个字不变。
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
