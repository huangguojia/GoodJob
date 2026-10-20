import { describe, expect, it } from "vitest";
import { AutoChatService } from "../src/server/services/auto-chat-service";

/**
 * 护栏里的价格例外：规则原文写的是「不承诺价格…**除非训练样本或 CRM 数据里有明确依据**」，
 * 这里锁住那条例外真的实现了 —— 否则带标准价的草稿会被一律标成「先别发」，
 * 报价这条通道等于形同虚设（用户实测就是这么撞上的）。
 *
 * 同时锁住反向边界：**编出来的金额必须继续被拦**，否则这次改动就是把护栏拆了。
 */
const RULE = "不承诺价格、折扣、交期或库存，除非训练样本或 CRM 数据里有明确依据";
const SOURCED = "TR700 标准配置：TR700-00A0-ANNN，标准价 1650 元；数据通讯标配 OP1-1（RS-485）。";

/** 私有闸门在测试里直接调：走 compose 要拖一整套 mock，而这里要验的只有判定本身。 */
function gate(reply: string, sourced: string): { blocked: boolean; reason: string } {
  const service = new AutoChatService(null as never, null as never, null as never);
  return (
    service as unknown as {
      applyGuardrails: (reply: string, guardrails: string[], forbidden: string[], sourced: string) => {
        blocked: boolean;
        reason: string;
      };
    }
  ).applyGuardrails(reply, [RULE], [], sourced);
}

describe("报价护栏：有出处的金额放行", () => {
  it("回复里的金额能在本轮语料里找到同一个数 —— 放行", () => {
    const result = gate("TR700 is RMB 1,650 per unit, for reference only.", SOURCED);
    expect(result.blocked).toBe(false);
  });

  it("同一笔钱用中文写（1650 元）也放行：中英判定必须同口径", () => {
    const result = gate("TR700 标准配置标准价 1650 元/台，最终价按配置和数量确定。", SOURCED);
    expect(result.blocked).toBe(false);
  });

  it("语料里没有的金额 —— 继续拦", () => {
    const result = gate("TR700 is RMB 1,200 per unit.", SOURCED);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("价格");
  });

  it("一半有出处一半是编的 —— 拦（只要有一个数对不上就不放行）", () => {
    const result = gate("TR700 is RMB 1,650 per unit, and we can do USD 1,200 for 500 pcs.", SOURCED);
    expect(result.blocked).toBe(true);
  });

  it("语料是空的 —— 任何金额都拦（原有保护不能被这次改动放宽）", () => {
    expect(gate("TR700 is RMB 1,650 per unit.", "").blocked).toBe(true);
  });

  it("回复里没有金额 —— 不拦", () => {
    expect(gate("Could you tell me which model you are asking about?", SOURCED).blocked).toBe(false);
  });
});
