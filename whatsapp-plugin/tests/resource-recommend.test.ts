import { describe, expect, it } from "vitest";
import type { ComposeMessage } from "../src/server/services/auto-chat-service";
import { CliEngine, RESOURCE_SCOUT_SKILL } from "../src/server/services/cli-engine";
import { ResourceHubClient, type CrmResourceCandidate } from "../src/server/services/crm-resources";
import {
  ResourceRecommendService,
  buildResourceCuratePrompt,
  resourceKey,
  sanitizeSuggestedLine,
  toSuggested,
  type ResourceSearchInput
} from "../src/server/services/resource-recommend-service";

/**
 * 资料推荐编排层的回测。
 *
 * 这一层夹在两个"会坏的东西"中间（CRM 与本机 CLI），所以**一半用例在测降级**：
 * 任何一边坏掉，都必须是"这一块依据缺失"，而不是"整条链失败"。
 *
 * 另一半用例在测**闸门**，每条都对应一次真实事故形态：
 * - 模型挑了一份候选清单里没有的资料 → 面板显示一份不存在的文件；
 * - 模型给出的建议话术带金额 → 业务员复制出去，等于把去年的报价当今年的承诺；
 * - 本该走 `withAi:false` 的快速路径偷偷跑了 CLI → 面板卡 60 秒。
 */

const SECRET = "test-crm-secret";
const BASE = "http://127.0.0.1:4188";

interface Call {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
  authorization: string;
}

interface StubResponse {
  status?: number;
  body?: unknown;
  /** 模拟连不上（fetch 本身抛错），与「返回 500」是两种不同的失败。 */
  throws?: boolean;
}

function stubFetch(handler: (url: URL, call: Call) => StubResponse) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const call: Call = {
      method: String(init?.method ?? "GET"),
      path: url.pathname,
      query: url.search,
      body,
      authorization: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "")
    };
    calls.push(call);
    const result = handler(url, call);
    if (result.throws) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function candidate(overrides: Partial<CrmResourceCandidate> = {}): CrmResourceCandidate {
  return {
    id: "res-1",
    sourceType: "file",
    title: "LED Panel Specification Sheet",
    category: "规格书",
    summary: "600x600 LED panel, 40W, 4000K",
    tags: ["led", "panel", "specification"],
    fileType: "pdf",
    version: "v2",
    author: "张三",
    updatedAt: "2026-09-01T00:00:00.000Z",
    accessCount: 3,
    hasExternalLink: true,
    score: 12.5,
    headline: "「led」「specification」都在这份资料里",
    match: { lexical: 8, structured: 0.18, semantic: 4, vector: 0 },
    reasons: [{ kind: "lexical", text: "「led」「规格书」都在这份资料里" }],
    hitTerms: ["led", "specification"],
    ...overrides
  };
}

function recommendResponse(items: CrmResourceCandidate[], warnings: string[] = []) {
  return {
    body: {
      recommendations: items,
      retrieval: { mode: "lexical+structured", scanned: 40, candidates: items.length, vectorEnabled: false, tookMs: 8 },
      customer: { matched: true, id: "cust-1", company: "Acme Trading GmbH" },
      warnings
    }
  };
}

const MESSAGES: ComposeMessage[] = [
  { direction: "outbound", body: "Hi Ann, how can I help?", occurredAt: "2026-10-01T08:00:00.000Z" },
  { direction: "inbound", body: "Can you send the LED panel specification?", occurredAt: "2026-10-01T08:01:00.000Z" }
];

/** 假 CLI。`prompt` 会被回读，用来证明"候选清单真的进了提示词"。 */
function fakeCli(respond: (prompt: string) => { text?: string; model?: string; throws?: string }): {
  engine: CliEngine;
  prompts: string[];
} {
  const prompts: string[] = [];
  const engine = {
    run: async (options: { prompt: string }) => {
      prompts.push(options.prompt);
      const result = respond(options.prompt);
      if (result.throws) throw new Error(result.throws);
      return {
        text: result.text ?? '{"picks":[],"reply":""}',
        model: result.model ?? "deepseek-v4.1-flash",
        sessionId: "s-1",
        durationMs: 1_200,
        timedOut: false
      };
    }
  } as unknown as CliEngine;
  return { engine, prompts };
}

function service(fetchImpl: typeof fetch, cli?: CliEngine) {
  const hub = new ResourceHubClient({ baseUrl: BASE, jwtSecret: SECRET, fetchImpl });
  return new ResourceRecommendService(hub, cli);
}

// ---------------------------------------------------------------- 闸门（纯函数）----

describe("建议话术的金额闸门", () => {
  it("带金额的一句话一律清空，普通话术原样放行", () => {
    expect(sanitizeSuggestedLine("Our price is $8.50 per piece.")).toEqual({ line: "", dropped: true });
    expect(sanitizeSuggestedLine("报价 8.5 USD per piece")).toEqual({ line: "", dropped: true });
    expect(sanitizeSuggestedLine("FOB Shanghai, 12000 CNY total")).toEqual({ line: "", dropped: true });
    expect(sanitizeSuggestedLine("Please find the specification sheet attached.")).toEqual({
      line: "Please find the specification sheet attached.",
      dropped: false
    });
    // 空串不算「拦下过」：模型没给建议话术是正常情况，不该在界面上报一条警告。
    expect(sanitizeSuggestedLine("   ")).toEqual({ line: "", dropped: false });
  });

  it("只拦金额，不误伤数量与型号", () => {
    expect(sanitizeSuggestedLine("MOQ is 500 pieces.").dropped).toBe(false);
    expect(sanitizeSuggestedLine("Model LED-600 fits your ceiling.").dropped).toBe(false);
  });

  it("候选的稳定键带 sourceType（跨来源 id 可能撞车）", () => {
    expect(resourceKey({ sourceType: "file", id: "x" })).toBe("file:x");
    expect(resourceKey({ sourceType: "product", id: "x" })).toBe("product:x");
  });

  it("toSuggested 不下发任何 url 字段（外链只能经 reveal 取）", () => {
    const suggested = toSuggested(candidate());
    expect(JSON.stringify(suggested)).not.toContain("http");
    expect(Object.keys(suggested)).not.toContain("url");
    expect(suggested.why).toBe("");
    expect(suggested.suggestedLine).toBe("");
  });
});

describe("复排提示词", () => {
  it("首行点名资源挑选技能，且候选清单整体嵌进提示词", () => {
    const prompt = buildResourceCuratePrompt(MESSAGES, [candidate()], 3);
    expect(prompt.startsWith(`First load your skill "${RESOURCE_SCOUT_SKILL}"`)).toBe(true);
    expect(prompt).toContain("LED Panel Specification Sheet");
    expect(prompt).toContain("file:res-1");
    expect(prompt).toContain("specification");
    expect(prompt).toContain("Can you send the LED panel specification?");
    // 「不许发明」这条必须在提示词里，否则等于把闸门只放在回读那一侧。
    expect(prompt).toContain("do not exist");
  });

  it("两种角色在提示词里是 customer / agent，不是 inbound / outbound", () => {
    const prompt = buildResourceCuratePrompt(MESSAGES, [candidate()], 3);
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as {
      recentConversation: Array<{ role: string }>;
      customerLatestMessage: string;
    };
    expect(payload.recentConversation.map((item) => item.role)).toEqual(["agent", "customer"]);
    expect(payload.customerLatestMessage).toBe("Can you send the LED panel specification?");
  });

  it("候选超过上限时只截前面几条，不把提示词撑爆", () => {
    const many = Array.from({ length: 20 }, (_, index) => candidate({ id: `res-${index}`, title: `Material ${index}` }));
    const prompt = buildResourceCuratePrompt(MESSAGES, many, 5);
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)) as { candidateMaterials: unknown[] };
    expect(payload.candidateMaterials).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------- 检索层 ----

describe("检索：按对话推荐", () => {
  it("打对 URL 与 body，角色映射与默认值都对", async () => {
    const { impl, calls } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl).search("user-1", { messages: MESSAGES, customerId: "cust-1", conversationKey: "wa:+491234567890" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/agent/resources/recommend");
    expect(calls[0].authorization.startsWith("Bearer ")).toBe(true);
    expect(calls[0].body).toMatchObject({
      customerId: "cust-1",
      conversationKey: "wa:+491234567890",
      limit: 5,
      signal: "manual"
    });
    expect(calls[0].body!.conversation).toEqual([
      { role: "agent", text: "Hi Ann, how can I help?" },
      { role: "customer", text: "Can you send the LED panel specification?" }
    ]);
    // 没给 queryVector 时不该出现这个键：CRM 侧对「有向量但库是空的」与「根本没给向量」区别对待。
    expect(calls[0].body).not.toHaveProperty("queryVector");

    expect(result.resources[0].title).toBe("LED Panel Specification Sheet");
    expect(result.resources[0].key).toBe("file:res-1");
    expect(result.customer).toMatchObject({ matched: true, company: "Acme Trading GmbH" });
    expect(result.warnings).toEqual([]);
  });

  it("空 body 的对话不当作检索条件（去空、只留有正文的）", async () => {
    const { impl, calls } = stubFetch(() => recommendResponse([]));
    const result = await service(impl).search("user-1", {
      messages: [
        { direction: "inbound", body: "   ", occurredAt: "" },
        { direction: "inbound", body: "hello", occurredAt: "" }
      ]
    });
    expect(calls[0].body!.conversation).toEqual([{ role: "customer", text: "hello" }]);
    expect(result.resources).toEqual([]);
  });

  it("CRM 给的 warnings 原样带出来（面板要显示「未取到：…」）", async () => {
    const { impl } = stubFetch(() => recommendResponse([candidate()], ["语义词典未加载", "向量库为空"]));
    const result = await service(impl).search("user-1", { messages: MESSAGES });
    expect(result.warnings).toEqual(["语义词典未加载", "向量库为空"]);
  });

  it("没有对话时走目录式检索（GET，带 q）", async () => {
    const { impl, calls } = stubFetch(() => ({ body: { resources: [candidate()], total: 1, retrievalMode: "list", vectorEnabled: false } }));
    const result = await service(impl).search("user-1", { q: "led panel", limit: 10 });

    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/api/agent/resources");
    expect(calls[0].query).toContain("q=led+panel");
    expect(calls[0].query).toContain("limit=10");
    expect(result.resources).toHaveLength(1);
    expect(result.retrieval).toBeNull();
  });
});

// ---------------------------------------------------------------------- 降级层 ----

describe("检索：坏掉的一端不许拖垮另一端", () => {
  it("CRM 500 → 空候选 + 一句可显示的原因，不抛错", async () => {
    const { impl } = stubFetch(() => ({ status: 500, body: { message: "boom" } }));
    const result = await service(impl).search("user-1", { messages: MESSAGES });
    expect(result.resources).toEqual([]);
    expect(result.warnings.join()).toContain("资料推荐未取到");
    expect(result.warnings.join()).toContain("HTTP 500");
  });

  it("CRM 连不上 → 同样是 warnings，不是异常", async () => {
    const { impl } = stubFetch(() => ({ throws: true }));
    const result = await service(impl).search("user-1", { messages: MESSAGES });
    expect(result.resources).toEqual([]);
    expect(result.warnings.join()).toContain("ECONNREFUSED");
  });

  it("没配签名密钥时一个请求都不发", async () => {
    const { impl, calls } = stubFetch(() => recommendResponse([candidate()]));
    const hub = new ResourceHubClient({ baseUrl: BASE, fetchImpl: impl });
    const result = await new ResourceRecommendService(hub).search("user-1", { messages: MESSAGES });
    expect(calls).toEqual([]);
    expect(result.warnings.join()).toContain("CRM_JWT_SECRET");
  });

  it("压根没接 CRM 时也只报一句，不炸", async () => {
    const result = await new ResourceRecommendService().search("user-1", { messages: MESSAGES });
    expect(result.resources).toEqual([]);
    expect(result.warnings.join()).toContain("未接入 CRM 资源中心");
  });
});

// ---------------------------------------------------------------------- 复排层 ----

describe("复排：候选只许在清单内部动", () => {
  it("候选清单真的进了提示词，且回读的理由被写到 why 上", async () => {
    // 假 CLI 把提示词里那份候选的**标题**回读进 why。若候选没进提示词，这条必然为空。
    const { engine, prompts } = fakeCli((prompt) => {
      const marker = /"title":"([^"]+)"/u.exec(prompt)?.[1] ?? "NO-CANDIDATE";
      return {
        text: JSON.stringify({ picks: [{ id: "file:res-1", why: `因为对话里点了 ${marker}`, suggestedLine: "Here is the specification sheet." }], reply: "建议附上规格书" })
      };
    });
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("file:res-1");
    expect(result.curated).toBe(true);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].why).toBe("因为对话里点了 LED Panel Specification Sheet");
    expect(result.resources[0].suggestedLine).toBe("Here is the specification sheet.");
    expect(result.curatorNote).toBe("建议附上规格书");
    expect(result.replyEngine).toBe("cli");
    // CLI 自报的模型必须原样带出来（「系统里配的模型到底生效没有」的唯一证据）。
    expect(result.model).toBe("deepseek-v4.1-flash");
  });

  it("模型臆造一份不在候选里的资料 → 丢弃并记一笔", async () => {
    const { engine } = fakeCli(() => ({
      text: JSON.stringify({
        picks: [
          { id: "file:does-not-exist", why: "编的", suggestedLine: "" },
          { id: "file:res-1", why: "真的", suggestedLine: "" }
        ],
        reply: ""
      })
    }));
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });

    expect(result.resources.map((item) => item.key)).toEqual(["file:res-1"]);
    expect(result.warnings.join()).toContain("臆造");
    expect(JSON.stringify(result.resources)).not.toContain("does-not-exist");
  });

  it("重复挑同一份只留一条（按 id 去重）", async () => {
    const { engine } = fakeCli(() => ({
      text: JSON.stringify({
        picks: [
          { id: "file:res-1", why: "第一次", suggestedLine: "" },
          { id: "res-1", why: "第二次", suggestedLine: "" }
        ],
        reply: ""
      })
    }));
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].why).toBe("第一次");
  });

  it("含金额的建议话术被清空并记一笔，其余字段照常返回", async () => {
    const { engine } = fakeCli(() => ({
      text: JSON.stringify({ picks: [{ id: "file:res-1", why: "客户问规格", suggestedLine: "The price is $8.50/pcs." }], reply: "" })
    }));
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });

    expect(result.resources[0].suggestedLine).toBe("");
    expect(result.resources[0].why).toBe("客户问规格");
    expect(result.warnings.join()).toContain("金额");
  });

  it("模型说「都不合适」是合法答案：清空列表但标记复排成功", async () => {
    const { engine } = fakeCli(() => ({ text: JSON.stringify({ picks: [], reply: "这批都没对上，先不附资料" }) }));
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });

    expect(result.resources).toEqual([]);
    expect(result.curated).toBe(true);
    expect(result.curatorNote).toBe("这批都没对上，先不附资料");
  });

  it("CLI 炸了 → 退回算法排序，候选一份不少", async () => {
    const { engine } = fakeCli(() => ({ throws: "本机 CLI 没有返回任何内容（常见原因：CLI 未登录）" }));
    const { impl } = stubFetch(() => recommendResponse([candidate(), candidate({ id: "res-2", title: "Price List 2026" })]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });

    expect(result.curated).toBe(false);
    expect(result.resources.map((item) => item.id)).toEqual(["res-1", "res-2"]);
    expect(result.replyEngine).toBe("none");
    expect(result.model).toBeNull();
    expect(result.warnings.join()).toContain("已降级为算法排序");
  });

  it("CLI 回的是脏 JSON（夹了围栏）也能解析", async () => {
    const { engine } = fakeCli(() => ({
      text: '```json\n{"picks":[{"id":"file:res-1","why":"围栏","suggestedLine":""}],"reply":""}\n```'
    }));
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });
    expect(result.resources[0].why).toBe("围栏");
  });

  it("挑出来的条数受 limit 约束", async () => {
    const many = Array.from({ length: 6 }, (_, index) => candidate({ id: `res-${index}`, title: `Material ${index}` }));
    const { engine } = fakeCli((prompt) => {
      const keys = [...prompt.matchAll(/"key":"([^"]+)"/gu)].map((match) => match[1]);
      return { text: JSON.stringify({ picks: keys.map((key) => ({ id: key, why: "w", suggestedLine: "" })), reply: "" }) };
    });
    const { impl } = stubFetch(() => recommendResponse(many));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES, limit: 2 });
    expect(result.resources).toHaveLength(2);
  });

  it("没有候选时压根不跑 CLI（省一次 60 秒）", async () => {
    const { engine, prompts } = fakeCli(() => ({ text: '{"picks":[],"reply":""}' }));
    const { impl } = stubFetch(() => recommendResponse([]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES });
    expect(prompts).toEqual([]);
    expect(result.curated).toBe(false);
    expect(result.resources).toEqual([]);
  });

  it("withAi:false 时一次 CLI 都不跑（快速路径必须真的快）", async () => {
    const { engine, prompts } = fakeCli(() => ({ text: '{"picks":[],"reply":""}' }));
    const { impl, calls } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl, engine).suggest("user-1", { messages: MESSAGES, withAi: false });

    expect(prompts).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(result.curated).toBe(false);
    expect(result.resources).toHaveLength(1);
    expect(result.curatorNote).toBe("");
  });

  it("没接 CLI 时只报降级，不报错", async () => {
    const { impl } = stubFetch(() => recommendResponse([candidate()]));
    const result = await service(impl).suggest("user-1", { messages: MESSAGES });
    expect(result.curated).toBe(false);
    expect(result.resources).toHaveLength(1);
    expect(result.warnings.join()).toContain("本机 CLI 未接入");
  });

  it("复排只打一次 CRM（候选与展示必须是同一批）", async () => {
    const { engine } = fakeCli(() => ({ text: '{"picks":[{"id":"file:res-1","why":"w","suggestedLine":""}],"reply":""}' }));
    const { impl, calls } = stubFetch(() => recommendResponse([candidate()]));
    await service(impl, engine).suggest("user-1", { messages: MESSAGES });
    expect(calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ reveal / 埋点 ----

describe("reveal 与 feedback", () => {
  it("reveal 打对 URL，把真实外链与提取码带回来", async () => {
    const { impl, calls } = stubFetch(() => ({
      body: {
        resource: { id: "res-1", sourceType: "file", title: "LED Panel Specification Sheet", fileType: "pdf" },
        access: { kind: "external", url: "https://pan.baidu.com/s/abc", shareCode: "x7k2" },
        accessId: "rae_123"
      }
    }));
    const result = await service(impl).reveal("user-1", "file", "res-1", { reason: "manual", conversationKey: "wa:+49" });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/agent/resources/file/res-1/reveal");
    expect(calls[0].body).toMatchObject({ reason: "manual", conversationKey: "wa:+49" });
    expect(result).toMatchObject({ ok: true, accessId: "rae_123" });
    if (result.ok && result.access.kind === "external") {
      expect(result.access.url).toBe("https://pan.baidu.com/s/abc");
      expect(result.access.shareCode).toBe("x7k2");
    } else {
      throw new Error("应当返回外链");
    }
  });

  it("id 里的斜杠等字符被转义，不会串到别的路由上", async () => {
    const { impl, calls } = stubFetch(() => ({ body: { resource: {}, access: { kind: "inline", content: "" }, accessId: "" } }));
    await service(impl).reveal("user-1", "knowledge", "a/b c");
    expect(calls[0].path).toBe("/api/agent/resources/knowledge/a%2Fb%20c/reveal");
  });

  it("越权/不存在时不抛错，返回一句原因（面板才有得显示）", async () => {
    const { impl } = stubFetch(() => ({ status: 404, body: { error: "not_found" } }));
    const result = await service(impl).reveal("user-1", "file", "missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("HTTP 404");
  });

  it("埋点失败被吞掉：不能把「复制链接」这个动作卡住", async () => {
    const { impl, calls } = stubFetch(() => ({ status: 500, body: {} }));
    await expect(
      service(impl).feedback("user-1", [{ resourceId: "res-1", sourceType: "file", action: "accepted" }], "wa:+49")
    ).resolves.toBeUndefined();
    expect(calls[0].path).toBe("/api/agent/resources/feedback");
    expect(calls[0].body).toMatchObject({ items: [{ resourceId: "res-1", sourceType: "file", action: "accepted" }], conversationKey: "wa:+49" });
  });

  it("没有条目时一个请求都不发", async () => {
    const { impl, calls } = stubFetch(() => ({ body: {} }));
    await service(impl).feedback("user-1", []);
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ 关键词目录 ----

describe("目录式检索的关键词原样透传", () => {
  it("q 为空时不带这个参数（避免 CRM 侧收到空串当查询词）", async () => {
    const { impl, calls } = stubFetch(() => ({ body: { resources: [], total: 0 } }));
    const input: ResourceSearchInput = { q: "", limit: 3 };
    await service(impl).search("user-1", input);
    expect(calls[0].query).not.toContain("q=");
    expect(calls[0].query).toContain("limit=3");
  });
});

// ------------------------------------------------------------------ 效果报表 ----

describe("推荐效果报表透传（docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）", () => {
  const statsBody = {
    days: 30,
    totals: { exposed: 5, revealed: 4, accepted: 2, dismissed: 0, sent: 1, adoptionRate: 0.5, sendRate: 0.25 },
    items: [
      {
        sourceType: "file",
        resourceId: "res-1",
        title: "LED Panel Specification Sheet",
        counts: { exposed: 5, revealed: 4, accepted: 2, dismissed: 0, sent: 1 },
        adoptionRate: 0.5,
        sendRate: 0.25
      }
    ],
    warnings: []
  };

  it("GET 透传：路径、days 查询参数、Bearer 与响应原样带回", async () => {
    const { impl, calls } = stubFetch(() => ({ body: statsBody }));
    const result = await service(impl).stats("user-1", 30);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/api/agent/resources/stats");
    expect(calls[0].query).toContain("days=30");
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(result.totals.adoptionRate).toBe(0.5);
    expect(result.items[0].title).toContain("LED");
  });

  it("上游挂掉时如实抛错（绝不伪造一份全 0 的假报表）", async () => {
    const { impl } = stubFetch(() => ({ throws: true }));
    await expect(service(impl).stats("user-1")).rejects.toThrow();
  });
});
