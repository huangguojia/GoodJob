import { describe, expect, it } from "vitest";
import { AutoChatService } from "../src/server/services/auto-chat-service";

/**
 * 「什么时候可以跳过 CLI 直接给答案」——这条判据直接决定用户要等 20 秒还是 20 毫秒，
 * 同时决定"答错"的风险。两个方向都要锁：
 * - 该直通的没直通 → 每句话白等 20 秒（用户实测抱怨的正是这个）；
 * - 不该直通的直通了 → 措辞差很远的问法被硬套一条库里的原话，答非所问。
 */
function eligible(
  query: string,
  question: string,
  similarity: number,
  matchedTerms: string[],
  languages: string[] = ["en"]
): boolean {
  const service = new AutoChatService(null as never, null as never, null as never);
  const library = {
    query,
    hits: [
      {
        entry: { id: "e1", kind: "qa", question, answer: "a", languages, priority: 100 },
        similarity,
        matched: matchedTerms.length,
        matchedTerms
      }
    ]
  };
  return (
    service as unknown as {
      fastPathEligible: (library: unknown, top: unknown) => boolean;
    }
  ).fastPathEligible(library, library.hits[0]);
}

describe("精确命中直通的判据", () => {
  it("问法几乎逐字一致（相似度 1.0）→ 直通", () => {
    expect(eligible("what is the price of TR700?", "What is the price of TR700?", 1, ["price", "tr700"])).toBe(true);
  });

  it("短问法命中实体词（price?）→ 直通：相似度天然只有 0.3，按相似度永远够不到门槛", () => {
    expect(eligible("price?", "What's your price?", 0.33, ["price"])).toBe(true);
  });

  it("长问法即使命中了实体词也不直通（要结合上下文改写）", () => {
    expect(
      eligible("Please quote your best FOB price for 200 pcs", "Please quote your best FOB price", 0.88, ["price", "quote", "best"])
    ).toBe(false);
  });

  it("短问法只命中虚词 → 不直通（否则「hello there」也能套一条答案）", () => {
    expect(eligible("hello there", "What is your price?", 0.2, ["your"])).toBe(false);
  });

  it("条目本身不是一句问法（超长聊天记录）→ 不直通", () => {
    const longQuestion = "x".repeat(120);
    expect(eligible("price?", longQuestion, 0.25, ["price"])).toBe(false);
  });

  it("英文问法命中中文条目 → 不直通（规则通道原样复用，会把中文报价直接发给英文客户）", () => {
    expect(eligible("what is the price of TR700?", "TR700 的标准配置和标准价是多少？", 1, ["tr700"], ["zh"])).toBe(false);
  });

  it("中文问法命中中文条目 → 直通", () => {
    expect(eligible("TR700 多少钱？", "TR700 的标准配置和标准价是多少？", 1, ["tr700"], ["zh"])).toBe(true);
  });
});
