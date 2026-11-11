import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { encryptMailCredential, decryptMailCredential } from "./credential-security.js";
import type { SenderMailbox } from "./types.js";

// ---------------------------------------------------------------------------
// 发件邮箱池：一个账号可登记多个 SMTP 发件邮箱；自动发信方案按
// 「每 N 封」轮换使用（见 server.ts 的 prospectOutreachBatchRuntime.send）。
// 独立表 + 独立仓库（不进 persistAll 全表重写体系），密码用 mail-v1 加密落库。
// ---------------------------------------------------------------------------

type MailboxCredentialContext = { id: string; teamId: string; kind: "smtp" | "imap" | "dkim" };

// ── 同步列表失效信号 ─────────────────────────────────────────────────────────
// 邮件中心的 IMAP 回流调度每分钟都要问一次「哪些邮箱开了同步」。空闲时这不是
// 必要开销：调度侧缓存列表，任何改变 sender_mailboxes 的写路径 bump 一次编号，
// 缓存即刻失效。跨进程兜底由调度侧 5 分钟 TTL 负责。
let mailboxSyncEpoch = 0;

export function bumpMailboxSyncCache() {
  mailboxSyncEpoch++;
}

export function getMailboxSyncEpoch() {
  return mailboxSyncEpoch;
}

export interface SenderMailboxInput {
  label: string;
  email: string;
  fromName?: string;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser: string;
  /** 明文授权码；update 时传空 = 保留原密码 */
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
  dkimDomain?: string;
  dkimSelector?: string;
  dkimPrivateKey?: string;
  /** 单账号每日外发上限（轮换时超过即跳过该账号），默认 50 */
  dailyLimit?: number;
  enabled?: boolean;
}

/** 对外视图：密码/私钥不回显，只给「是否已设置」 */
export type SenderMailboxView = Omit<SenderMailbox, "smtpPassword" | "imapPassword" | "dkimPrivateKey"> & {
  hasSmtpPassword: boolean;
  hasImapPassword: boolean;
  hasDkimPrivateKey: boolean;
};

export function toSenderMailboxView(mailbox: SenderMailbox): SenderMailboxView {
  const { smtpPassword, imapPassword, dkimPrivateKey, ...rest } = mailbox;
  return {
    ...rest,
    hasSmtpPassword: Boolean(smtpPassword),
    hasImapPassword: Boolean(imapPassword),
    hasDkimPrivateKey: Boolean(dkimPrivateKey)
  };
}

/** 按已发封数挑邮箱：第 k 封（0 起）落在第 floor(k / every) 组 → 轮流使用池内邮箱。
 *  skipEmails：当日额度用尽的邮箱集合（小写），轮换时直接跳过。 */
export function pickSenderMailbox(mailboxes: SenderMailbox[], sentSteps: number, every: number, skipEmails?: Set<string>): SenderMailbox | null {
  const pool = mailboxes.filter((row) => row.enabled && !(skipEmails && skipEmails.has(row.email.toLowerCase())));
  if (!pool.length) return null;
  // every <= 0 表示不轮换（调用方回落主发件邮箱）
  const interval = Math.floor(Number(every) || 0);
  if (interval <= 0) return null;
  const index = Math.floor(Math.max(0, sentSteps) / interval) % pool.length;
  return pool[index] || null;
}

export interface SenderMailboxUserOverride {
  outboundEmail: string;
  emailSenderName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  dkimDomain: string;
  dkimSelector: string;
  dkimPrivateKey: string;
}

/** 用池内邮箱覆盖账号发件身份（ownerId/teamId 等归属字段保持原账号，台账/触点仍记在账号名下） */
export function senderMailboxOverrides(mailbox: SenderMailbox): SenderMailboxUserOverride {
  return {
    outboundEmail: mailbox.email,
    emailSenderName: mailbox.fromName || "",
    smtpHost: mailbox.smtpHost,
    smtpPort: mailbox.smtpPort || 465,
    smtpSecure: mailbox.smtpSecure ?? true,
    smtpUser: mailbox.smtpUser,
    smtpPassword: mailbox.smtpPassword,
    imapHost: mailbox.imapHost || "",
    imapPort: mailbox.imapPort || 993,
    imapSecure: true,
    imapUser: mailbox.imapUser || mailbox.smtpUser,
    imapPassword: mailbox.imapPassword || mailbox.smtpPassword,
    dkimDomain: mailbox.dkimDomain || "",
    dkimSelector: mailbox.dkimSelector || "",
    dkimPrivateKey: mailbox.dkimPrivateKey || ""
  };
}

export function ensureSenderMailboxSchema(pool: Pool) {
  return pool.query(`CREATE TABLE IF NOT EXISTS sender_mailboxes (
    id VARCHAR(80) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    label VARCHAR(120) NOT NULL DEFAULT '',
    email VARCHAR(200) NOT NULL,
    from_name VARCHAR(120) NOT NULL DEFAULT '',
    smtp_host VARCHAR(200) NOT NULL,
    smtp_port INT NOT NULL DEFAULT 465,
    smtp_secure TINYINT(1) NOT NULL DEFAULT 1,
    smtp_user VARCHAR(200) NOT NULL,
    smtp_password TEXT NOT NULL,
    imap_host VARCHAR(200) NOT NULL DEFAULT '',
    imap_port INT NOT NULL DEFAULT 993,
    imap_user VARCHAR(200) NOT NULL DEFAULT '',
    imap_password TEXT NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    INDEX idx_sender_mailbox_owner(owner_id, enabled),
    INDEX idx_sender_mailbox_team(team_id)
  )`).then(async () => {
    // 邮件中心：收件同步状态与频率（同表扩列，避免第二套账号体系）
    await ensureSenderMailboxColumn(pool, "sync_enabled", "TINYINT(1) NOT NULL DEFAULT 1");
    await ensureSenderMailboxColumn(pool, "sync_interval_minutes", "INT NOT NULL DEFAULT 60");
    await ensureSenderMailboxColumn(pool, "last_sync_at", "DATETIME(3) NULL");
    await ensureSenderMailboxColumn(pool, "last_sync_status", "VARCHAR(20) NOT NULL DEFAULT ''");
    await ensureSenderMailboxColumn(pool, "last_sync_error", "TEXT");
    await ensureSenderMailboxColumn(pool, "last_sync_scanned", "INT NOT NULL DEFAULT 0");
    await ensureSenderMailboxColumn(pool, "last_sync_saved", "INT NOT NULL DEFAULT 0");
    await ensureSenderMailboxColumn(pool, "sync_cursor_json", "TEXT");
    // DKIM 签名（可选）：私钥落库为 mail-v1 密文（kind "dkim"）
    await ensureSenderMailboxColumn(pool, "dkim_domain", "VARCHAR(180) NOT NULL DEFAULT ''");
    await ensureSenderMailboxColumn(pool, "dkim_selector", "VARCHAR(63) NOT NULL DEFAULT ''");
    await ensureSenderMailboxColumn(pool, "dkim_private_key", "TEXT");
    await ensureSenderMailboxColumn(pool, "daily_limit", "INT NOT NULL DEFAULT 50");
  });
}

/** 补列幂等（并发迁移下另一个连接刚加过同一列视为成功） */
async function ensureSenderMailboxColumn(pool: Pool, column: string, definition: string) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'sender_mailboxes' AND column_name = ?`,
    [column]
  );
  if (Number((rows as Array<{ count: number }>)[0]?.count || 0) > 0) return;
  try {
    await pool.query(`ALTER TABLE sender_mailboxes ADD COLUMN ${column} ${definition}`);
  } catch (error: any) {
    if (error?.errno !== 1060 && error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
}

function readSyncCursor(raw: unknown) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

class MysqlSenderMailboxRepository {
  constructor(private readonly pool: Pool) {}

  private decrypt(row: Record<string, unknown>): SenderMailbox {
    const context = { id: String(row.id || ""), teamId: String(row.team_id || "") };
    return {
      id: String(row.id || ""),
      ownerId: String(row.owner_id || ""),
      teamId: String(row.team_id || ""),
      label: String(row.label || ""),
      email: String(row.email || ""),
      fromName: String(row.from_name || ""),
      smtpHost: String(row.smtp_host || ""),
      smtpPort: Number(row.smtp_port || 465),
      smtpSecure: Boolean(row.smtp_secure),
      smtpUser: String(row.smtp_user || ""),
      smtpPassword: decryptMailCredential({ ...context, kind: "smtp" }, String(row.smtp_password || "")),
      imapHost: String(row.imap_host || ""),
      imapPort: Number(row.imap_port || 993),
      imapUser: String(row.imap_user || ""),
      imapPassword: decryptMailCredential({ ...context, kind: "imap" }, String(row.imap_password || "")),
      dkimDomain: String(row.dkim_domain || ""),
      dkimSelector: String(row.dkim_selector || ""),
      dkimPrivateKey: row.dkim_private_key
        ? decryptMailCredential({ ...context, kind: "dkim" }, String(row.dkim_private_key))
        : "",
      dailyLimit: Number(row.daily_limit || 50),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
      syncEnabled: row.sync_enabled === undefined || row.sync_enabled === null ? true : Boolean(row.sync_enabled),
      syncIntervalMinutes: Number(row.sync_interval_minutes || 60) || 60,
      lastSyncAt: row.last_sync_at instanceof Date ? row.last_sync_at.toISOString() : String(row.last_sync_at || ""),
      lastSyncStatus: String(row.last_sync_status || ""),
      lastSyncError: String(row.last_sync_error || ""),
      lastSyncScanned: Number(row.last_sync_scanned || 0),
      lastSyncSaved: Number(row.last_sync_saved || 0),
      syncCursor: readSyncCursor(row.sync_cursor_json) as SenderMailbox["syncCursor"]
    };
  }

  async list(ownerId: string, teamId: string): Promise<SenderMailbox[]> {
    const [rows] = await this.pool.query(
      "SELECT * FROM sender_mailboxes WHERE owner_id = ? AND team_id = ? ORDER BY created_at ASC, id ASC",
      [ownerId, teamId]
    );
    return (rows as Record<string, unknown>[]).map((row) => this.decrypt(row));
  }

  async get(ownerId: string, teamId: string, id: string): Promise<SenderMailbox | null> {
    const [rows] = await this.pool.query(
      "SELECT * FROM sender_mailboxes WHERE id = ? AND owner_id = ? AND team_id = ?",
      [id, ownerId, teamId]
    );
    const row = (rows as Record<string, unknown>[])[0];
    return row ? this.decrypt(row) : null;
  }

  async create(ownerId: string, teamId: string, input: SenderMailboxInput): Promise<SenderMailbox> {
    const now = new Date();
    const mailbox: SenderMailbox = {
      id: `smb_${randomUUID()}`,
      ownerId,
      teamId,
      label: input.label.trim(),
      email: input.email.trim(),
      fromName: (input.fromName || "").trim(),
      smtpHost: input.smtpHost.trim(),
      smtpPort: Number(input.smtpPort || 465),
      smtpSecure: input.smtpSecure ?? true,
      smtpUser: input.smtpUser.trim(),
      smtpPassword: input.smtpPassword || "",
      imapHost: (input.imapHost || "").trim(),
      imapPort: Number(input.imapPort || 993),
      imapUser: (input.imapUser || "").trim(),
      imapPassword: input.imapPassword || "",
      dkimDomain: (input.dkimDomain || "").trim(),
      dkimSelector: (input.dkimSelector || "").trim(),
      dkimPrivateKey: input.dkimPrivateKey || "",
      dailyLimit: Math.max(1, Math.min(500, Number(input.dailyLimit || 50))),
      enabled: input.enabled ?? true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const smtpContext: MailboxCredentialContext = { id: mailbox.id, teamId, kind: "smtp" };
    const imapContext: MailboxCredentialContext = { id: mailbox.id, teamId, kind: "imap" };
    const dkimContext: MailboxCredentialContext = { id: mailbox.id, teamId, kind: "dkim" };
    await this.pool.execute(
      `INSERT INTO sender_mailboxes
        (id, owner_id, team_id, label, email, from_name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
         imap_host, imap_port, imap_user, imap_password, dkim_domain, dkim_selector, dkim_private_key, daily_limit, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mailbox.id, ownerId, teamId, mailbox.label, mailbox.email, mailbox.fromName,
        mailbox.smtpHost, mailbox.smtpPort, mailbox.smtpSecure ? 1 : 0, mailbox.smtpUser,
        encryptMailCredential(smtpContext, mailbox.smtpPassword),
        mailbox.imapHost, mailbox.imapPort, mailbox.imapUser,
        encryptMailCredential(imapContext, mailbox.imapPassword),
        mailbox.dkimDomain || "", mailbox.dkimSelector || "",
        mailbox.dkimPrivateKey ? encryptMailCredential(dkimContext, mailbox.dkimPrivateKey) : "",
        mailbox.dailyLimit || 50,
        mailbox.enabled ? 1 : 0, now, now
      ]
    );
    bumpMailboxSyncCache();
    return mailbox;
  }

  /** update：密码字段传 undefined = 保留；传空串 = 清空；传值 = 覆盖 */
  async update(ownerId: string, teamId: string, id: string, input: Partial<SenderMailboxInput>): Promise<SenderMailbox | null> {
    const existing = await this.get(ownerId, teamId, id);
    if (!existing) return null;
    const next: SenderMailbox = {
      ...existing,
      label: input.label !== undefined ? input.label.trim() : existing.label,
      email: input.email !== undefined ? input.email.trim() : existing.email,
      fromName: input.fromName !== undefined ? (input.fromName || "").trim() : existing.fromName,
      smtpHost: input.smtpHost !== undefined ? input.smtpHost.trim() : existing.smtpHost,
      smtpPort: input.smtpPort !== undefined ? Number(input.smtpPort || 465) : existing.smtpPort,
      smtpSecure: input.smtpSecure !== undefined ? Boolean(input.smtpSecure) : existing.smtpSecure,
      smtpUser: input.smtpUser !== undefined ? input.smtpUser.trim() : existing.smtpUser,
      smtpPassword: input.smtpPassword !== undefined ? input.smtpPassword : existing.smtpPassword,
      imapHost: input.imapHost !== undefined ? (input.imapHost || "").trim() : existing.imapHost,
      imapPort: input.imapPort !== undefined ? Number(input.imapPort || 993) : existing.imapPort,
      imapUser: input.imapUser !== undefined ? (input.imapUser || "").trim() : existing.imapUser,
      imapPassword: input.imapPassword !== undefined ? input.imapPassword : existing.imapPassword,
      dkimDomain: input.dkimDomain !== undefined ? (input.dkimDomain || "").trim() : existing.dkimDomain || "",
      dkimSelector: input.dkimSelector !== undefined ? (input.dkimSelector || "").trim() : existing.dkimSelector || "",
      dkimPrivateKey: input.dkimPrivateKey !== undefined ? input.dkimPrivateKey : existing.dkimPrivateKey || "",
      dailyLimit: input.dailyLimit !== undefined
        ? Math.max(1, Math.min(500, Number(input.dailyLimit || 50)))
        : existing.dailyLimit || 50,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled,
      updatedAt: new Date().toISOString()
    };
    const smtpContext: MailboxCredentialContext = { id, teamId, kind: "smtp" };
    const imapContext: MailboxCredentialContext = { id, teamId, kind: "imap" };
    const dkimContext: MailboxCredentialContext = { id, teamId, kind: "dkim" };
    await this.pool.execute(
      `UPDATE sender_mailboxes SET
        label = ?, email = ?, from_name = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_password = ?,
        imap_host = ?, imap_port = ?, imap_user = ?, imap_password = ?, dkim_domain = ?, dkim_selector = ?, dkim_private_key = ?,
        daily_limit = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?`,
      [
        next.label, next.email, next.fromName, next.smtpHost, next.smtpPort, next.smtpSecure ? 1 : 0, next.smtpUser,
        encryptMailCredential(smtpContext, next.smtpPassword),
        next.imapHost, next.imapPort, next.imapUser,
        encryptMailCredential(imapContext, next.imapPassword),
        next.dkimDomain || "", next.dkimSelector || "",
        next.dkimPrivateKey ? encryptMailCredential(dkimContext, next.dkimPrivateKey) : "",
        next.dailyLimit || 50,
        next.enabled ? 1 : 0, new Date(), id, ownerId, teamId
      ]
    );
    bumpMailboxSyncCache();
    return next;
  }

  async remove(ownerId: string, teamId: string, id: string): Promise<boolean> {
    const [result] = await this.pool.execute(
      "DELETE FROM sender_mailboxes WHERE id = ? AND owner_id = ? AND team_id = ?",
      [id, ownerId, teamId]
    );
    const removed = Number((result as { affectedRows?: number }).affectedRows || 0) > 0;
    if (removed) bumpMailboxSyncCache();
    return removed;
  }
}

let senderMailboxRepository: MysqlSenderMailboxRepository | null = null;

export function setSenderMailboxRepository(repository: MysqlSenderMailboxRepository | null) {
  senderMailboxRepository = repository;
}

export function getSenderMailboxRepository() {
  return senderMailboxRepository;
}

export function createMysqlSenderMailboxRepository(pool: Pool) {
  return new MysqlSenderMailboxRepository(pool);
}
