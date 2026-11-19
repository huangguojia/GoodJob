/**
 * 开发信回复统计聚合（纯函数，无 IO）。
 *
 * 输入本人发送台账（outboundEmailLogs 的一个已过滤切片），输出：
 *   daily   —— 按发件人本地日历日的发送/回复/退信/打开/点击（范围补零，折线连续）
 *   monthly —— 按月同口径
 *   mailboxes —— 按发件邮箱汇总 + 营销邮箱风险预警
 *
 * 风险口径（营销邮箱被标记的前兆信号）：
 *   高危：退信率 ≥ 5%
 *   关注：退信率 ≥ 2% ／ 量 ≥ 30 封且打开率 < 5% ／ 量 ≥ 50 封且回复率 < 1% ／ 单日峰值 ≥ 40 封
 * 抽成纯函数是为了能离线红绿自测，不依赖数据库与时钟漂移。
 */
import type { OutboundEmailLog } from "./types.js";

export interface ReplyStatsBucket {
  key: string;
  sent: number;
  replied: number;
  bounced: number;
  opened: number;
  clicked: number;
  replyRate: number;
  bounceRate: number;
  openRate: number;
}

export interface ReplyStatsMailbox extends ReplyStatsBucket {
  lastSentAt: string;
  peakDay: string;
  peakDaySent: number;
  risk: "low" | "watch" | "high";
  riskReasons: string[];
}

export interface ReplyStatsResult {
  range: { days: number; from: string; to: string };
  totals: ReplyStatsBucket;
  daily: ReplyStatsBucket[];
  monthly: ReplyStatsBucket[];
  mailboxes: ReplyStatsMailbox[];
}

const pad = (value: number) => String(value).padStart(2, "0");

export function dayKeyOf(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : "";
}

function makeBucket(key: string): ReplyStatsBucket {
  return { key, sent: 0, replied: 0, bounced: 0, opened: 0, clicked: 0, replyRate: 0, bounceRate: 0, openRate: 0 };
}

function withRates(bucket: ReplyStatsBucket): ReplyStatsBucket {
  return {
    ...bucket,
    replyRate: bucket.sent ? Number((bucket.replied / bucket.sent).toFixed(4)) : 0,
    bounceRate: bucket.sent ? Number((bucket.bounced / bucket.sent).toFixed(4)) : 0,
    openRate: bucket.sent ? Number((bucket.opened / bucket.sent).toFixed(4)) : 0
  };
}

export function aggregateReplyStats(
  logs: OutboundEmailLog[],
  days: number,
  now: Date = new Date()
): ReplyStatsResult {
  const rangeDays = Math.min(Math.max(Math.floor(days) || 90, 7), 365);
  const fromMs = now.getTime() - rangeDays * 86_400_000;

  const daily = new Map<string, ReplyStatsBucket>();
  const monthly = new Map<string, ReplyStatsBucket>();
  const mailboxes = new Map<string, ReplyStatsBucket & { lastSentAt: string; peakDay: string; peakDaySent: number }>();
  const mailboxDayCounts = new Map<string, Map<string, number>>();

  for (const log of logs) {
    // 双保险：路由层已按范围过滤，这里再兜一次（纯函数自己也要守口径）
    const sentTime = new Date(log.sentAt || "").getTime();
    if (!Number.isFinite(sentTime) || sentTime < fromMs) continue;
    const day = dayKeyOf(log.sentAt, now);
    if (!day) continue;
    const sender = (log.senderEmail || "").trim().toLowerCase() || "（未记录发件邮箱）";
    const bucket = daily.get(day) || makeBucket(day);
    const monthBucket = monthly.get(day.slice(0, 7)) || makeBucket(day.slice(0, 7));
    const mailbox = mailboxes.get(sender) || { ...makeBucket(sender), lastSentAt: "", peakDay: "", peakDaySent: 0 };
    for (const target of [bucket, monthBucket, mailbox]) {
      target.sent += 1;
      if (log.repliedAt) target.replied += 1;
      if (log.bouncedAt) target.bounced += 1;
      if ((log.openCount || 0) > 0) target.opened += 1;
      if ((log.clickCount || 0) > 0) target.clicked += 1;
    }
    daily.set(day, bucket);
    monthly.set(day.slice(0, 7), monthBucket);
    if (log.sentAt > mailbox.lastSentAt) mailbox.lastSentAt = log.sentAt;
    mailboxes.set(sender, mailbox);
    const counts = mailboxDayCounts.get(sender) || new Map<string, number>();
    counts.set(day, (counts.get(day) || 0) + 1);
    mailboxDayCounts.set(sender, counts);
  }

  // 单邮箱单日峰值 → 营销模式信号
  for (const [sender, counts] of mailboxDayCounts) {
    const mailbox = mailboxes.get(sender)!;
    for (const [day, count] of counts) {
      if (count > mailbox.peakDaySent) {
        mailbox.peakDaySent = count;
        mailbox.peakDay = day;
      }
    }
  }

  const dailyRows: ReplyStatsBucket[] = [];
  for (let index = rangeDays - 1; index >= 0; index -= 1) {
    const key = dayKeyOf(new Date(now.getTime() - index * 86_400_000).toISOString(), now);
    dailyRows.push(withRates(daily.get(key) || makeBucket(key)));
  }

  const monthlyRows: ReplyStatsBucket[] = [];
  const cursor = new Date(now);
  cursor.setDate(1);
  const start = new Date(fromMs);
  start.setDate(1);
  while (cursor >= start) {
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`;
    monthlyRows.unshift(withRates(monthly.get(key) || makeBucket(key)));
    cursor.setMonth(cursor.getMonth() - 1);
  }
  for (const [key, bucket] of monthly) {
    if (!monthlyRows.some((row) => row.key === key)) {
      monthlyRows.push(withRates(bucket));
      monthlyRows.sort((a, b) => a.key.localeCompare(b.key));
    }
  }

  const totalsInput = makeBucket("total");
  for (const bucket of daily.values()) {
    totalsInput.sent += bucket.sent;
    totalsInput.replied += bucket.replied;
    totalsInput.bounced += bucket.bounced;
    totalsInput.opened += bucket.opened;
    totalsInput.clicked += bucket.clicked;
  }

  const mailboxRows: ReplyStatsMailbox[] = [...mailboxes.values()].map((mailbox) => {
    const rates = withRates(mailbox);
    const reasons: string[] = [];
    let risk: "low" | "watch" | "high" = "low";
    if (rates.bounceRate >= 0.05) {
      risk = "high";
      reasons.push(`退信率 ${(rates.bounceRate * 100).toFixed(1)}% ≥ 5%，收件方容易把该域名判为营销/垃圾`);
    } else if (rates.bounceRate >= 0.02) {
      if (risk === "low") risk = "watch";
      reasons.push(`退信率 ${(rates.bounceRate * 100).toFixed(1)}% 偏高（≥2%），建议放慢发送节奏`);
    }
    if (rates.sent >= 50 && rates.replyRate < 0.01) {
      if (risk === "low") risk = "watch";
      reasons.push(`已发 ${rates.sent} 封但回复率 ${(rates.replyRate * 100).toFixed(1)}% < 1%，内容或名单质量存疑`);
    }
    if (rates.sent >= 30 && rates.openRate < 0.05) {
      if (risk === "low") risk = "watch";
      reasons.push(`已发 ${rates.sent} 封但打开率 ${(rates.openRate * 100).toFixed(1)}% < 5%，邮件大概率进了垃圾箱或被网关拦截`);
    }
    if (mailbox.peakDaySent >= 40) {
      if (risk === "low") risk = "watch";
      reasons.push(`单日峰值 ${mailbox.peakDaySent} 封（${mailbox.peakDay}），发送模式像批量营销`);
    }
    return { ...rates, lastSentAt: mailbox.lastSentAt, peakDay: mailbox.peakDay, peakDaySent: mailbox.peakDaySent, risk, riskReasons: reasons };
  }).sort((a, b) => b.sent - a.sent);

  return {
    range: { days: rangeDays, from: new Date(fromMs).toISOString(), to: now.toISOString() },
    totals: withRates(totalsInput),
    daily: dailyRows,
    monthly: monthlyRows,
    mailboxes: mailboxRows
  };
}
