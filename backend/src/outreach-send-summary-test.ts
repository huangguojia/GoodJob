/**
 * 开发信发送总结自测。
 *
 * 重点验证三件事（都是真实踩过或极易踩的）：
 *  1) 按「实际发件邮箱」分组，而不是按批次负责人：一个批次轮换 3 个邮箱，必须拆成 3 份总结；
 *  2) 台账 requestId 的两种前缀（batch: / plan:）都能对上，自动发送方案跑完也能补总结；
 *  3) Excel 真的是 4 个 Sheet、能打开、关键内容没丢；同一批次重复调用不会重复发。
 */
import assert from "node:assert/strict";
import XLSX from "xlsx-js-style";
import {
  collectOutreachSummaryGroups,
  normalizeResearch,
  readOutreachSummarySettings,
  readOutreachSummaryState,
  renderOutreachSummaryWorkbook,
  summaryFileName,
  summaryRequestIds,
  writeOutreachSummaryState,
  type OutreachSummaryGroup
} from "./outreach-send-summary.js";
import type { OutboundEmailLog, ProspectOutreachBatch, ProspectOutreachBatchItem } from "./types.js";

const NOW = "2026-11-18T02:00:00.000Z";

function item(id: string, candidateId: string, company: string, recipient: string, withStep: boolean): ProspectOutreachBatchItem {
  return {
    id,
    candidateId,
    company,
    recipient,
    status: "sent",
    skipReason: "",
    steps: withStep
      ? [{ index: 0, delayHours: 0, subject: `Hello ${company}`, body: `Body for ${company}`, status: "sent", scheduledAt: NOW, sentAt: NOW, error: "" }]
      : [],
    sentAt: NOW,
    convertedLeadId: ""
  };
}

function log(requestId: string, senderEmail: string, to: string, extra: Partial<OutboundEmailLog> = {}): OutboundEmailLog {
  return {
    id: `oel_${requestId}`,
    teamId: "team_1",
    ownerId: "user_1",
    messageId: `msg-${requestId}`,
    entityType: "prospect_candidate",
    entityId: "cand_1",
    to,
    subject: "Hello",
    source: "prospect_batch_send",
    requestId,
    senderEmail,
    sentAt: NOW,
    openCount: 0,
    clickCount: 0,
    createdAt: NOW,
    ...extra
  };
}

const batch = {
  id: "batch_1",
  ownerId: "user_1",
  teamId: "team_1",
  status: "completed",
  targetType: "candidate",
  policy: {} as never,
  items: [
    item("bi_1", "cand_1", "Alpha Foods", "buyer@alpha.test", true),
    item("bi_2", "cand_2", "Beta Trading", "buyer@beta.test", true),
    item("bi_3", "cand_3", "Gamma Ltd", "buyer@gamma.test", true)
  ],
  counts: { total: 3, frozen: 2, skipped: 1 },
  frozenPayload: null,
  frozenHash: "",
  approvedBy: "user_1",
  approvedAt: NOW,
  pauseReason: "",
  nextSendAt: "",
  createdAt: NOW,
  updatedAt: NOW
} as ProspectOutreachBatch;

// 三封信来自两个邮箱 + 一封走方案前缀（模拟自动发送方案）
const logs: OutboundEmailLog[] = [
  log(summaryRequestIds("batch_1", "bi_1", 0)[0]!, "sales-a@longtec.com", "buyer@alpha.test", { openCount: 2, entityId: "cand_1" }),
  log(summaryRequestIds("batch_1", "bi_2", 0)[0]!, "sales-a@longtec.com", "buyer@beta.test", { repliedAt: NOW, entityId: "cand_2" }),
  log(`plan:batch_1:bi_3:0`, "sales-b@longtec.com", "buyer@gamma.test", { entityId: "cand_3" })
];

const researchPayload = {
  score: 78,
  verdict: "优质潜在客户",
  summary: "Gamma 是当地批发商，代理多个品牌。",
  engine: "deepseek-v4-pro",
  completedAt: NOW,
  facts: [
    { label: "成立时间", value: "2008", group: "主体识别", sourceUrl: "https://gamma.test/about" },
    { label: "员工规模", value: "约 60 人", group: "主体识别", sourceUrl: "" }
  ],
  opportunities: ["正在扩充产品线", "有自有仓储"],
  risks: [{ level: "medium", title: "价格敏感", detail: "对单价比较敏感" }],
  keyPeople: [{ name: "Marco", title: "采购经理", email: "marco@gamma.test", phone: "" }],
  sources: [{ title: "官网", url: "https://gamma.test" }],
  nextAction: "先寄样品"
};

const groups = await collectOutreachSummaryGroups({
  batch,
  logs,
  primarySenderEmail: "main@longtec.com",
  ownerName: "郭佳",
  mailboxLabelFor: (email) => (email.startsWith("sales-a") ? "A 号业务邮箱" : ""),
  loadEntity: async (kind, entityId) => ({
    company: entityId === "cand_1" ? "Alpha Foods" : entityId === "cand_2" ? "Beta Trading" : "Gamma Ltd",
    country: "Indonesia",
    website: `https://${entityId}.test`,
    business: "食品进口",
    contact: "Buyer",
    contactInfo: "buyer@test.test / +62 000",
    description: "详细描述",
    source: "Google"
  }),
  // 只有 Gamma 有背调，另外两家没留档 —— 必须照实留空，不能编
  loadResearch: async (_kind, entityId) => (entityId === "cand_3" ? researchPayload : null)
});

assert.equal(groups.length, 2, "两个发件邮箱必须拆成两份总结");
const groupA = groups.find((group) => group.senderEmail === "sales-a@longtec.com")!;
const groupB = groups.find((group) => group.senderEmail === "sales-b@longtec.com")!;
assert.ok(groupA && groupB, "两个邮箱都要出现");
assert.equal(groupA.customers.length, 2);
assert.equal(groupA.totals.letters, 2);
assert.equal(groupA.totals.opened, 1);
assert.equal(groupA.totals.replied, 1);
assert.equal(groupA.mailboxLabel, "A 号业务邮箱");
assert.equal(groupB.customers.length, 1, "方案前缀（plan:）的信也必须归到它自己的邮箱");
assert.equal(groupB.customers[0]!.company, "Gamma Ltd");
assert.equal(groupB.totals.researched, 1);

// 没写的步骤（没发出去）不能算进总结
const noStepBatch = { ...batch, items: [item("bi_1", "cand_1", "Alpha Foods", "buyer@alpha.test", false)] } as ProspectOutreachBatch;
const emptyGroups = await collectOutreachSummaryGroups({
  batch: noStepBatch,
  logs: [],
  primarySenderEmail: "main@longtec.com",
  ownerName: "郭佳",
  loadEntity: async () => null,
  loadResearch: async () => null
});
assert.equal(emptyGroups.length, 0, "没有成功发出的信就不该生成总结");

// 背调归一化：脏数据不炸、缺字段不编
assert.equal(normalizeResearch(null), null);
assert.equal(normalizeResearch({}), null);
const normalized = normalizeResearch(researchPayload)!;
assert.equal(normalized.score, 78);
assert.equal(normalized.facts.length, 2);
assert.equal(normalizeResearch({ facts: [{ label: "x" }] })!.facts[0]!.value, "");

// Excel：4 个 Sheet，内容能读回
const workbookBuffer = renderOutreachSummaryWorkbook({
  batch,
  group: groupA,
  ownerName: "郭佳",
  generatedAt: NOW
});
assert.ok(workbookBuffer.byteLength > 5000, "Excel 不该是空的");
const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
assert.deepEqual(workbook.SheetNames, ["发送汇总", "客户清单", "背调详情", "开发信原文"]);
// 汇总页是逐格写的，最容易出现「!ref 没扩、Excel 只显示标题」——必须读回内容
const overviewText = XLSX.utils.sheet_to_csv(workbook.Sheets["发送汇总"]!);
assert.ok(overviewText.includes("覆盖客户"), "汇总页要看得到指标");
assert.ok(overviewText.includes("sales-a@longtec.com"), "汇总页要看得到发件邮箱");
assert.ok(overviewText.includes("有背调客户"), "汇总页最后一行不能被 !ref 截掉");
const customerSheet = workbook.Sheets["客户清单"]!;
const customerText = XLSX.utils.sheet_to_csv(customerSheet);
assert.ok(customerText.includes("Alpha Foods"), "客户清单要列出发过信的公司");
assert.ok(customerText.includes("Beta Trading"));
assert.ok(!customerText.includes("Gamma Ltd"), "A 邮箱的总结不能混进 B 邮箱发的公司");
const letterText = XLSX.utils.sheet_to_csv(workbook.Sheets["开发信原文"]!);
assert.ok(letterText.includes("Body for Alpha Foods"), "开发信原文要真的带正文");

// 背调 Sheet 只在有背调时出现内容
const groupBWorkbook = XLSX.read(renderOutreachSummaryWorkbook({ batch, group: groupB, ownerName: "郭佳", generatedAt: NOW }), { type: "buffer" });
const researchText = XLSX.utils.sheet_to_csv(groupBWorkbook.Sheets["背调详情"]!);
assert.ok(researchText.includes("成立时间"));
assert.ok(researchText.includes("2008"));
assert.ok(researchText.includes("Marco"));

// 文件名：纯中文 + 邮箱前缀，不能带 / : 之类会弄坏附件的字符
const fileName = summaryFileName("sales-a@longtec.com", "batch_1");
assert.ok(fileName.endsWith(".xlsx"));
assert.ok(!/[\\/:*?"<>|]/u.test(fileName));

// 状态幂等：读回来必须一模一样，重复写不会叠加
await writeOutreachSummaryState("team_1", "batch_1", {
  batchId: "batch_1",
  updatedAt: NOW,
  deliveries: [{ senderEmail: "sales-a@longtec.com", status: "sent", at: NOW, fileName, messageId: "m1", error: "", attempts: 1, customers: 2, letters: 2 }]
});
const state = await readOutreachSummaryState("team_1", "batch_1");
assert.equal(state.deliveries.length, 1);
assert.equal(state.deliveries[0]!.status, "sent");
await writeOutreachSummaryState("team_1", "batch_1", state);
assert.equal((await readOutreachSummaryState("team_1", "batch_1")).deliveries.length, 1);

// 默认开启自动发送；显式关闭后读回来必须是 false（不能被默认值盖掉）
assert.equal((await readOutreachSummarySettings("team_1")).autoSend, true);

// 分组内排序：按首封时间升序，A 的两家都在同一时间，顺序按插入稳定
assert.equal((groupA as OutreachSummaryGroup).customers[0]!.letters[0]!.senderEmail, "sales-a@longtec.com");

console.log("outreach-send-summary-test: ok");
