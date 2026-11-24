import assert from "node:assert/strict";
import { app } from "./server.js";
import { setSenderMailboxRepository } from "./sender-mailbox.js";
import { getStore } from "./store.js";
import type { CompanyProfile, Lead, SenderMailbox } from "./types.js";

// ---------------------------------------------------------------------------
// 开发信「指定发件邮箱」：自动流可以从发件邮箱池里选一个身份发信。
//
// 覆盖四件事：
// 1) 不在本人邮箱池里的地址必须拒绝（不能拿别人的邮箱冒发）
// 2) 已停用的邮箱必须拒绝
// 3) 合法邮箱发信后台账的 senderEmail 必须记的是那个邮箱（不是账号主邮箱）
// 4) 单邮箱日限额用尽后拒绝，而不是继续压着这个邮箱发
//
// NODE_ENV=test 下 nodemailer 走 streamTransport，不会真实外发。
// ---------------------------------------------------------------------------

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start development email sender test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  return { response, json: await response.json() };
}

function mailboxFixture(overrides: Partial<SenderMailbox> = {}): SenderMailbox {
  const now = new Date().toISOString();
  return {
    id: "smb_test_a",
    ownerId: "",
    teamId: "",
    label: "Sales A",
    email: "sales-a@goodjob.example.test",
    fromName: "Sales A",
    smtpHost: "smtp.goodjob.example.test",
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: "sales-a@goodjob.example.test",
    smtpPassword: "test-password",
    imapHost: "",
    imapPort: 993,
    imapUser: "",
    imapPassword: "",
    enabled: true,
    dailyLimit: 50,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

const store = getStore();
let lead: Lead | null = null;
let insertedProfile = false;
let profileRef: CompanyProfile | null = null;
let originalProfile: CompanyProfile | null = null;
let ownerMailOriginal: Record<string, unknown> | null = null;

try {
  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "shirley@goodjob.com", password: "goodjob123" })
  });
  assert.equal(login.response.ok, true, JSON.stringify(login.json));
  const token = String(login.json.token || "");
  const headers = { authorization: `Bearer ${token}` };
  const owner = store.users.find((item) => item.email === "shirley@goodjob.com");
  assert.ok(owner, "种子账号必须存在");

  const profile = store.companyProfiles.find((item) => item.teamId === owner.teamId);
  if (profile) {
    profileRef = profile;
    originalProfile = structuredClone(profile);
    Object.assign(profile, {
      companyName: "GoodJob Test Exporter",
      productSummary: "Industrial weighing systems",
      website: "https://goodjob.example.test"
    });
  } else {
    insertedProfile = true;
    store.companyProfiles.push({
      teamId: owner.teamId,
      companyName: "GoodJob Test Exporter",
      productSummary: "Industrial weighing systems",
      website: "https://goodjob.example.test",
      address: "",
      phone: "",
      email: "",
      updatedBy: owner.id,
      updatedAt: new Date().toISOString()
    });
  }

  ownerMailOriginal = {
    outboundEmail: owner.outboundEmail,
    smtpHost: owner.smtpHost,
    smtpUser: owner.smtpUser,
    smtpPassword: owner.smtpPassword,
    smtpPort: owner.smtpPort,
    smtpSecure: owner.smtpSecure
  };
  Object.assign(owner, {
    outboundEmail: owner.outboundEmail || "primary@goodjob.example.test",
    smtpHost: owner.smtpHost || "smtp.goodjob.example.test",
    smtpUser: owner.smtpUser || "primary@goodjob.example.test",
    smtpPassword: owner.smtpPassword || "test-password",
    smtpPort: owner.smtpPort ?? 465,
    smtpSecure: owner.smtpSecure ?? true
  });

  lead = {
    id: `lead-sender-test-${Date.now()}`,
    company: "Sender Identity Test GmbH",
    contact: "Purchasing",
    country: "DE",
    email: "buyer@sender-identity.example.test",
    phone: "",
    wechat: "",
    source: "prospect_conversion",
    intent: "medium",
    stage: "待跟进",
    status: "new",
    ownerId: owner.id,
    teamId: owner.teamId,
    estimatedAmount: 0,
    nextFollowAt: "",
    lastActivityAt: "",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: "prospect_conversion",
    sourceCampaign: "sender-test",
    externalId: "sender-test",
    sourceUrl: "",
    createdAt: new Date().toISOString()
  };
  store.leads.push(lead);

  const poolMailbox = mailboxFixture({ ownerId: owner.id, teamId: owner.teamId });
  const disabledMailbox = mailboxFixture({
    id: "smb_test_off",
    ownerId: owner.id,
    teamId: owner.teamId,
    email: "sales-off@goodjob.example.test",
    smtpUser: "sales-off@goodjob.example.test",
    enabled: false
  });
  const limitedMailbox = mailboxFixture({
    id: "smb_test_limit",
    ownerId: owner.id,
    teamId: owner.teamId,
    email: "sales-limit@goodjob.example.test",
    smtpUser: "sales-limit@goodjob.example.test",
    dailyLimit: 1
  });
  setSenderMailboxRepository({
    list: async (ownerId: string, teamId: string) =>
      [poolMailbox, disabledMailbox, limitedMailbox].filter((row) => row.ownerId === ownerId && row.teamId === teamId)
  } as never);

  /** 发一封信；返回接口结果 */
  async function send(senderEmail: string | undefined, requestId: string) {
    assert.ok(lead);
    return request("/api/development-email/send", {
      method: "POST",
      headers,
      body: JSON.stringify({
        entityType: "lead",
        entityId: lead.id,
        to: lead.email,
        subject: "Weighing systems for your warehouse",
        body: "Dear team, sharing one capability that fits your new warehouse line.",
        requestId,
        ...(senderEmail ? { senderEmail } : {})
      })
    });
  }

  // ---- 1) 不在本人邮箱池里的地址：必须拒绝 ----
  {
    const result = await send("stranger@other.example.test", "sender-test-unknown");
    assert.equal(result.response.status, 400, JSON.stringify(result.json));
    assert.match(String(result.json.message || ""), /发件邮箱池/u, "拒绝原因必须指向邮箱池，而不是含糊的发送失败");
  }

  // ---- 2) 已停用的邮箱：必须拒绝 ----
  {
    const result = await send(disabledMailbox.email, "sender-test-disabled");
    assert.equal(result.response.status, 400, JSON.stringify(result.json));
    assert.match(String(result.json.message || ""), /已停用/u);
  }

  // ---- 3) 合法邮箱：发信成功，台账记的是这个邮箱 ----
  {
    const requestId = "sender-test-ok";
    const result = await send(poolMailbox.email, requestId);
    assert.equal(result.response.ok, true, JSON.stringify(result.json));
    const log = store.outboundEmailLogs.find((row) => row.ownerId === owner.id && row.requestId === requestId);
    assert.ok(log, "发信必须落台账");
    assert.equal(log.senderEmail, poolMailbox.email, "台账的 senderEmail 必须是池内邮箱，而不是账号主邮箱");
    assert.equal(log.dispatchStatus, "sent");
  }

  // ---- 4) 单邮箱日限额用尽：拒绝，并说明上限 ----
  {
    store.outboundEmailLogs.push({
      ...store.outboundEmailLogs.find((row) => row.requestId === "sender-test-ok")!,
      id: "oel_sender_test_limit",
      requestId: "sender-test-limit-seed",
      messageId: "sender-test-limit-seed@goodjob-crm.local",
      senderEmail: limitedMailbox.email,
      sentAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    const result = await send(limitedMailbox.email, "sender-test-limit");
    assert.equal(result.response.status, 400, JSON.stringify(result.json));
    assert.match(String(result.json.message || ""), /上限/u, "必须说明是单邮箱日限额拦下的");
  }

  console.log("Development email sender identity tests passed");
} finally {
  setSenderMailboxRepository(null);
  if (lead) {
    const index = store.leads.findIndex((row) => row.id === lead!.id);
    if (index >= 0) store.leads.splice(index, 1);
  }
  if (originalProfile && profileRef) Object.assign(profileRef, originalProfile);
  if (insertedProfile) {
    const index = store.companyProfiles.findIndex((row) => row.companyName === "GoodJob Test Exporter");
    if (index >= 0) store.companyProfiles.splice(index, 1);
  }
  const owner = store.users.find((item) => item.email === "shirley@goodjob.com");
  if (owner && ownerMailOriginal) Object.assign(owner, ownerMailOriginal);
  server.close();
}
