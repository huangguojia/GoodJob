import { describe, expect, it } from "vitest";
import { CrmClient, normalizePhone } from "../src/server/services/crm-client";
import {
  activitiesOf,
  buildCrmContext,
  crmContextPayload,
  crmContextSystemLines,
  emptyCrmContext,
  knowledgeOf,
  matchCustomer,
  quotesOf
} from "../src/server/services/crm-context";

/**
 * CRM 依据取数层的回测。
 *
 * 这一层的价值全在**降级行为**上：CRM 没开、某个接口 500、客户认不出来 —— 这些都不许让
 * 回复链整体失败。所以下面一半用例是"故意让某一个数据源坏掉"，断言剩下的仍然可用、
 * 且坏掉的原因如实出现在 `errors` 里（界面要把这句话显示给用户看）。
 */

const SECRET = "test-crm-secret";

interface StubResponse {
  status?: number;
  body?: unknown;
  /** 模拟连不上（fetch 本身抛错），与「返回 500」是两种不同的失败。 */
  throws?: boolean;
}

function stubFetch(handler: (url: URL) => StubResponse) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const result = handler(url);
    if (result.throws) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CUSTOMERS = {
  customers: [
    {
      id: "cust-1",
      company: "Acme Trading GmbH",
      contact: "Ann Weber",
      country: "DE",
      whatsapp: "+491234567890",
      stage: "询盘",
      grade: "A",
      ownerName: "张三",
      lifecycleStatus: "open",
      pipelineStage: "报价",
      pipelineAmount: 12000,
      activeDealCount: 1,
      wonDealCount: 0,
      lastActivityAt: "2026-10-01T08:00:00.000Z",
      activities: [
        { type: "whatsapp", content: "old note", createdAt: "2026-09-01T08:00:00.000Z", operatorName: "张三" },
        { type: "email", content: "newer note", createdAt: "2026-10-01T08:00:00.000Z", operatorName: "李四" }
      ]
    },
    {
      id: "cust-2",
      company: "Acme Trading Handels GmbH",
      contact: "Bob",
      whatsapp: "",
      country: "DE",
      activities: []
    }
  ]
};

describe("crm-client 的号码归一与匹配原语", () => {
  it("把各种写法的号码收敛成 E.164", () => {
    expect(normalizePhone("+49 1234 567890")).toBe("+491234567890");
    expect(normalizePhone("491234567890")).toBe("+491234567890");
    expect(normalizePhone("(49) 1234-567890")).toBe("+491234567890");
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(null)).toBe("");
  });

  it("先按号码认客户，号码对不上才按名字", () => {
    const byPhone = matchCustomer(CUSTOMERS.customers, { phone: "+491234567890", displayName: "Bob" });
    expect(byPhone?.matchedBy).toBe("phone");
    expect(byPhone?.row.id).toBe("cust-1");

    const byName = matchCustomer(CUSTOMERS.customers, { phone: "+490000000000", displayName: "Bob" });
    expect(byName?.matchedBy).toBe("name");
    expect(byName?.row.id).toBe("cust-2");
  });

  it("宁可认不出来，也不做模糊匹配", () => {
    // "Acme Trading Handels GmbH" 包含 "Acme Trading"，但那是另一家公司。
    // 把 A 客户的历史安到 B 客户头上比「没有 CRM 依据」危险得多。
    expect(matchCustomer(CUSTOMERS.customers, { phone: "", displayName: "Acme Trading" })).toBeNull();
    expect(matchCustomer(CUSTOMERS.customers, { phone: "+490000000000", displayName: "完全不认识的人" })).toBeNull();
  });

  it("跟进按时间倒序取最近 N 条，报价单条目被压成一行", () => {
    const activities = activitiesOf(CUSTOMERS.customers[0] as Record<string, unknown>);
    expect(activities.map((item) => item.content)).toEqual(["newer note", "old note"]);

    const quotes = quotesOf([
      {
        documentNumber: "PI-2026-0042",
        documentType: "形式发票",
        totalAmount: 1234.5,
        currency: "USD",
        quotedAt: "2026-09-20T00:00:00.000Z",
        items: [{ product: "Widget", model: "W-1" }, { product: "Gadget", model: "" }]
      }
    ]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].items).toEqual(["Widget / W-1", "Gadget"]);

    expect(knowledgeOf([{ document: { title: "MOQ", module: "trade", summary: "500 起订" }, score: 9.456 }])[0]).toMatchObject({
      title: "MOQ",
      module: "trade",
      score: 9.46
    });
  });
});

describe("buildCrmContext：取到三路依据", () => {
  it("按号码认到客户，并把跟进、报价、知识一并取回", async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.pathname === "/api/customers") return { body: CUSTOMERS };
      if (url.pathname === "/api/quote-history") {
        return {
          body: {
            records: [
              {
                documentNumber: "PI-2026-0042",
                documentType: "形式发票",
                totalAmount: 1234.5,
                currency: "USD",
                quotedAt: "2026-09-20T00:00:00.000Z",
                items: [{ product: "Widget", model: "W-1" }]
              }
            ]
          }
        };
      }
      if (url.pathname === "/api/agent/knowledge/search") {
        return { body: { hits: [{ document: { title: "MOQ 政策", module: "trade", summary: "最小起订 500" }, score: 8 }] } };
      }
      return { status: 404, body: { message: "nope" } };
    });
    const client = new CrmClient({ baseUrl: "http://127.0.0.1:4188", jwtSecret: SECRET, fetchImpl: impl });

    const context = await buildCrmContext(client, "user-1", {
      phone: "+49 1234 567890",
      displayName: "Ann Weber",
      query: "你们的最小起订量是多少"
    });

    expect(context.errors).toEqual([]);
    expect(context.matchedBy).toBe("phone");
    expect(context.customer?.company).toBe("Acme Trading GmbH");
    expect(context.activities).toHaveLength(2);
    expect(context.quotes[0].documentNumber).toBe("PI-2026-0042");
    expect(context.knowledge[0].title).toBe("MOQ 政策");

    // 报价历史必须按认到的客户 id 过滤；知识检索要把客户的话当查询词带上。
    expect(calls).toContain("/api/customers?scope=mine");
    expect(calls.some((call) => call.startsWith("/api/quote-history?") && call.includes("customerId=cust-1"))).toBe(true);
    expect(calls.some((call) => call.startsWith("/api/agent/knowledge/search?") && call.includes("limit=5"))).toBe(true);
  });

  it("自签的 token 带够 CRM 校验需要的声明", async () => {
    let authorization = "";
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
      return new Response(JSON.stringify(CUSTOMERS), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new CrmClient({ baseUrl: "http://127.0.0.1:4188", jwtSecret: SECRET, fetchImpl: impl });
    await client.getJson("user-1", "/api/customers");

    const { default: jwt } = await import("jsonwebtoken");
    const payload = jwt.verify(authorization.replace(/^Bearer /u, ""), SECRET, {
      issuer: "goodjob-crm",
      audience: "goodjob-crm-web"
    }) as { sub?: string };
    expect(payload.sub).toBe("user-1");
  });
});

describe("buildCrmContext：坏掉的数据源不许拖垮回复链", () => {
  it("没有签名密钥时直接判不可用，且一个请求都不发", async () => {
    const { impl, calls } = stubFetch(() => ({ body: {} }));
    const client = new CrmClient({ baseUrl: "http://127.0.0.1:4188", fetchImpl: impl });
    const context = await buildCrmContext(client, "user-1", { phone: "+491234567890", query: "hi" });

    expect(context.matchedBy).toBe("none");
    expect(context.customer).toBeNull();
    expect(context.errors.join()).toContain("CRM_JWT_SECRET");
    expect(calls).toEqual([]);
  });

  it("客户列表连不上时，知识检索照跑（两个数据源互相独立）", async () => {
    const { impl } = stubFetch((url) =>
      url.pathname === "/api/customers"
        ? { throws: true }
        : { body: { hits: [{ document: { title: "MOQ 政策", summary: "500 起订" }, score: 8 }] } }
    );
    const client = new CrmClient({ baseUrl: "http://127.0.0.1:4188", jwtSecret: SECRET, fetchImpl: impl });
    const context = await buildCrmContext(client, "user-1", { phone: "+491234567890", query: "起订量" });

    expect(context.customer).toBeNull();
    expect(context.errors.join()).toContain("CRM 请求失败");
    expect(context.knowledge).toHaveLength(1);
  });

  it("报价历史 500 时保留客户与跟进，只丢报价", async () => {
    const { impl } = stubFetch((url) => {
      if (url.pathname === "/api/customers") return { body: CUSTOMERS };
      if (url.pathname === "/api/quote-history") return { status: 500, body: { message: "boom" } };
      return { body: { hits: [] } };
    });
    const client = new CrmClient({ baseUrl: "http://127.0.0.1:4188", jwtSecret: SECRET, fetchImpl: impl });
    const context = await buildCrmContext(client, "user-1", { phone: "+491234567890", query: "报价" });

    expect(context.customer?.company).toBe("Acme Trading GmbH");
    expect(context.activities).toHaveLength(2);
    expect(context.quotes).toEqual([]);
    expect(context.errors.join()).toContain("HTTP 500");
    expect(context.matchedBy).toBe("phone");
  });

  it("认不出客户时如实记一笔，而不是硬套一个近似档案", async () => {
    const { impl } = stubFetch((url) =>
      url.pathname === "/api/customers" ? { body: CUSTOMERS } : { body: { hits: [] } }
    );
    const client = new CrmClient({ baseUrl: "http://127.0.0.1:4188", jwtSecret: SECRET, fetchImpl: impl });
    const context = await buildCrmContext(client, "user-1", { phone: "+490000000000", displayName: "未知客户", query: "hi" });

    expect(context.matchedBy).toBe("none");
    expect(context.customer).toBeNull();
    expect(context.errors.join()).toContain("没有匹配到这个客户");
  });
});

describe("提示词里的 CRM 段落", () => {
  const full = {
    matchedBy: "phone" as const,
    customer: {
      id: "cust-1",
      company: "Acme Trading GmbH",
      contact: "Ann Weber",
      country: "DE",
      stage: "询盘",
      grade: "A",
      ownerName: "张三",
      lifecycleStatus: "open",
      pipelineStage: "报价",
      pipelineAmount: 12000,
      activeDealCount: 1,
      wonDealCount: 1,
      lastActivityAt: "2026-10-01T08:00:00.000Z"
    },
    activities: [{ type: "email", content: "客户问过 MOQ", at: "2026-10-01T08:00:00.000Z", operator: "张三" }],
    quotes: [
      {
        documentNumber: "PI-2026-0042",
        documentType: "形式发票",
        totalAmount: 1234.5,
        currency: "USD",
        quotedAt: "2026-09-20T00:00:00.000Z",
        items: ["Widget / W-1"]
      }
    ],
    knowledge: [{ title: "MOQ 政策", module: "trade", summary: "最小起订 500", content: "", score: 8 }],
    errors: []
  };

  it("把客户档案、跟进、报价、知识都写进 system，并明确「历史报价不是新报价」", () => {
    const lines = crmContextSystemLines(full).join("\n");
    expect(lines).toContain("Acme Trading GmbH");
    expect(lines).toContain("客户问过 MOQ");
    expect(lines).toContain("PI-2026-0042");
    expect(lines).toContain("MOQ 政策");
    // 这条是防「拿历史报价当新报价发出去」的，删掉等于把事故口子留着。
    expect(lines).toContain("never restate them as a new commitment");
  });

  it("没有任何依据时干脆不提这段，而不是留一句空话", () => {
    expect(crmContextSystemLines(emptyCrmContext())).toEqual([]);
    expect(crmContextPayload(emptyCrmContext())).toBeNull();
  });

  it("认不到客户但有知识命中时，明确禁止编造订单与承诺", () => {
    const context = { ...emptyCrmContext(), knowledge: full.knowledge };
    const lines = crmContextSystemLines(context).join("\n");
    expect(lines).toContain("No CRM record matched");
    expect(lines).toContain("do NOT invent");
    expect(crmContextPayload(context)).toMatchObject({ matchedBy: "none" });
  });

  it("payload 是数据、system 是规矩：载荷里不带任何指令句", () => {
    const payload = crmContextPayload(full)!;
    expect(payload.customer?.company).toBe("Acme Trading GmbH");
    expect(payload.recentFollowUps).toEqual([{ at: "2026-10-01T08:00:00.000Z", type: "email", content: "客户问过 MOQ" }]);
    expect(payload.quoteHistory[0].amount).toBe("1234.5 USD");
    expect(JSON.stringify(payload)).not.toContain("never");
  });
});
