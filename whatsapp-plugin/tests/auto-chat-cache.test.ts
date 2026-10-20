import { describe, expect, it } from "vitest";
import { AutoChatService } from "../src/server/services/auto-chat-service";

/**
 * 「同一句客户消息不重算」的缓存契约。
 *
 * 面板每次打开 / 切走再切回都会重打一次 suggest，客户那句话一个字都没变。
 * 这层缓存让第二次直接拿成品；但它是**最容易悄悄出错**的一层：
 * - 把 skip/blocked 也缓存下来 → 用户改完设置发现没生效；
 * - 返回共享引用 → 调用方往 evidence.sources 里补 "resource"，缓存跟着变脏；
 * - TTL 太长 → 训练库改了看不见。
 */

type ComposeResult = {
  action: string;
  reply: string;
  blocked: boolean;
  evidence: { sources: string[] } | null;
};

type CacheAccess = {
  readComposeCache: (key: string) => ComposeResult | null;
  writeComposeCache: (key: string, value: ComposeResult) => void;
  composeCache: Map<string, unknown>;
};

function makeService(now = { value: 1_000_000 }): { service: AutoChatService; access: CacheAccess; now: { value: number } } {
  const service = new AutoChatService(
    null as never,
    null as never,
    null as never,
    undefined,
    () => new Date(now.value)
  );
  return { service, access: service as unknown as CacheAccess, now };
}

const answer = (): ComposeResult => ({
  action: "reply",
  reply: "Thanks, we will check and come back to you.",
  blocked: false,
  evidence: { sources: ["library"] }
});

describe("成品缓存", () => {
  it("命中后直接返回，不必再跑一遍模型", () => {
    const { service, access } = makeService();
    service.composeCacheEnabled = true;
    access.writeComposeCache("k", answer());
    const hit = access.readComposeCache("k");
    expect(hit?.reply).toContain("come back");
  });

  it("返回的是副本：调用方改证据来源不会把缓存改脏", () => {
    const { access } = makeService();
    access.writeComposeCache("k", answer());
    const first = access.readComposeCache("k")!;
    first.evidence!.sources.push("resource");
    const second = access.readComposeCache("k")!;
    expect(second.evidence!.sources).toEqual(["library"]);
  });

  it("只缓存能直接用的成品：skip / blocked 一律不写（否则改完设置会以为没生效）", () => {
    const { access } = makeService();
    access.writeComposeCache("skip", { action: "skip", reply: "", blocked: false, evidence: null });
    access.writeComposeCache("blocked", { action: "reply", reply: "x", blocked: true, evidence: null });
    expect(access.readComposeCache("skip")).toBeNull();
    expect(access.readComposeCache("blocked")).toBeNull();
  });

  it("2 分钟后失效：训练库/档案改了必须能看见", () => {
    const { access, now } = makeService();
    access.writeComposeCache("k", answer());
    now.value += 119_000;
    expect(access.readComposeCache("k")).not.toBeNull();
    now.value += 2_000;
    expect(access.readComposeCache("k")).toBeNull();
  });

  it("关掉开关时完全不写（测试环境就是这么跑的）", () => {
    const { service, access } = makeService();
    service.composeCacheEnabled = false;
    access.writeComposeCache("k", answer());
    expect(access.composeCache.size).toBe(0);
  });

  it("容量有上限，不会随会话数量无限长大", () => {
    const { access } = makeService();
    for (let index = 0; index < 60; index += 1) access.writeComposeCache(`k${index}`, answer());
    expect(access.composeCache.size).toBeLessThanOrEqual(48);
    // 最老的被淘汰，最新的还在。
    expect(access.readComposeCache("k0")).toBeNull();
    expect(access.readComposeCache("k59")).not.toBeNull();
  });
});
