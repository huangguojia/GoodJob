import { describe, expect, it } from "vitest";
import { containsPhrase, coverage, expandTokens, scoreText, sharedTokens, tokenize } from "../src/server/services/text-match";

/**
 * 训练库与训练话术库共用的检索原语。
 *
 * 这里的每一条都对应一个曾经踩过的坑：中文按空格切会让中文检索整体失效、
 * 对称相似度会把「短问句被长标准问法完全覆盖」压成低分。改动本文件前先看 text-match.ts 的注释。
 */
describe("文本匹配原语", () => {
  describe("tokenize", () => {
    it("中文按相邻两字切，而不是按空格切", () => {
      // 关键回归：中文没有词边界，按空格切会让整句变成一个 token，任何两句中文的共同特征都是 0。
      expect(tokenize("你好世界").sort()).toEqual(["世界", "你好", "好世"].sort());
      expect(sharedTokens(tokenize("你们的最小起订量"), tokenize("你们的最小起订量是多少"))).toBeGreaterThan(0);
    });

    it("单个汉字本身就是一个特征词", () => {
      expect(tokenize("好")).toEqual(["好"]);
    });

    it("拉丁词至少三个字符，短词与数字单列不算特征", () => {
      expect(tokenize("What is the MOQ for it?").sort()).toEqual(["for", "moq", "the", "what"].sort());
      expect(tokenize("ab cd efg")).toEqual(["efg"]);
    });

    it("中英混排时两类特征都保留", () => {
      const tokens = tokenize("iPhone 15 保护壳");
      expect(tokens).toContain("iphone");
      expect(tokens).toContain("保护");
      expect(tokens).toContain("护壳");
      // 两位数字不构成特征（否则型号数字会把不相关的问题拉近）
      expect(tokens).not.toContain("15");
    });

    it("重复词只算一次", () => {
      expect(tokenize("price price PRICE").length).toBe(1);
    });
  });

  describe("coverage / scoreText", () => {
    it("较短一侧被完全覆盖时相似度为 1，而不是被长句稀释", () => {
      // 对称 Dice 会给出 2*3/(3+7)=0.6：该自动回的短问句会被门槛挡住。
      expect(coverage(3, 3, 7)).toBe(1);
      expect(scoreText(tokenize("最小起订量"), "你们厂最小的起订量大概是多少呢").similarity).toBeGreaterThan(0.3);
    });

    it("没有任何共同特征时相似度为 0", () => {
      expect(scoreText(tokenize("shipping cost"), "你们的公司地址在哪里").similarity).toBe(0);
    });

    it("空串不产生相似度", () => {
      expect(coverage(0, 0, 0)).toBe(0);
      expect(scoreText([], "anything").similarity).toBe(0);
    });
  });

  describe("expandTokens（跨语言词典扩展）", () => {
    it("英文 MOQ 扩出中文等价词（旗舰场景：客户用英文问、库里是中文）", () => {
      const query = "What's your MOQ?";
      const { original, expanded } = expandTokens(tokenize(query), query);
      expect(original).toContain("moq");
      // tokenize("起订量") → 起订/订量；tokenize("minimum order") → minimum/order
      expect(expanded).toContain("起订");
      expect(expanded).toContain("订量");
      expect(expanded).toContain("minimum");
      expect(expanded).toContain("order");
    });

    it("中文查询反向扩出英文等价词", () => {
      const query = "你们的交期要多久";
      const { expanded } = expandTokens(tokenize(query), query);
      expect(expanded).toContain("lead");
      expect(expanded).toContain("delivery");
    });

    it("扩展词不与原词重复", () => {
      const query = "What's the price and MOQ?";
      const tokens = tokenize(query);
      const { original, expanded } = expandTokens(tokens, query);
      expect(original).toEqual(tokens);
      for (const token of original) expect(expanded).not.toContain(token);
    });

    it("大小写与标点无关：Moq? 与 MOQ！触发同一组扩展", () => {
      const a = expandTokens(tokenize("Moq?"), "Moq?").expanded;
      const b = expandTokens(tokenize("MOQ！"), "MOQ！").expanded;
      expect(a.sort()).toEqual(b.sort());
    });

    it("不触发任何词典模式时扩展集为空", () => {
      const { expanded } = expandTokens(tokenize("hello there friend"), "hello there friend");
      expect(expanded).toEqual([]);
    });
  });

  describe("containsPhrase", () => {
    it("忽略大小写，并把连续空白折叠后比较", () => {
      expect(containsPhrase("We quote USD 12 per unit", "usd 12")).toBe(true);
      expect(containsPhrase("We quote USD    12 per unit", "usd 12")).toBe(true);
      // 刻意不把空白整体删掉：否则 "e shi" 会命中 "freeshipping" 内部，出现无法解释的误拦。
      expect(containsPhrase("we quote usd12", "USD 12")).toBe(false);
    });

    it("空短语不命中任何东西", () => {
      expect(containsPhrase("anything", "   ")).toBe(false);
    });

    it("不做子串越界的宽松匹配", () => {
      expect(containsPhrase("cheapest option", "cheap")).toBe(true);
      expect(containsPhrase("premium option", "cheap")).toBe(false);
    });
  });
});
