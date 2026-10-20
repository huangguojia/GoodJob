import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { FollowupSyncService, type FollowupSyncDispatcher, type FollowupSyncOptions } from "../src/server/services/followup-sync";
import { inMemoryDatabasePaths } from "./helpers/test-database";

/**
 * 这一组用例守的是插件侧的职责边界（2026-10-15 起「结论在 CRM 做」）：
 *  - 插件扫描会话库、按时区挑当天消息、打包推给 CRM 的**唯一端点**；
 *  - 打包里必须带上 priorActivityId（重跑改写而不是再写一条的依据）；
 *  - CRM 返回的逐会话明细要落成「同步记录」的 items，计数口径不变；
 *  - CRM 不可达/报错：整批会话都留失败明细、整轮 partial，且推进下次时点；
 *  - 扫描 0 个时记录必须说明为什么是 0（库空 vs 当天没消息）；
 *  - 定时器只在开关打开且到点时才跑。
 * 结论生成/客户匹配/写跟进的红线测试在 `backend/src/whatsapp-followup-sync-test.ts`。
 */

const DAY = "2026-08-09";
const CRM_SECRET = "followup-sync-test-secret-at-least-32-characters";

describe("WhatsApp 对话 → CRM 客户跟进自动同步（插件侧）", () => {
  let crm: Server;
  let crmBaseUrl = "";
  let runtime: AppRuntime;
  let currentTime = new Date("2026-08-09T01:00:00.000Z");
  const ownerUserId = "owner-followup-sync";
  /** 每次推送都留痕，断言靠它们而不是靠返回值的自述。 */
  const dispatchCalls: Array<{ auth: string | undefined; payload: Record<string, unknown> }> = [];
  const seenLeads = new Set<string>();
  let crmShouldFail = false;

  const crmHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/api/whatsapp/followup-sync") {
      if (crmShouldFail) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "CRM 正在维护" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      dispatchCalls.push({ auth: request.headers.authorization, payload });
      const conversations = payload.conversations as Array<Record<string, any>>;
      response.end(JSON.stringify({
        engine: "ai",
        model: "mock-model",
        failures: [],
        uncurated: 0,
        curationReason: "",
        notificationSent: true,
        outcomes: conversations.map((conversation, index) => ({
          conversationId: conversation.conversationId,
          contactName: conversation.contactName,
          contactPhone: conversation.contactPhone,
          messageCount: (conversation.messages as unknown[]).length,
          // Sofia 命中客户；Hans 模拟建线索（同号码第二次推送报 existing）；Atlas 模拟歧义。
          kind: conversation.contactName === "Sofia" ? "customer" : conversation.contactName === "Atlas" ? "skipped" : "lead",
          status: conversation.contactName === "Atlas"
            ? "skipped"
            : conversation.contactName === "Sofia"
              ? "written"
              : seenLeads.has(conversation.contactPhone) ? "existing" : (seenLeads.add(conversation.contactPhone), "written"),
          customerId: conversation.contactName === "Sofia" ? "crm-a" : null,
          leadId: conversation.contactName === "Sofia" || conversation.contactName === "Atlas" ? null : `lead-${index}`,
          activityId: conversation.contactName === "Sofia" ? "ca-1" : null,
          summary: "客户询问认证文件，我方今日回复。",
          error: conversation.contactName === "Atlas" ? "CRM 里有 2 个客户使用了这个号码，请先合并重复客户" : null,
          ambiguousWith: conversation.contactName === "Atlas" ? 2 : 0,
          uncurated: false
        }))
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not found" }));
  };

  beforeAll(async () => {
    crm = createServer((request, response) => void crmHandler(request, response));
    await new Promise<void>((resolve) => crm.listen(0, "127.0.0.1", resolve));
    const address = crm.address();
    if (!address || typeof address === "string") throw new Error("CRM mock did not bind to a port");
    crmBaseUrl = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-followup-sync-test-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(directory),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      allowPrivateAiEndpoints: false
    });
  });

  afterAll(async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) => crm.close((error) => error ? reject(error) : resolve()));
  });

  async function seedConversation(owner: string, input: { displayName: string; phone: string; bodies: Array<{ direction: "inbound" | "outbound"; body: string }>; day?: string }): Promise<string> {
    const day = input.day ?? DAY;
    const account = (await runtime.repository.listAccounts(owner))[0]
      ?? await runtime.repository.createAccount({ name: "Followup Test", provider: "demo", riskAccepted: true, ownerUserId: owner });
    const contact = await runtime.repository.upsertContact({
      accountId: account.id,
      providerContactId: `${input.phone.replace(/\D/gu, "")}@s.whatsapp.net`,
      displayName: input.displayName,
      phone: input.phone,
      source: "demo"
    });
    const conversation = await runtime.repository.ensureConversationForContact(contact.id);
    let index = 0;
    for (const item of input.bodies) {
      index += 1;
      await runtime.repository.createMessage({
        accountId: account.id,
        conversationId: conversation.id,
        // providerMessageId 决定幂等：必须同时带**日期**，否则跨天补种子会被去重吞掉。
        providerMessageId: `${input.phone.replace(/\D/gu, "")}-${day}-${index}`,
        direction: item.direction,
        body: item.body,
        status: "delivered",
        // 全部落在「上海时间」这一天内：UTC 01:0x = 上海 09:0x。
        occurredAt: `${day}T01:0${index}:00.000Z`
      });
    }
    return conversation.id;
  }

  it("扫描 → 打包推送 → 明细落库，全链按新契约走", async () => {
    const service = new FollowupSyncService(runtime.repository, crmBaseUrl, CRM_SECRET, () => currentTime);

    const sofiaId = await seedConversation(ownerUserId, { displayName: "Sofia", phone: "+34612140788", bodies: [
      { direction: "inbound", body: "Could you send the CE certificate for the LED panel?" },
      { direction: "outbound", body: "Sure, sending it today." }
    ] });
    const hansId = await seedConversation(ownerUserId, { displayName: "Hans", phone: "+4915112345678", bodies: [
      { direction: "inbound", body: "Do you have UL certification?" }
    ] });
    const atlasId = await seedConversation(ownerUserId, { displayName: "Atlas", phone: "+491700000001", bodies: [
      { direction: "inbound", body: "We are comparing suppliers this week." }
    ] });

    const first = await service.run(ownerUserId, { trigger: "scheduled" });

    // ---- 打包：一个端点、一批会话、字段逐个对齐 ----
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].auth).toMatch(/^Bearer /u);
    const payload = dispatchCalls[0].payload;
    expect(payload).toMatchObject({ runDate: DAY, timezone: "Asia/Shanghai" });
    const conversations = payload.conversations as Array<Record<string, any>>;
    expect(conversations).toHaveLength(3);
    const sofiaPackage = conversations.find((item) => item.contactName === "Sofia");
    expect(sofiaPackage).toMatchObject({
      conversationId: sofiaId,
      contactPhone: "+34612140788"
    });
    // 首跑没有可改写的跟进记录：JSON 序列化会丢 undefined 键，键必须不存在而不是 null。
    expect("priorActivityId" in sofiaPackage).toBe(false);
    expect(sofiaPackage.messages).toHaveLength(2);
    expect(sofiaPackage.messages[0]).toMatchObject({ direction: "inbound", body: "Could you send the CE certificate for the LED panel?" });

    // ---- 计数口径与插件时代一致（由 CRM 明细聚合） ----
    expect(first).toMatchObject({
      runDate: DAY,
      conversationsScanned: 3,
      customersMatched: 1,
      activitiesWritten: 1,
      leadsCreated: 1,
      leadsExisting: 0,
      ambiguous: 1,
      engine: "ai",
      notificationSent: true,
      status: "success"
    });
    // 引擎与模型名记在运行记录行上（界面读的是它）。
    expect(await runtime.repository.listFollowupSyncRuns(ownerUserId)).toHaveLength(1);
    expect((await runtime.repository.listFollowupSyncRuns(ownerUserId))[0]).toMatchObject({ engine: "ai", model: "mock-model" });
    expect(first.summary).toContain("1 个号码在 CRM 里对应多个客户，未写入");

    // ---- 明细落库：每个会话一条（含跳过） ----
    const items = await runtime.repository.listFollowupSyncItems(first.runId, ownerUserId);
    expect(items).toHaveLength(3);
    expect(items.find((item) => item.conversationKey === sofiaId)).toMatchObject({ kind: "customer", status: "written", customerId: "crm-a", activityId: "ca-1" });
    expect(items.find((item) => item.conversationKey === atlasId)).toMatchObject({ kind: "skipped", status: "skipped" });
    expect(items.find((item) => item.conversationKey === atlasId)?.error).toContain("合并重复客户");

    // ---- 同一天重跑：priorActivityId 必须带上（CRM 据此改写） ----
    const second = await service.run(ownerUserId, { trigger: "manual" });
    expect(dispatchCalls).toHaveLength(2);
    const secondPackage = (dispatchCalls[1].payload.conversations as Array<Record<string, any>>).find((item) => item.contactName === "Sofia");
    expect(secondPackage.priorActivityId).toBe("ca-1");
    expect(second).toMatchObject({ activitiesWritten: 1, leadsCreated: 0, leadsExisting: 1 });

    // ---- 跨天：新的一天是新的一轮 ----
    currentTime = new Date("2026-08-10T01:00:00.000Z");
    await seedConversation(ownerUserId, { displayName: "Hans", phone: "+4915112345678", day: "2026-08-10", bodies: [
      { direction: "inbound", body: "Any update on the UL documents?" }
    ] });
    const nextDay = await service.run(ownerUserId, { trigger: "scheduled" });
    expect(nextDay).toMatchObject({ runDate: "2026-08-10", conversationsScanned: 1 });
    expect(await runtime.repository.listFollowupSyncRuns(ownerUserId)).toHaveLength(2);
    void hansId;
  });

  it("CRM 不可达/报错：整批会话留失败明细，整轮 partial，且推进下次时点", async () => {
    const owner = `${ownerUserId}-crm-down`;
    currentTime = new Date("2026-08-11T01:00:00.000Z");
    await seedConversation(owner, { displayName: "Sofia", phone: "+34612140788", day: "2026-08-11", bodies: [{ direction: "inbound", body: "Please confirm the warranty." }] });

    // HTTP 503：明确报错而不是静默成功。
    crmShouldFail = true;
    try {
      const result = await new FollowupSyncService(runtime.repository, crmBaseUrl, CRM_SECRET, () => currentTime).run(owner, { trigger: "manual" });
      expect(result.status).toBe("partial");
      const runs = await runtime.repository.listFollowupSyncRuns(owner);
      expect(runs[0].status).toBe("partial");
      expect(String(runs[0].error)).toContain("CRM 正在维护");
      const items = await runtime.repository.listFollowupSyncItems(runs[0].id, owner);
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe("failed");
      // 失败也要推进「下次时点」，否则错误会每 60 秒重放一次。
      const settings = await new FollowupSyncService(runtime.repository, crmBaseUrl, CRM_SECRET, () => currentTime).settings(owner);
      expect(settings.lastFollowupSyncAt).toBeTruthy();
      expect(settings.nextFollowupSyncAt).toBeTruthy();
    } finally {
      crmShouldFail = false;
    }

    // 连不上（端口没人听）：同样的失败路径。
    const owner2 = `${ownerUserId}-crm-gone`;
    currentTime = new Date("2026-08-12T01:00:00.000Z");
    await seedConversation(owner2, { displayName: "Sofia", phone: "+34612140788", day: "2026-08-12", bodies: [{ direction: "inbound", body: "Please confirm the warranty." }] });
    const result = await new FollowupSyncService(runtime.repository, "http://127.0.0.1:9", CRM_SECRET, () => currentTime).run(owner2, { trigger: "manual" });
    expect(result.status).toBe("partial");
    expect(result.summary).toContain("1 项失败");
  });

  it("dispatcher 注入：批内失败不跨批，其余会话照常处理", async () => {
    const owner = `${ownerUserId}-batch`;
    const day = "2026-08-15";
    currentTime = new Date(`${day}T01:00:00.000Z`);
    for (let index = 0; index < 7; index += 1) {
      await seedConversation(owner, { displayName: `Batch${index}`, phone: `+49151123000${index}`, day, bodies: [{ direction: "inbound", body: "Please quote." }] });
    }
    let calls = 0;
    const dispatcher: FollowupSyncDispatcher = async (payload) => {
      calls += 1;
      if (calls === 1) throw new Error("第一批网络抖动");
      return {
        engine: "ai",
        model: "batch-model",
        failures: [],
        uncurated: 0,
        curationReason: "",
        notificationSent: true,
        outcomes: payload.conversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          contactName: conversation.contactName,
          contactPhone: conversation.contactPhone,
          messageCount: conversation.messages.length,
          kind: "lead",
          status: "written",
          customerId: null,
          leadId: `lead-${conversation.conversationId}`,
          activityId: null,
          summary: "客户询问报价，我方今日回复。",
          error: null,
          ambiguousWith: 0,
          uncurated: false
        }))
      };
    };
    const options: FollowupSyncOptions = { dispatch: dispatcher };
    const result = await new FollowupSyncService(runtime.repository, crmBaseUrl, CRM_SECRET, () => currentTime, options).run(owner, { trigger: "manual" });
    // 7 个会话分两批（5+2）：第一批失败，第二批照常。
    expect(calls).toBe(2);
    expect(result.conversationsScanned).toBe(7);
    expect(result.activitiesWritten).toBe(0);
    expect(result.leadsCreated).toBe(2);
    expect(result.status).toBe("partial");
    const runs = await runtime.repository.listFollowupSyncRuns(owner);
    // 第一批 5 个会话全部失败（逐会话计数），第二批 2 个照常写成线索。
    expect(runs[0].summary).toContain("5 项失败");
    expect(runs[0].summary).toContain("新建线索 2 条");
  });

  it("定时器只在开关打开且到点时才跑", async () => {
    const service = new FollowupSyncService(runtime.repository, crmBaseUrl, CRM_SECRET, () => currentTime);
    const owner = `${ownerUserId}-schedule`;

    // 出厂默认就是关的 —— 这条链会往业绩考核的数据源里写东西，不能替用户默认打开。
    const defaults = await service.settings(owner);
    expect(defaults.followupSyncEnabled).toBe(false);
    expect(defaults.followupSyncHour).toBe(19);
    expect(defaults.followupSyncMinute).toBe(0);
    expect(await service.runIfDue(owner)).toBeNull();

    const saved = await service.updateSettings(owner, { enabled: true, hour: 19, minute: 0, timezone: "Asia/Shanghai" });
    expect(saved).toMatchObject({ followupSyncEnabled: true, followupSyncHour: 19, followupSyncMinute: 0 });
    // 下次时点必须是一个未来时刻，否则 tick 会每 60 秒重跑一次。
    expect(new Date(saved.nextFollowupSyncAt!).getTime()).toBeGreaterThan(currentTime.getTime());

    // 刚存完还没到点：不该触发。
    expect(await service.runIfDue(owner)).toBeNull();

    // 关掉之后必须把下次时点一并清掉，否则界面会显示「下次同步 19:00」而实际永不执行。
    const disabled = await service.updateSettings(owner, { enabled: false, hour: 19, minute: 0, timezone: "Asia/Shanghai" });
    expect(disabled.followupSyncEnabled).toBe(false);
    expect(disabled.nextFollowupSyncAt).toBeNull();
  });

  it("扫描 0 个时记录必须说明为什么是 0（库空 vs 当天没消息）", async () => {
    // 「扫描 0 个会话；更新 0 条」曾经让用户完全无法自查 —— 库是空的（不知道同步只扫
    // 插件库）和库里有会话但今天没消息，是两件完全不同的事，记录里要分开说。
    const service = new FollowupSyncService(runtime.repository, crmBaseUrl, CRM_SECRET, () => currentTime);

    // 场景一：插件库里一个会话都没有。
    currentTime = new Date("2026-08-12T05:00:00.000Z");
    const emptyOwner = `${ownerUserId}-empty-library`;
    const emptyRun = await service.run(emptyOwner, { trigger: "manual" });
    expect(emptyRun.conversationsScanned).toBe(0);
    expect(emptyRun.summary).toContain("插件库里还没有任何 WhatsApp 会话");
    expect(emptyRun.summary).toContain("同步今天");

    // 场景二：库里有会话，但消息全是前一天（上海时间）的 —— 今天没有可归纳的内容。
    const staleOwner = `${ownerUserId}-stale-library`;
    await seedConversation(staleOwner, { displayName: "Old Chat", phone: "+34612140999", day: "2026-08-11", bodies: [{ direction: "inbound", body: "Please confirm the warranty." }] });
    const staleRun = await service.run(staleOwner, { trigger: "manual" });
    expect(staleRun.conversationsScanned).toBe(0);
    expect(staleRun.summary).toContain("2026-08-12 当天都没有可归纳的消息");
  });
});
