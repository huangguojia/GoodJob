/**
 * 通话「三条建议」的收口口径。
 *
 * 这段逻辑坏起来是**静默**的：多一条少一条都不报错，界面只是"看起来少了一个"。
 * 所以这里逐条钉住：空回复丢掉、重复丢掉、护栏挡掉的丢掉、最多三条、
 * 中文与正文一字不差时按"没有中文版"处理。
 *
 * ⚠️ 断言里不要调用被测函数去构造期望值（那样写坏了两边一起坏，测试照样绿）。
 * 期望值一律写成字面量。
 */
import { describe, expect, it } from "vitest";
import {
  callSuggestPromptOverrides,
  callSuggestResultSchema,
  finalizeCallSuggestOptions,
  quickCallOption
} from "../src/server/services/auto-chat-service";

const option = (reply: string, reasonZh = "客户在问交期，先给天数再问数量。", replyZh = "") => ({
  reply,
  reasonZh,
  replyZh
});

describe("callSuggestResultSchema", () => {
  it("解析正常的三个候选", () => {
    const parsed = callSuggestResultSchema.parse({
      options: [
        { reasonZh: "客户在问交期，先给确定天数。", reply: "Lead time is 25 days.", replyZh: "交期 25 天。" },
        { reasonZh: "先确认目的地再报交期。", reply: "Which port should I ship to?" },
        { reasonZh: "顺势提 MOQ。", reply: "MOQ is 50 pcs.", replyZh: "起订量 50 件。" }
      ]
    });
    expect(parsed.options).toHaveLength(3);
    // 缺 replyZh 时补空串，界面据此只显示英文那一格。
    expect(parsed.options[1].replyZh).toBe("");
  });

  it("模型漏了中文理由也不该让整条失败（少一句理由 > 三条全没有）", () => {
    const parsed = callSuggestResultSchema.parse({
      options: [{ reasonZh: "", reply: "Yes, 25 days." }]
    });
    expect(parsed.options).toHaveLength(1);
    expect(parsed.options[0].reasonZh).toBe("");
  });

  it("超过三条直接拒绝（提示词里写的是 exactly 3）", () => {
    expect(() =>
      callSuggestResultSchema.parse({
        options: [
          { reasonZh: "a", reply: "one" },
          { reasonZh: "b", reply: "two" },
          { reasonZh: "c", reply: "three" },
          { reasonZh: "d", reply: "four" }
        ]
      })
    ).toThrow();
  });

  it("没有 reply 的候选不算候选", () => {
    expect(() => callSuggestResultSchema.parse({ options: [{ reasonZh: "只有理由" }] })).toThrow();
  });
});

describe("finalizeCallSuggestOptions", () => {
  it("丢掉空回复并如实计数（界面要说清为什么只剩两条）", () => {
    const result = finalizeCallSuggestOptions([option("Yes, 25 days."), option("   "), option("MOQ is 50 pcs.")]);
    expect(result.options).toHaveLength(2);
    expect(result.dropped).toBe(1);
    expect(result.options[0].reply).toBe("Yes, 25 days.");
  });

  it("只差标点/大小写的重复只留一条", () => {
    const result = finalizeCallSuggestOptions([
      option("Yes, 25 days."),
      option("  yes 25 DAYS  "),
      option("MOQ is 50 pcs.")
    ]);
    expect(result.options).toHaveLength(2);
    expect(result.dropped).toBe(1);
    expect(result.options.map((item) => item.reply)).toEqual(["Yes, 25 days.", "MOQ is 50 pcs."]);
  });

  it("最多三条：第四条即便合法也不返回", () => {
    const result = finalizeCallSuggestOptions([
      option("one"),
      option("two"),
      option("three"),
      option("four")
    ]);
    expect(result.options.map((item) => item.reply)).toEqual(["one", "two", "three"]);
    expect(result.dropped).toBe(0);
  });

  it("护栏逐个过：中间那条被挡下，其余照留（不能因为排第二就放行）", () => {
    const result = finalizeCallSuggestOptions([option("one"), option("two"), option("three")], (reply) =>
      reply.includes("two")
    );
    expect(result.options.map((item) => item.reply)).toEqual(["one", "three"]);
    expect(result.dropped).toBe(1);
  });

  it("中文与正文一字不差时按「没有中文版」处理（否则像要发两条）", () => {
    const result = finalizeCallSuggestOptions([option("交期 25 天", "客户在问交期。", "交期 25 天")]);
    expect(result.options[0].replyZh).toBe("");
  });

  it("模型没给理由时补一句通用说明，不编事实", () => {
    const result = finalizeCallSuggestOptions([option("Yes, 25 days.", "")]);
    expect(result.options[0].reasonZh).toBe("按上下文给的建议");
  });
});

describe("quickCallOption（快稿通道）", () => {
  it("有现成说法就给一条，理由写明「这是快稿」+ 来源相似度", () => {
    const option = quickCallOption({
      reply: "TR700 standard price is RMB 1,650 per unit.",
      reason: "与训练库匹配（相似度 1.00，3 个共同特征）"
    });
    expect(option?.reply).toBe("TR700 standard price is RMB 1,650 per unit.");
    expect(option?.reasonZh).toBe("快速草稿 · 与训练库匹配（相似度 1.00，3 个共同特征）");
    // 快稿没有中文版：模型没参与，就没有"同一段话的中文写法"。
    expect(option?.replyZh).toBe("");
  });

  it("被护栏挡下的稿子不充快稿（宁可没稿，也不把违规的那条先垫上去）", () => {
    expect(quickCallOption({ reply: "Price is RMB 1,650.", reason: "x", blocked: true })).toBeNull();
  });

  it("没有回复时返回 null（不拿一句通用话术把客户的提问糊过去）", () => {
    expect(quickCallOption({ reply: "   ", reason: "训练库没命中" })).toBeNull();
  });

  it("理由超过 300 字就截断，不让整条被 schema 丢掉", () => {
    const option = quickCallOption({ reply: "ok", reason: "长".repeat(400) });
    expect(option).not.toBeNull();
    // 300 是 callSuggestOptionSchema.reasonZh 的上限（写成字面量，别调被测函数的常量）。
    expect(option!.reasonZh.length).toBe(300);
    // 截断后仍然是合法的一条：过 schema 不报错。
    expect(callSuggestResultSchema.parse({ options: [option] }).options).toHaveLength(1);
  });

  it("没给理由时写一句通用说明，不编事实", () => {
    const option = quickCallOption({ reply: "Yes, 25 days." });
    expect(option?.reasonZh).toBe("快速草稿 · 训练库里的现成说法");
  });
});

describe("callSuggestPromptOverrides", () => {
  it("明确要求三个候选、并且理由必须是简体中文", () => {
    const { intro, schemaLine } = callSuggestPromptOverrides();
    const text = [...intro, schemaLine].join("\n");
    expect(text).toContain("exactly 3");
    expect(text).toContain("Simplified Chinese");
    expect(schemaLine).toContain("reasonZh");
    // 只写 "Chinese" 不够：模型会拿繁体回，界面读起来像没转换。
    expect(schemaLine).toContain("MUST be Simplified Chinese");
  });

  it("禁止编造价格/交期（通话里报错价是真金白银的损失）", () => {
    const { schemaLine } = callSuggestPromptOverrides();
    expect(schemaLine).toContain("Never invent prices, lead times or specs");
  });
});
