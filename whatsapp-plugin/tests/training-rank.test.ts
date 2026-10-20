import { describe, expect, it } from "vitest";
import { TrainingLibraryService, type TrainingLibraryEntry } from "../src/server/services/training-library-service";

/**
 * 检索排序的回归测试（2026-10-20 自测后补）。
 *
 * 每一条都对应一次**实测发现的错答**，不是为了凑覆盖率：
 * - 客户英文问质保，库里有中文答案却返回空 → 跨语言通道；
 * - 客户问 quotation for TR700，被答成「What do you want to buy?」→ 词典漏 quote；
 * - 客户只发 `price?`，直接甩 TR700 的价 → 型号不匹配要降权；
 * - 客户只发 `price?`，被 200 字聊天记录抢答 → 短查询只认问法条目。
 */
function entry(partial: Partial<TrainingLibraryEntry> & Pick<TrainingLibraryEntry, "id" | "question">): TrainingLibraryEntry {
  return {
    kind: "qa",
    answer: "answer",
    languages: ["zh"],
    priority: 100,
    tags: [],
    enabled: true,
    ...partial
  } as TrainingLibraryEntry;
}

const service = Object.create(TrainingLibraryService.prototype) as TrainingLibraryService;

const ENTRIES: TrainingLibraryEntry[] = [
  entry({ id: "warranty-zh", question: "质保期是多久？", languages: ["zh"] }),
  entry({ id: "moq-zh", question: "最小起订量是多少？订少了会不会加钱？", languages: ["zh"] }),
  entry({ id: "price-zh", question: "TR700 多少钱一台？", languages: ["zh"] }),
  entry({ id: "price-en", question: "What is the price of TR700?", languages: ["en"] }),
  entry({ id: "price-generic", question: "What's your price?", languages: ["en"] }),
  // 真实库里就这条：问法像、分数高，但**绑死了型号**。`price?` 时它的分数
  // （0.40）比泛问条目（0.33）高，只有型号降权能把它压下去。
  entry({ id: "price-fob", question: "Please quote your best FOB price for TR700", languages: ["en"] }),
  // 真实库里的长聊天记录：恰好含 quote + price 两个词，分数同样 0.40。
  // 只有「短查询只认问法条目」能拦住它。
  entry({
    id: "noise-long",
    question: "We would like to do DDP method deliver to our factory as discussed, please quote your best price and check the customs fee for us",
    languages: ["en"]
  }),
  entry({ id: "indicator-generic", question: "I want to buy the indicator Weighing indicator Can you send", languages: ["en"] })
];

const ids = (query: string) => service.rankQa(query, ENTRIES).map((hit) => hit.entry.id);

describe("训练库检索排序", () => {
  it("英文问质保能召回中文条目（跨语言只命中一个 bigram 也要放行）", () => {
    // 中文按相邻两字切，「质保期」只贡献「质保」一个词。按「至少两个共同特征」判死，
    // 结果是库里有答案、客户却永远收不到。这条锁住跨语言通道存在。
    expect(ids("What is the warranty period?")).toContain("warranty-zh");
  });

  it("minimum order quantity 全称能召回 MOQ 条目", () => {
    // 旧词典只认字面 "moq"，客户写全称就整句扩展为空。
    expect(ids("What is your minimum order quantity?")).toContain("moq-zh");
  });

  it("quotation 问价能召回型号价格条目，而不是泛问", () => {
    expect(ids("Can you give me a quotation for the TR700 weighing indicator?")[0]).toBe("price-en");
  });

  it("客户没提型号时不把绑死型号的条目排在前面（防止报错型号价）", () => {
    // `price?` 只有价格没有型号：先给泛问条目（它会反问型号），不能直接甩 TR700 的价。
    // `price-fob` 分数更高（0.40）且绑死 TR700 —— 只能靠型号降权压下去。
    const top = ids("price?")[0];
    expect(top).toBe("price-generic");
  });

  it("客户提了型号时型号条目仍然优先", () => {
    expect(ids("What is the price of TR700?")[0]).toBe("price-en");
  });

  it("极短问法不拿长聊天记录来答", () => {
    // 两个词的提问 vs 200 字聊天记录，本身就不是正确的对应关系。
    expect(ids("price?")).not.toContain("noise-long");
  });
});
