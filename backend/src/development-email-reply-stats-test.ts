// 开发信回复统计聚合回归：分桶、补零、回复率、风险预警阈值。
// 全部用固定时钟（2026-11-10 12:00 本地），不依赖真实时间。
import assert from "node:assert/strict";
import { aggregateReplyStats, dayKeyOf } from "./development-email-reply-stats.js";
import type { OutboundEmailLog } from "./types.js";

const NOW = new Date(2026, 10, 10, 12, 0, 0); // 2026-11-10 12:00 本地
const TODAY = dayKeyOf(NOW.toISOString(), NOW);
const YESTERDAY = dayKeyOf(new Date(NOW.getTime() - 86_400_000).toISOString(), NOW);

let seq = 0;
function makeLog(overrides: Partial<OutboundEmailLog> = {}): OutboundEmailLog {
  seq += 1;
  return {
    id: `oel_${seq}`,
    teamId: "t1",
    ownerId: "u1",
    messageId: `mid_${seq}`,
    entityType: "prospect_candidate",
    entityId: `cand_${seq}`,
    to: `buyer${seq}@buyer.example`,
    subject: "Hello",
    source: "test",
    senderEmail: "sales@longtec.com",
    sentAt: NOW.toISOString(),
    openCount: 0,
    clickCount: 0,
    ...overrides
  };
}

{
  const result = aggregateReplyStats([], 90, NOW);
  assert.equal(result.daily.length, 90, "90 天范围必须补零出 90 个桶");
  assert.equal(result.daily[89].key, TODAY);
  assert.equal(result.totals.sent, 0, "空台账总量为 0");
  assert.equal(result.monthly.length >= 4, true, "90 天至少覆盖 4 个月");
}

{
  const logs = [
    makeLog({ sentAt: NOW.toISOString(), repliedAt: NOW.toISOString(), openCount: 1 }),
    makeLog({ sentAt: NOW.toISOString(), openCount: 1 }),
    makeLog({ sentAt: new Date(NOW.getTime() - 86_400_000).toISOString(), bouncedAt: NOW.toISOString() }),
    makeLog({ sentAt: NOW.toISOString(), senderEmail: "  Sales@Longtec.com " })
  ];
  const result = aggregateReplyStats(logs, 7, NOW);
  const today = result.daily.find((row) => row.key === TODAY)!;
  const yesterday = result.daily.find((row) => row.key === YESTERDAY)!;
  assert.equal(today.sent, 3, "今天 3 封（大小写归一后的同一邮箱也算）");
  assert.equal(today.replied, 1);
  assert.equal(today.opened, 2);
  assert.equal(today.replyRate, 0.3333, "回复率四舍五入到 4 位小数");
  assert.equal(yesterday.sent, 1);
  assert.equal(yesterday.bounced, 1);

  const mailbox = result.mailboxes[0];
  assert.equal(mailbox.key, "sales@longtec.com", "发件邮箱归一化为小写");
  assert.equal(mailbox.sent, 4);
  assert.equal(mailbox.bounceRate, 0.25, "1/4 退信");
  assert.equal(mailbox.risk, "high", "退信率 25% ≥ 5% 必须高危");
  assert.ok(mailbox.riskReasons.some((r) => r.includes("退信率")), "高危原因必须写退信率");
}

{
  // 风险阈值边界：退信率 4.9% = 关注；量大低回复 = 关注；单日 40 封 = 关注
  const logs: OutboundEmailLog[] = [];
  for (let i = 0; i < 100; i += 1) {
    logs.push(makeLog({ sentAt: NOW.toISOString(), senderEmail: "a@x.com" })); // 无回复无退信
  }
  const result = aggregateReplyStats(logs, 30, NOW);
  assert.equal(result.mailboxes[0].risk, "watch", "100 封 0 回复必须进入关注");
  assert.ok(result.mailboxes[0].riskReasons.some((r) => r.includes("回复率")));

  const peak: OutboundEmailLog[] = [];
  for (let i = 0; i < 40; i += 1) {
    peak.push(makeLog({ sentAt: NOW.toISOString(), senderEmail: "b@x.com", repliedAt: NOW.toISOString() }));
  }
  const peakResult = aggregateReplyStats(peak, 30, NOW);
  assert.equal(peakResult.mailboxes[0].peakDaySent, 40);
  assert.equal(peakResult.mailboxes[0].risk, "watch", "单日 40 封像批量营销");
  assert.equal(peakResult.mailboxes[0].replyRate, 1, "全回复则不低回复预警");
}

{
  // 打开率口径：30 封 0 打开 = 关注（进垃圾箱）；29 封 0 打开不触发；30 封开 2 封（6.7%）不触发
  const deadLogs: OutboundEmailLog[] = [];
  for (let i = 0; i < 30; i += 1) deadLogs.push(makeLog({ sentAt: NOW.toISOString(), senderEmail: "d@x.com" }));
  const dead = aggregateReplyStats(deadLogs, 30, NOW);
  assert.equal(dead.mailboxes[0].risk, "watch", "30 封 0 打开必须进入关注");
  assert.ok(dead.mailboxes[0].riskReasons.some((r) => r.includes("打开率")), "原因必须写打开率");
  assert.equal(dead.mailboxes[0].openRate, 0);

  const below: OutboundEmailLog[] = [];
  for (let i = 0; i < 29; i += 1) below.push(makeLog({ sentAt: NOW.toISOString(), senderEmail: "e@x.com" }));
  assert.equal(aggregateReplyStats(below, 30, NOW).mailboxes[0].risk, "low", "样本不足 30 封不下打开率结论");

  const seen: OutboundEmailLog[] = [];
  for (let i = 0; i < 30; i += 1) seen.push(makeLog({ sentAt: NOW.toISOString(), senderEmail: "f@x.com", openCount: i < 2 ? 1 : 0 }));
  assert.equal(aggregateReplyStats(seen, 30, NOW).mailboxes[0].risk, "low", "打开率 6.7% ≥5% 不预警");
}

{
  // 边界下探：退信率 4.9%（49/1000）→ watch 不是 high
  const logs: OutboundEmailLog[] = [];
  for (let i = 0; i < 1000; i += 1) {
    logs.push(makeLog({ sentAt: NOW.toISOString(), senderEmail: "c@x.com", bouncedAt: i < 49 ? NOW.toISOString() : undefined }));
  }
  const result = aggregateReplyStats(logs, 30, NOW);
  assert.equal(result.mailboxes[0].risk, "watch", "4.9% 是关注档");
  assert.ok(result.mailboxes[0].riskReasons.some((r) => r.includes("偏高")));
}

{
  // 范围裁剪：范围外的信不计入
  const old = aggregateReplyStats([makeLog({ sentAt: new Date(NOW.getTime() - 200 * 86_400_000).toISOString() })], 90, NOW);
  assert.equal(old.totals.sent, 0, "200 天前的信不入 90 天统计");
}

console.log("开发信回复统计聚合回归：全部通过");
