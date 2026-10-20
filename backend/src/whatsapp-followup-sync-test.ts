import assert from "node:assert/strict";
import { getStore, setStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type { AiModelConfig, SessionUser } from "./types.js";
import {
  BASIC_PENDING_NOTE,
  basicFollowupSummary,
  buildActivityContent,
  buildSummaryPrompt,
  executeRefineTask,
  FOLLOWUP_MARKER_PREFIX,
  followupMarker,
  greetingTouchSummary,
  hasRecordableContent,
  isGreetingLike,
  leadExternalId,
  normalizePhone,
  runWhatsappFollowupSync,
  sanitizeSummary,
  type FollowupSyncConversationInput,
  type FollowupSyncDeps,
  type RefineTask
} from "./whatsapp-followup-sync.js";

// ---------------------------------------------------------------------------
// WhatsApp 跟进同步 · CRM 侧自测。
//
// 2026-10-15 两段式改版后的口径：
//   - 同步请求里**只做零延迟基础写入**（统计内容），跟进/客户旅程即时可见；
//   - AI 进展总结全部走后台补全：本机 CLI 优先 → CRM 配置模型 → 保留基础内容；
//   - 基础写入的成败才是整轮 failures 的依据，后台补全失败绝不倒灌同步结果。
// 这里钉住的红线：marker 前缀、匹配不上不猜、不写原文、重跑改写、
// 补全成功必须改写**同一条**记录（跟进/旅程即时性 + AI 补足的闭环）。
// 纪律：服务级行为用注入的假 store / 假 CLI / 假模型通道，不连 MySQL、不调真模型。
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === undefined ? "" : ` → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const USER = { id: "u_followup", teamId: "t1", role: "sales" } as SessionUser;
const RUN_DATE = "2026-10-15";

function conversation(overrides: Partial<FollowupSyncConversationInput> = {}): FollowupSyncConversationInput {
  return {
    conversationId: overrides.conversationId ?? "wa:4915112345678@c.us",
    contactName: overrides.contactName ?? "Sofia",
    contactPhone: overrides.contactPhone ?? "+4915112345678",
    priorActivityId: overrides.priorActivityId,
    messages: overrides.messages ?? [
      { direction: "inbound", occurredAt: `${RUN_DATE}T03:05:00.000Z`, body: "Please quote 500 units" },
      { direction: "outbound", occurredAt: `${RUN_DATE}T03:10:00.000Z`, body: "Sure, sending the quotation today" }
    ]
  };
}

function modelConfig(overrides: Partial<AiModelConfig> = {}): AiModelConfig {
  return {
    id: "aim_1", provider: "openai-compatible", protocol: "openai-compatible", name: "mock",
    baseUrl: "http://127.0.0.1:9", model: "mock-model", apiKey: "k", enabled: true, temperature: 0.1,
    useLeadFinder: false, useWebsiteParse: false, useScoring: false, useEmailDraft: false, useExam: false,
    ownerId: USER.id, teamId: USER.teamId, updatedAt: new Date().toISOString(),
    ...overrides
  };
}

const CLI_OK = '{"summary":"客户询问样品进度并等待我方安排","worthRecording":true}';
const CLI_SKIP = '{"summary":"","worthRecording":false}';

interface TestRig {
  store: { customers: any[]; customerActivities: any[]; leads?: any[]; internalMessages: any[]; persistCalls: number };
  leads: Array<Record<string, unknown>>;
  deps: FollowupSyncDeps;
  refineTasks: RefineTask[];
  /** 同步跑完所有收集到的补全任务（复刻生产队列的消费次序）。 */
  drainRefines: () => Promise<void>;
}

function rig(options: {
  customers?: any[];
  aiConfig?: AiModelConfig | null;
  aiCall?: FollowupSyncDeps["aiCall"];
  cliRun?: FollowupSyncDeps["cliRun"];
  withLeadStore?: boolean;
} = {}): TestRig {
  const store: TestRig["store"] = {
    customers: options.customers ?? [],
    customerActivities: [],
    leads: options.withLeadStore ? [] : undefined,
    internalMessages: [],
    persistCalls: 0,
    async persist() {
      this.persistCalls += 1;
    }
  };
  const previous = getStore();
  setStore(store as unknown as CrmStore);
  const leads: Array<Record<string, unknown>> = [];
  const refineTasks: RefineTask[] = [];
  const deps: FollowupSyncDeps = {
    customersOf: () => store.customers,
    aiConfig: () => options.aiConfig === undefined ? modelConfig() : options.aiConfig,
    createLead: (_user, input) => {
      leads.push(input);
      return { lead: { id: `lead_${leads.length}` }, duplicate: leads.length > 1 };
    },
    cliRun: options.cliRun ?? (async () => CLI_OK) as FollowupSyncDeps["cliRun"],
    aiCall: options.aiCall ?? (async () => '{"summary":"客户询问样品进度并确认联系方式","worthRecording":true}') as FollowupSyncDeps["aiCall"],
    enqueueRefine: (task) => refineTasks.push(task),
    clock: () => new Date()
  };
  return {
    store,
    leads,
    deps,
    refineTasks,
    async drainRefines() {
      const queue = refineTasks.splice(0);
      for (const task of queue) await executeRefineTask(task, deps);
    }
  };
}

function restoreStore(previous: unknown) {
  setStore(previous as CrmStore);
}

/* ---------- 纯函数：前缀与幂等键 ---------- */

check("marker 打头且日期可读", followupMarker(RUN_DATE) === `[${FOLLOWUP_MARKER_PREFIX} ${RUN_DATE}]`);
{
  const content = buildActivityContent(RUN_DATE, "客".repeat(5_000));
  check("跟进正文一定 marker 打头且不超 2000 字", content.startsWith("[WhatsApp 自动同步 2026-10-15]") && content.length <= 2_000);
}
{
  const first = leadExternalId("+49 151 1234 5678");
  check("线索幂等键只由号码决定且不带日期", first === "whatsapp:+4915112345678" && leadExternalId("004915112345678") === first);
}
check("号码归一：数字以外的字符全剥掉", normalizePhone("+49 (151) 1234-5678") === "+4915112345678" && normalizePhone("") === "");

/* ---------- 纯函数：寒暄判据与基础跟进 ---------- */

check(
  "问候/收到/纯表情都算寒暄",
  ["Hi", "hello!", "OK", "收到", "你好", "您好", "哈喽", "嗨", "👍", "  "].every((text) => isGreetingLike(text))
);
check(
  "带信息的句子不算寒暄",
  ["Could you send the CE certificate?", "Please quote 500 units", "我们的样品下周寄出", "OK 下周一再联系"].every((text) => !isGreetingLike(text))
);
check(
  "有业务内容才值得记录；全寒暄判假（落轻互动）",
  hasRecordableContent([{ body: "We need CE documents" }]) && !hasRecordableContent([{ body: "Hi" }, { body: "👍" }])
);
check(
  "轻互动句只报条数（没有编造空间）",
  greetingTouchSummary([{ body: "Hi" }, { body: "你好" }]) === "当日仅寒暄类互动（2 条），无具体业务内容，保持联系中"
);
check("占位句是用户定死的口径", sanitizeSummary("客户问价格 5000 USD") === "客户提到商务条件，需人工确认。" && sanitizeSummary("客户询问样品进度") === "客户询问样品进度");

/* ---------- 纯函数：两段式的第一段（基础跟进） ---------- */

{
  const basic = basicFollowupSummary(conversation());
  check(
    "基础跟进是纯统计：条数/收发/最后互动/补全说明，不含原文",
    basic.includes("当日互动 2 条（接收 1 · 发出 1）")
      && basic.includes("最后互动 03:10")
      && basic.includes(BASIC_PENDING_NOTE)
      && !basic.includes("Please quote")
  );
  check(
    "全寒暄的基础跟进退轻互动模板",
    basicFollowupSummary(conversation({ messages: [{ direction: "inbound", occurredAt: `${RUN_DATE}T01:00:00.000Z`, body: "Hi" }] }))
      === greetingTouchSummary([{ body: "Hi" }])
  );
}

/* ---------- 纯函数：提示词硬约束 ---------- */

{
  const prompt = buildSummaryPrompt({
    contactName: "Sofia",
    contactPhone: "+34612140788",
    day: RUN_DATE,
    messages: [{ direction: "inbound", occurredAt: `${RUN_DATE}T03:05:00.000Z`, body: "Please quote 500 units" }]
  });
  check("对话内容真的进了提示词", prompt.includes("Please quote 500 units") && prompt.includes(RUN_DATE));
  check(
    "禁令逐条在位：不复述商务数字、寒暄算轻互动、不调工具、只出 JSON",
    prompt.includes("NEVER repeat prices, discounts")
      && prompt.includes("worthRecording")
      && prompt.includes("lightweight touch")
      && prompt.includes("Do not call any tool")
      && prompt.includes("JSON")
  );
}

/* ---------- 服务行为 ---------- */

async function behaviorTests() {
  // 1. 命中客户：基础跟进**立即**写入（零 AI 延迟），pending=true，补全任务入队。
  {
    const previous = getStore();
    const rig1 = rig({ customers: [{ id: "c_1", whatsapp: "+4915112345678" }] });
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_1", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig1.deps);
      check("命中客户：写入一条跟进", result.outcomes[0]?.status === "written" && result.outcomes[0]?.kind === "customer", result.outcomes[0]);
      check("响应零 AI 延迟：engine=cli、pending=true、refineQueued=1",
        result.engine === "cli" && result.outcomes[0]?.pending === true && result.refineQueued === 1, result);
      check("跟进正文是基础统计且 marker 打头", String(rig1.store.customerActivities[0]?.content || "").startsWith("[WhatsApp 自动同步 2026-10-15]") && String(rig1.store.customerActivities[0]?.content || "").includes("当日互动 2 条"));
      check("站内信已发且带补全说明", result.notificationSent && rig1.store.internalMessages.length === 1 && String(rig1.store.internalMessages[0]?.content || "").includes("AI 进展总结后台补全中"));
    } finally {
      restoreStore(previous);
    }
  }

  // 2. 补全成功 → 改写**同一条**跟进（旅程即时性 + AI 补足的闭环）。
  {
    const previous = getStore();
    const rig2 = rig({ customers: [{ id: "c_1", whatsapp: "+4915112345678" }] });
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_2", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig2.deps);
      const activityId = result.outcomes[0]?.activityId || "";
      await rig2.drainRefines();
      check("补全后仍是同一条跟进", rig2.store.customerActivities.length === 1 && rig2.store.customerActivities[0]?.id === activityId);
      const refined = String(rig2.store.customerActivities[0]?.content || "");
      check("补全后的正文是 AI 摘要（marker 保留、基础说明被替换）",
        refined.startsWith("[WhatsApp 自动同步 2026-10-15]") && refined.includes("客户询问样品进度") && !refined.includes(BASIC_PENDING_NOTE), refined);
    } finally {
      restoreStore(previous);
    }
  }

  // 3. priorActivityId 重跑 → 改写同一条，不再新增。
  {
    const previous = getStore();
    const rig3 = rig({ customers: [{ id: "c_1", whatsapp: "+4915112345678" }] });
    try {
      rig3.store.customerActivities.push({ id: "ca_prior", customerId: "c_1", content: "旧内容", createdAt: new Date().toISOString() });
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_3", runDate: RUN_DATE, timezone: "Asia/Shanghai",
        conversations: [conversation({ priorActivityId: "ca_prior" })]
      }, rig3.deps);
      check("重跑走改写：不新增跟进", rig3.store.customerActivities.length === 1 && result.outcomes[0]?.activityId === "ca_prior", rig3.store.customerActivities.length);
      check("改写后的正文是本轮基础统计", String(rig3.store.customerActivities[0]?.content || "").includes("当日互动 2 条"));
    } finally {
      restoreStore(previous);
    }
  }

  // 4. 多客户命中 → 不猜、不写、报警。
  {
    const previous = getStore();
    const rig4 = rig({
      customers: [{ id: "c_1", whatsapp: "+4915112345678" }, { id: "c_2", whatsapp: "+4915112345678" }]
    });
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_4", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig4.deps);
      check("多命中：跳过不写", result.outcomes[0]?.status === "skipped" && result.outcomes[0]?.ambiguousWith === 2, result.outcomes[0]);
      check("多命中：没有写任何跟进或线索", rig4.store.customerActivities.length === 0 && rig4.leads.length === 0 && rig4.refineTasks.length === 0);
    } finally {
      restoreStore(previous);
    }
  }

  // 5. 0 命中 → 建线索（幂等键不带日期）；线索也进补全队列。
  {
    const previous = getStore();
    const rig5 = rig({ withLeadStore: true });
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_5", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig5.deps);
      check("未命中客户：建线索", result.outcomes[0]?.kind === "lead" && result.outcomes[0]?.status === "written", result.outcomes[0]);
      check("线索 externalId 不带日期", rig5.leads[0]?.externalId === "whatsapp:+4915112345678");
      check("线索正文带 marker 且是基础统计", String(rig5.leads[0]?.inquiryContent || "").startsWith("[WhatsApp 自动同步 2026-10-15]") && String(rig5.leads[0]?.inquiryContent || "").includes("当日互动 2 条"));
      check("线索补全任务入队（kind=lead）", result.refineQueued === 1 && rig5.refineTasks[0]?.kind === "lead");
      // 补全执行：改写 store.leads 里的 inquiryContent
      (rig5.store as any).leads.push({ id: "lead_1", inquiryContent: "旧" });
      await rig5.drainRefines();
      check("线索补全后 inquiryContent 被 AI 摘要替换", String((rig5.store as any).leads[0]?.inquiryContent || "").includes("客户询问样品进度"));
    } finally {
      restoreStore(previous);
    }
  }

  // 6. 全寒暄 → 轻互动终态（不进补全队列，没有编造空间）。
  {
    const previous = getStore();
    const rig6 = rig({ customers: [{ id: "c_1", whatsapp: "+4915112345678" }] });
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_6", runDate: RUN_DATE, timezone: "Asia/Shanghai",
        conversations: [conversation({ messages: [
          { direction: "inbound", occurredAt: `${RUN_DATE}T01:00:00.000Z`, body: "Hi" },
          { direction: "inbound", occurredAt: `${RUN_DATE}T01:01:00.000Z`, body: "你好" }
        ] })]
      }, rig6.deps);
      check("寒暄日落轻互动记录", result.outcomes[0]?.summary === "当日仅寒暄类互动（2 条），无具体业务内容，保持联系中", result.outcomes[0]);
      check("轻互动不进补全队列", result.refineQueued === 0 && rig6.refineTasks.length === 0 && result.outcomes[0]?.pending === false);
    } finally {
      restoreStore(previous);
    }
  }

  // 7. CLI 判「无需记录」→ 保留基础内容（不进任何占位）。
  {
    const previous = getStore();
    const rig7 = rig({ customers: [{ id: "c_1", whatsapp: "+4915112345678" }], cliRun: (async () => CLI_SKIP) as FollowupSyncDeps["cliRun"] });
    try {
      await runWhatsappFollowupSync(USER, {
        runId: "run_7", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig7.deps);
      await rig7.drainRefines();
      const content = String(rig7.store.customerActivities[0]?.content || "");
      check("引擎判无需补全：基础统计内容原样保留", content.includes("当日互动 2 条") && content.includes(BASIC_PENDING_NOTE), content);
    } finally {
      restoreStore(previous);
    }
  }

  // 8. CLI 失败 → 退 CRM 配置模型；模型成功照样补全。
  {
    const previous = getStore();
    const rig8 = rig({
      customers: [{ id: "c_1", whatsapp: "+4915112345678" }],
      cliRun: (async () => { throw new Error("本机 CLI 未登录"); }) as FollowupSyncDeps["cliRun"],
      aiCall: (async () => '{"summary":"客户询问样品进度并确认收件地址","worthRecording":true}') as FollowupSyncDeps["aiCall"]
    });
    try {
      await runWhatsappFollowupSync(USER, {
        runId: "run_8", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig8.deps);
      await rig8.drainRefines();
      check("CLI 失败退模型：跟进被模型摘要补全", String(rig8.store.customerActivities[0]?.content || "").includes("客户询问样品进度并确认收件地址"));
    } finally {
      restoreStore(previous);
    }
  }

  // 9. CLI 与模型全失败 → 基础内容保留、**不进 failures**（后台补全是 best-effort）。
  {
    const previous = getStore();
    const rig9 = rig({
      customers: [{ id: "c_1", whatsapp: "+4915112345678" }],
      cliRun: (async () => { throw new Error("CLI 超时"); }) as FollowupSyncDeps["cliRun"],
      aiCall: (async () => { throw new Error("外部模型 401"); }) as FollowupSyncDeps["aiCall"]
    });
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_9", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig9.deps);
      check("同步响应本身成功（基础写入不受后台影响）", result.outcomes[0]?.status === "written" && result.failures.length === 0, result.failures);
      await rig9.drainRefines();
      const content = String(rig9.store.customerActivities[0]?.content || "");
      check("双引擎失败：基础统计内容原样保留", content.includes("当日互动 2 条"), content);
    } finally {
      restoreStore(previous);
    }
  }

  // 10. 站内信幂等：同 runDate 重跑不再新增。
  {
    const previous = getStore();
    const rig10 = rig({ customers: [{ id: "c_1", whatsapp: "+4915112345678" }] });
    try {
      await runWhatsappFollowupSync(USER, {
        runId: "run_10", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig10.deps);
      await runWhatsappFollowupSync(USER, {
        runId: "run_11", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: [conversation()]
      }, rig10.deps);
      check("同一天重跑：站内信只一条", rig10.store.internalMessages.length === 1, rig10.store.internalMessages.length);
    } finally {
      restoreStore(previous);
    }
  }

  // 11. 没有会话 → 不发站内信、不产生任何写入。
  {
    const previous = getStore();
    const rig11 = rig();
    try {
      const result = await runWhatsappFollowupSync(USER, {
        runId: "run_12", runDate: RUN_DATE, timezone: "Asia/Shanghai", conversations: []
      }, rig11.deps);
      check("空批次：无明细、无站内信", result.outcomes.length === 0 && result.notificationSent === false && rig11.store.internalMessages.length === 0);
    } finally {
      restoreStore(previous);
    }
  }
}

await behaviorTests();

if (failures.length) {
  console.error(`\n✗ whatsapp-followup-sync 自测失败 ${failures.length} 项：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`✓ whatsapp-followup-sync 自测全通过（${passed} 项）`);
