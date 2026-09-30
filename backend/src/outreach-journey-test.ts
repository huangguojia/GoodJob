import assert from "node:assert/strict";
import {
  buildOutreachJourney,
  buildOutreachJourneyDraft,
  buildOutreachResearchLinks,
  listOutreachJourneyOverview,
  resolveOutreachJourneyEntity,
  setBackgroundResearchRepository
} from "./outreach-journey.js";
import { developmentEmailAngles } from "./development-email-skill.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { Lead, OutboundEmailLog, ProspectTouchpoint, WebsiteOpportunity } from "./types.js";

// ---------------------------------------------------------------------------
// 开发信过程档案：阶段推导 / 聚合 / 草稿生成
//
// 全部在内存 store 上跑，不连库、不发信。
// ---------------------------------------------------------------------------

const OWNER = "u_admin";
const TEAM = "europe";

function isolatedStore(): CrmStore {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.websiteOpportunities = [];
  store.prospectTouchpoints = [];
  store.outboundEmailLogs = [];
  store.leads = [];
  store.customers = [];
  store.prospectOutreachBatches = [];
  store.prospectOutreachPlans = [];
  store.persist = async () => undefined;
  return store;
}

function makeCandidate(overrides: Partial<WebsiteOpportunity> = {}): WebsiteOpportunity {
  const now = new Date().toISOString();
  return {
    id: "cand_1",
    ownerId: OWNER,
    teamId: TEAM,
    company: "Tanaka Scale Vietnam",
    business: "weighing equipment",
    country: "Vietnam",
    contact: "Kenji",
    contactInfo: "info@tanaka-scale-vietnam.com",
    website: "https://tanaka-scale-vietnam.com",
    status: "new",
    createdAt: now,
    ...overrides
  } as WebsiteOpportunity;
}

function makeSendTouchpoint(overrides: Partial<ProspectTouchpoint> = {}): ProspectTouchpoint {
  const at = overrides.occurredAt || new Date().toISOString();
  return {
    id: `ptp_${Math.random().toString(36).slice(2, 8)}`,
    teamId: TEAM,
    ownerId: OWNER,
    prospectCandidateId: "cand_1",
    channel: "email",
    direction: "outbound",
    contactValue: "info@tanaka-scale-vietnam.com",
    subject: "Potential cooperation",
    content: "Hello from GoodJob",
    requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: at,
    createdAt: at,
    eventType: "send",
    ...overrides
  };
}

function makeReplyTouchpoint(overrides: Partial<ProspectTouchpoint> = {}): ProspectTouchpoint {
  const at = overrides.occurredAt || new Date().toISOString();
  return {
    id: `ptp_${Math.random().toString(36).slice(2, 8)}`,
    teamId: TEAM,
    ownerId: OWNER,
    prospectCandidateId: "cand_1",
    channel: "email",
    direction: "inbound",
    contactValue: "info@tanaka-scale-vietnam.com",
    subject: "Re: Potential cooperation",
    content: "Please send your catalogue",
    requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: at,
    createdAt: at,
    eventType: "reply",
    replyClassification: "interested_nurture",
    ...overrides
  };
}

function makeEmailLog(overrides: Partial<OutboundEmailLog> = {}): OutboundEmailLog {
  const at = overrides.sentAt || new Date().toISOString();
  return {
    id: `oel_${Math.random().toString(36).slice(2, 8)}`,
    teamId: TEAM,
    ownerId: OWNER,
    messageId: `<msg_${Math.random().toString(36).slice(2, 8)}@goodjob>`,
    entityType: "prospect_candidate",
    entityId: "cand_1",
    to: "info@tanaka-scale-vietnam.com",
    subject: "Potential cooperation",
    source: "prospect_batch_send",
    dispatchStatus: "sent",
    sentAt: at,
    openCount: 0,
    clickCount: 0,
    createdAt: at,
    ...overrides
  };
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function main() {
  let checked = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    checked++;
  };

  // ── 1. 未接触：没有任何触达时是「未接触」，且允许发送 ──────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.key === "not_contacted", "无触达记录时阶段应为 not_contacted");
    check(view?.stage.canSend === true, "未接触且邮箱有效时应允许发送");
    check(view?.emails.length === 0, "未接触不应有发送历史");
    check(view?.stats.outboundCount === 0, "未接触已发数应为 0");
  }

  // ── 2. 已发首触：一封已发出 → first_touch_sent ───────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    store.outboundEmailLogs = [makeEmailLog({ sentAt: daysAgo(1) })];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.key === "first_touch_sent", "发出 1 封后阶段应为 first_touch_sent");
    check(view?.emails.length === 1, "发送历史应聚合出 1 封");
    check(view?.emails[0]?.sourceLabel === "手动批次（搜客候选）", "来源标签应被翻译成人话");
  }

  // ── 3. 跟进中：两封以上且无回复 → following_up ───────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    store.outboundEmailLogs = [
      makeEmailLog({ sentAt: daysAgo(5) }),
      makeEmailLog({ sentAt: daysAgo(1) })
    ];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.key === "following_up", "发出 2 封后阶段应为 following_up");
    check(view?.emails.length === 2, "发送历史应聚合出 2 封");
    check(view?.emails[0]?.index === 1 && view?.emails[1]?.index === 2, "发送历史应按时间排序并编号");
  }

  // ── 4. 已回复·可推进 ────────────────────────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    store.outboundEmailLogs = [makeEmailLog({ sentAt: daysAgo(3) })];
    store.prospectTouchpoints = [
      makeSendTouchpoint({ occurredAt: daysAgo(3) }),
      makeReplyTouchpoint({ occurredAt: daysAgo(1), replyClassification: "clear_demand" })
    ];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.key === "replied_interested", "收到明确需求回复后阶段应为 replied_interested");
    check(view?.stage.canSend === true, "可推进阶段仍允许继续发信");
    check(view?.replies.length === 1, "回复记录应被聚合");
    check(view?.replies[0]?.classificationLabel === "明确需求", "回复分类应翻译成中文标签");
  }

  // ── 5. 明确拒绝：停止发送并给出阻断原因 ─────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    store.outboundEmailLogs = [makeEmailLog({ sentAt: daysAgo(3) })];
    store.prospectTouchpoints = [
      makeReplyTouchpoint({ occurredAt: daysAgo(1), replyClassification: "unsubscribed" })
    ];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.key === "replied_negative", "要求退订时阶段应为 replied_negative");
    check(view?.stage.canSend === false, "已拒绝的客户不能再发开发信");
    check(Boolean(view?.stage.blockReason), "不可发送时必须给出阻断原因");
  }

  // ── 6. 退信：联系方式无效，阻断发送 ─────────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    store.outboundEmailLogs = [makeEmailLog({ sentAt: daysAgo(3), bouncedAt: daysAgo(3) })];
    store.prospectTouchpoints = [
      makeReplyTouchpoint({ occurredAt: daysAgo(3), eventType: "bounce", replyClassification: "bounced" })
    ];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.key === "bounced", "退信时阶段应为 bounced");
    check(view?.stage.canSend === false, "退信后不能再往同一地址发");
    check(view?.stats.bounceCount === 1, "退信次数应被统计");
  }

  // ── 7. 无邮箱：即使阶段允许发送也要阻断 ─────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate({ contactInfo: "", lastDevelopmentEmailTo: "" })];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.stage.canSend === false, "没有邮箱时不能发送");
    check(/邮箱/u.test(view?.stage.blockReason || ""), "阻断原因应说明是邮箱缺失");
  }

  // ── 8. 客户 → 线索 → 候选的链路关联 ─────────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate({ leadId: "lead_1", status: "synced" })];
    store.leads = [{
      id: "lead_1",
      company: "Tanaka Scale Vietnam",
      contact: "Kenji",
      country: "Vietnam",
      email: "info@tanaka-scale-vietnam.com",
      convertedCustomerId: "cust_1",
      externalId: "cand_1",
      ownerId: OWNER,
      teamId: TEAM
    } as unknown as Lead];
    store.customers = [{
      id: "cust_1",
      company: "Tanaka Scale Vietnam",
      contact: "Kenji",
      country: "Vietnam",
      email: "info@tanaka-scale-vietnam.com",
      ownerId: OWNER,
      teamId: TEAM,
      stage: "新客户",
      amount: 0,
      health: 80,
      nextReminder: "",
      wecomBound: false,
      billingName: "",
      billingAddress: "",
      documentContact: "",
      defaultPortDischarge: "",
      defaultIncoterm: "",
      defaultPaymentTerm: ""
    } as unknown as CustomerLike];
    // 线索阶段发出的信（prospectCandidateId 为空、leadId 有值）必须能被候选档案看到；
    // 两条链路（触达记录 / 投递台账）指向同一封信，时间戳必须完全一致才能合并成一条
    const leadStageSentAt = daysAgo(2);
    store.prospectTouchpoints = [
      makeSendTouchpoint({ prospectCandidateId: "", leadId: "lead_1", occurredAt: leadStageSentAt })
    ];
    store.outboundEmailLogs = [
      makeEmailLog({ entityType: "lead", entityId: "lead_1", source: "lead_batch_send", sentAt: leadStageSentAt })
    ];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.emails.length === 1, "线索阶段发出的信也应归到同一客户的档案里");
    check(view?.stage.key === "converted", "已转线索/客户时阶段应为 converted");
    check(view?.entity.customerId === "cust_1", "应能从候选一路解析到客户");
    check(view?.entity.convertedToCustomer === true, "应标记已转化");

    // 反向：从客户入口能看到同样的轨迹
    const fromCustomer = await buildOutreachJourney(store, "customer", "cust_1");
    check(fromCustomer?.emails.length === 1, "从客户入口应看到同一批发送记录");
    check(fromCustomer?.entity.candidateId === "cand_1", "从客户应能回溯到原始候选");
  }

  // ── 9. 草稿生成：按阶段与封数选择模板 ───────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate({ contact: "待维护" })];
    const entity = resolveOutreachJourneyEntity(store, "prospect_candidate", "cand_1")!;
    const first = buildOutreachJourneyDraft(entity, {
      key: "not_contacted", label: "", tone: "", description: "", nextStepLabel: "", canSend: true,
      blockReason: "", outboundCount: 0, lastSentAt: "", lastReplyAt: "", lastReplyClassification: "", lastReplyLabel: ""
    }, []);
    check(first.stepIndex === 1, "未接触时草稿应是第 1 封");
    check(/^Hi there,/u.test(first.body), "联系人字段是占位值时不能写出「Hi 待维护」");
    check(first.tips.length > 0, "草稿应带发送建议");

    const second = buildOutreachJourneyDraft(entity, {
      key: "first_touch_sent", label: "", tone: "", description: "", nextStepLabel: "", canSend: true,
      blockReason: "", outboundCount: 1, lastSentAt: "", lastReplyAt: "", lastReplyClassification: "", lastReplyLabel: ""
    }, [{
      messageId: "m1", index: 1, subject: "Potential cooperation", bodyPreview: "", body: "", recipient: "",
      sentAt: daysAgo(1), source: "", sourceLabel: "", batchId: "", batchName: "", dispatchStatus: "sent",
      dispatchError: "", openCount: 0, clickCount: 0, firstOpenedAt: "", lastOpenedAt: "", lastClickedAt: "",
      repliedAt: "", bouncedAt: ""
    }] as never);
    check(second.stepIndex === 2, "已发首触时草稿应是第 2 封");
    check(second.subject.startsWith("Re:"), "第 2 封应复用上一封主题作为回复线索");

    const third = buildOutreachJourneyDraft(entity, {
      key: "following_up", label: "", tone: "", description: "", nextStepLabel: "", canSend: true,
      blockReason: "", outboundCount: 2, lastSentAt: "", lastReplyAt: "", lastReplyClassification: "", lastReplyLabel: ""
    }, [] as never);
    check(third.stepIndex === 3, "跟进中时草稿应是第 3 封");
    check(/close|closing the loop/iu.test(third.body), "第 3 封应是收尾信");
  }

  // ── 10. 明细列表：跨主体聚合与阶段统计 ──────────────────────────
  {
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    store.outboundEmailLogs = [makeEmailLog({ sentAt: daysAgo(1) })];
    const overview = await listOutreachJourneyOverview(store, { ownerId: OWNER });
    check(overview.items.length === 1, "明细列表应聚合出 1 个客户");
    check(overview.items[0]?.stageKey === "first_touch_sent", "明细行的阶段应与档案一致");
    check(overview.summary.byStage.first_touch_sent === 1, "阶段统计应正确计数");
    check(overview.summary.total === 1, "总数应正确");

    const otherOwner = await listOutreachJourneyOverview(store, { ownerId: "u_other" });
    check(otherOwner.items.length === 0, "不属于该业务员的记录不应出现在他的明细里");
  }

  // ── 11. 未配置背调仓库时不能崩 ──────────────────────────────────
  {
    setBackgroundResearchRepository(null);
    const store = isolatedStore();
    store.websiteOpportunities = [makeCandidate()];
    const view = await buildOutreachJourney(store, "prospect_candidate", "cand_1");
    check(view?.research.latest === null, "没有背调仓库时应返回空背调而不是抛错");
    check(Array.isArray(view?.research.history), "背调历史应始终是数组");
    check(Array.isArray(view?.research.links) && view?.research.links.length === 0, "没有背调仓库时关联应为空数组");
    check(view?.research.coverage.total === 0 && view?.research.coverage.linked === 0, "空仓库时覆盖率应全为 0");
  }

  // ── 12. 背调 × 开发信关联：按写信时刻配对 + 角度引用验证 ─────────
  {
    const recordA = {
      id: "bgr_a", teamId: TEAM, ownerId: OWNER, entityType: "lead", entityId: "lead_1",
      company: "Tanaka Scale Vietnam", country: "Vietnam", score: 72,
      verdict: "有明确采购需求", summary: "They run OIML certified weighing equipment and import load cells.",
      engine: "ai_search", crmOnly: false,
      payloadJson: JSON.stringify({
        facts: [
          { label: "Industry", value: "weighing equipment" },
          { label: "Certification", value: "OIML certification" }
        ],
        opportunities: ["expanding weighing equipment lines"]
      }),
      createdAt: daysAgo(10), createdBy: OWNER
    };
    const recordB = {
      ...recordA,
      id: "bgr_b", score: 85, verdict: "高意向",
      summary: "Procurement of platform scales; no certification mentioned.",
      payloadJson: JSON.stringify({ facts: [{ label: "Demand", value: "platform scales" }] }),
      createdAt: daysAgo(2)
    };
    // 用与生产完全相同的角度提取器，把 recordA 会产出的关键词先算出来，再拼一封"真的引用了"的信
    const anglesA = developmentEmailAngles(
      "Industry weighing equipment Certification OIML certification",
      "expanding weighing equipment lines",
      recordA.summary
    );
    const citedKeyword = anglesA[0]?.keyword || "weighing equipment";

    const emails = [
      { index: 1, messageId: "m0", subject: "First hello", sentAt: daysAgo(15), body: "Hello there.", bodyPreview: "Hello there." },
      {
        index: 2, messageId: "m1", subject: `${citedKeyword} partnership`, sentAt: daysAgo(8),
        body: `We noticed your focus on ${citedKeyword} and would like to introduce our range.`,
        bodyPreview: ""
      },
      { index: 3, messageId: "m2", subject: "Checking in", sentAt: daysAgo(1), body: "Hello again, any update on my previous note?", bodyPreview: "" }
    ] as never;

    const links = buildOutreachResearchLinks(emails as never, [recordB as never, recordA as never]);
    check(links.length === 3, "每封已发信都应有一条关联记录");
    check(links[0]?.linked === false, "早于第一次背调的信应标记为无背调依据");
    check(links[1]?.linked === true && links[1]?.researchId === "bgr_a", "第 2 封应配对写信时刻最近的一次背调（A）");
    check(links[1]?.researchAgeDays === 2, "背调新鲜度应为 2 天");
    check(links[1]?.factsCount === 2, "应统计到 A 留档的 2 条结构化事实");
    check(
      (links[1]?.angles.length || 0) === anglesA.length && anglesA.length > 0,
      "角度集应与写信蓝图同一提取器同口径"
    );
    check(links[1]?.verified === true, "正文/主题里引用了角度关键词时应判定为已验证");
    check(
      links[1]?.angles.every((angle) => angle.used === (angle.keyword === citedKeyword)) ?? false,
      "只有真正写进信里的角度才应标记 used"
    );
    check(links[2]?.researchId === "bgr_b", "第 3 封应配对最新的背调（B）而不是 A");
    check(links[2]?.verified === false, "没引用任何角度的信不应误判为已验证");

    // 集成：档案聚合里 links / coverage 一并输出
    const store = isolatedStore();
    store.leads = [{
      id: "lead_1", teamId: TEAM, ownerId: OWNER, company: "Tanaka Scale Vietnam",
      contact: "Kenji", email: "info@tanaka-scale-vietnam.com", country: "Vietnam", deletedAt: ""
    }] as never;
    store.outboundEmailLogs = [
      makeEmailLog({ entityType: "lead", entityId: "lead_1", sentAt: daysAgo(8) })
    ];
    setBackgroundResearchRepository({
      list: async () => [recordA as never, recordB as never]
    } as never);
    const view = await buildOutreachJourney(store, "lead", "lead_1");
    check(view?.research.links.length === 1, "档案聚合应输出关联明细");
    check(view?.research.links[0]?.researchId === "bgr_a", "写信时刻（8 天前）在 B 之后之前 → 应配对当时的 A 而不是最新的 B");
    check(view?.research.coverage.total === 1 && view?.research.coverage.linked === 1, "覆盖率应正确计数");
    setBackgroundResearchRepository(null);
  }

  console.log(JSON.stringify({ ok: true, checked }, null, 2));
}

type CustomerLike = { id: string };

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
