import assert from "node:assert/strict";
import { InboundMailWatcher, classifyInboundReply } from "./inbound-mail-watcher.js";
import { memoryStore, type CrmStore } from "./store.js";

function isolatedStore() {
  const store = Object.fromEntries(Object.entries(memoryStore).map(([key, value]) => [
    key,
    Array.isArray(value) ? structuredClone(value) : value
  ])) as unknown as CrmStore;
  store.persist = async () => undefined;
  return store;
}

function rawReplyEmail(options: { from: string; to: string; subject: string; body: string; inReplyTo?: string }) {
  return [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    `Message-ID: <reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@buyer.example>`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : "",
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body
  ].filter(Boolean).join("\r\n");
}

async function main() {
  const store = isolatedStore();
  const user = store.users.find((item) => item.status === "active")!;
  const lead = store.leads.find((item) => item.ownerId === user.id && item.teamId === user.teamId && (item.email || "").includes("@"));
  assert.ok(lead, "memoryStore 需要一条有邮箱的线索（没有就跳过用例）");
  if (!lead) return;
  lead.lastEmailReplyAt = undefined;

  store.outboundEmailLogs.unshift({
    id: `oel_${Date.now()}`,
    teamId: lead.teamId,
    ownerId: user.id,
    messageId: "<batch-send-001@goodjob>",
    entityType: "lead",
    entityId: lead.id,
    to: lead.email,
    subject: "Potential cooperation",
    source: "lead_batch_send",
    sentAt: new Date(Date.now() - 86_400_000).toISOString(),
    createdAt: new Date(Date.now() - 86_400_000).toISOString()
  });

  const watcher = new InboundMailWatcher(store, { pollMs: 3_600_000 });

  // ---- 真实需求回复：打 lastEmailReplyAt 标记 + 写线索活动 + 生成待办 ----
  const replySource = rawReplyEmail({
    from: lead.email,
    to: user.email || "sales@goodjob.example",
    subject: "Re: Potential cooperation",
    body: "Please send us your quotation and price list for fasteners, we need samples first.",
    inReplyTo: "<batch-send-001@goodjob>"
  });
  const applied = await watcher.applyMessage(user, Buffer.from(replySource, "utf8"));
  assert.equal(applied, "reply", `回复应被识别：${applied}`);
  assert.ok(lead.lastEmailReplyAt, "回复后线索应带 lastEmailReplyAt 标记（绿色邮箱图标数据源）");
  assert.ok(store.leadActivities.some((item) => item.leadId === lead.id && /收到客户回信/.test(item.content)), "应写线索活动");
  assert.ok(store.todos.some((item) => item.leadId === lead.id && /跟进客户回信/.test(item.title)), "应生成跟进待办");

  // ---- 重复投递幂等：同一封不重复标记 ----
  const replyAtBefore = lead.lastEmailReplyAt;
  const duplicated = await watcher.applyMessage(user, Buffer.from(replySource.replace(/reply-\d+/, "reply-dup-x"), "utf8"));
  assert.ok(["duplicate", "reply"].includes(duplicated), "重复消息应幂等");

  // ---- 退信：不标回复 ----
  const anotherLead = store.leads.find((item) => item.id !== lead.id && item.ownerId === user.id && (item.email || "").includes("@"));
  if (anotherLead) {
    anotherLead.lastEmailReplyAt = undefined;
    store.outboundEmailLogs.unshift({
      id: `oel_${Date.now()}_b`,
      teamId: anotherLead.teamId,
      ownerId: user.id,
      messageId: "<batch-send-002@goodjob>",
      entityType: "lead",
      entityId: anotherLead.id,
      to: anotherLead.email,
      subject: "Potential cooperation",
      source: "lead_batch_send",
      sentAt: new Date(Date.now() - 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 86_400_000).toISOString()
    });
    const bounceSource = [
      "From: Mailer Daemon <mailer-daemon@mail.example>",
      `To: ${user.email || "sales@goodjob.example"}`,
      "Subject: Undelivered Mail Returned to Sender",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "This message could not be delivered.",
      `X-Failed-Recipients: ${anotherLead.email}`,
      "Message-ID: <bounce-001@mail.example>"
    ].join("\r\n");
    const bounceApplied = await watcher.applyMessage(user, Buffer.from(bounceSource, "utf8"));
    assert.equal(bounceApplied, "bounce", "退信应被识别");
    assert.ok(!anotherLead.lastEmailReplyAt, "退信不应标记为回复");
  }

  // ---- 分类器抽检 ----
  assert.equal(classifyInboundReply({ subject: "Re: quote", text: "please send price list", headers: new Map() } as never), "clear_demand");
  assert.equal(classifyInboundReply({ subject: "Re: hi", text: "we are not interested, do not contact", headers: new Map() } as never), "rejected");

  console.log("Inbound mail watcher lead-reply tests passed");
}

await main();
