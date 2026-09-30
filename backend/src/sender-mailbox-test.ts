import assert from "node:assert/strict";
import { decryptMailCredential, encryptMailCredential } from "./credential-security.js";
import {
  pickSenderMailbox,
  senderMailboxOverrides,
  toSenderMailboxView
} from "./sender-mailbox.js";
import type { SenderMailbox } from "./types.js";

// ---------------------------------------------------------------------------
// 发件邮箱池：轮换选箱 / 身份覆盖 / 视图脱敏 / 授权码加解密
//
// 全部纯函数，不连库、不发信。
// ---------------------------------------------------------------------------

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
}

function mailbox(overrides: Partial<SenderMailbox> = {}): SenderMailbox {
  return {
    id: "smb_1",
    ownerId: "u_admin",
    teamId: "europe",
    label: "",
    email: "a@company.com",
    fromName: "",
    smtpHost: "smtp.a.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: "a@company.com",
    smtpPassword: "auth-a",
    imapHost: "",
    imapPort: 993,
    imapUser: "",
    imapPassword: "",
    enabled: true,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides
  };
}

// ---- pickSenderMailbox：每 N 封换下一个 ----
{
  const pool = [
    mailbox({ id: "1", email: "a@x.com" }),
    mailbox({ id: "2", email: "b@x.com" }),
    mailbox({ id: "3", email: "c@x.com" })
  ];
  ok(pickSenderMailbox(pool, 0, 20)?.email === "a@x.com", "第 1 封用第 1 个邮箱");
  ok(pickSenderMailbox(pool, 19, 20)?.email === "a@x.com", "第 20 封仍用第 1 个邮箱（0 起）");
  ok(pickSenderMailbox(pool, 20, 20)?.email === "b@x.com", "第 21 封换第 2 个邮箱");
  ok(pickSenderMailbox(pool, 45, 20)?.email === "c@x.com", "第 46 封换第 3 个邮箱");
  ok(pickSenderMailbox(pool, 60, 20)?.email === "a@x.com", "发满一轮后回到第 1 个邮箱");
  ok(pickSenderMailbox(pool, 7, 20)?.email === "a@x.com", "every=20 时未满 20 封不换箱");
}

{
  const pool = [mailbox({ id: "1", enabled: false }), mailbox({ id: "2", email: "b@x.com" })];
  ok(pickSenderMailbox(pool, 0, 20)?.email === "b@x.com", "停用的邮箱不参与轮换");
  ok(pickSenderMailbox([], 0, 20) === null, "空池回落 null");
  ok(pickSenderMailbox(pool, 0, 0) === null, "every=0 表示不轮换");
  ok(pickSenderMailbox(pool, 0, -5) === null, "非法 every 不轮换");
  ok(pickSenderMailbox([mailbox()], 999, 1)?.email === "a@company.com", "单邮箱池永远用它");
}

// ---- senderMailboxOverrides：发件身份覆盖 + IMAP 回退 ----
{
  const overrides = senderMailboxOverrides(mailbox({ fromName: "Sales A" }));
  ok(overrides.outboundEmail === "a@company.com", "覆盖发件邮箱");
  ok(overrides.emailSenderName === "Sales A", "覆盖发件人名称");
  ok(overrides.smtpPassword === "auth-a", "带池内授权码");
  ok(overrides.imapUser === "a@company.com", "IMAP 账号缺省回落 SMTP 账号");
  ok(overrides.imapPassword === "auth-a", "IMAP 密码缺省回落 SMTP 授权码（已发送归档可用）");
  const withImap = senderMailboxOverrides(mailbox({ imapHost: "imap.b.com", imapUser: "b@x.com", imapPassword: "imap-pass" }));
  ok(withImap.imapHost === "imap.b.com" && withImap.imapUser === "b@x.com" && withImap.imapPassword === "imap-pass", "显式 IMAP 配置优先");
}

// ---- toSenderMailboxView：密码不回显 ----
{
  const view = toSenderMailboxView(mailbox({ imapPassword: "imap-pass" }));
  const json = JSON.stringify(view);
  ok(!json.includes("auth-a") && !json.includes("imap-pass"), "视图不泄漏任何授权码");
  ok(view.hasSmtpPassword === true && view.hasImapPassword === true, "视图暴露是否已设置授权码");
}

// ---- 授权码加解密（mail-v1 上下文绑定 id/team/kind）----
{
  const context = { id: "smb_x", teamId: "europe", kind: "smtp" as const };
  const encrypted = encryptMailCredential(context, "secret-pass");
  ok(encrypted.startsWith("mail-v1.") && encrypted !== "secret-pass", "授权码落库为密文");
  ok(decryptMailCredential(context, encrypted) === "secret-pass", "同上下文可解密");
  ok(decryptMailCredential(context, "plain-legacy") === "plain-legacy", "历史明文直通（迁移兼容）");
}

console.log(`sender-mailbox-test: ${passed} assertions passed`);
