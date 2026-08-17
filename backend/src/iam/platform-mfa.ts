import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";
import type { SessionUser } from "../types.js";

type Queryable = mysql.Pool | mysql.PoolConnection;

function rows<T>(value: unknown) { return value as T[]; }
function one<T>(value: unknown) { return rows<T>(value)[0]; }
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }

function encryptionKey() {
  const configured = process.env.PLATFORM_MFA_ENCRYPTION_KEY?.trim();
  if (!configured || configured.length < 32) fail(503, "平台 MFA 加密密钥未配置或长度不足 32 个字符");
  return createHash("sha256").update(configured).digest();
}

function protect(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function reveal(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) fail(500, "平台 MFA 密钥存储格式无效");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

function base32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = "";
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) fail(400, "MFA 密钥格式无效");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function encodeBase32(value: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of value) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) encoded += alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return encoded;
}

function totp(secret: string, step = Math.floor(Date.now() / 30_000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

function matches(secret: string, supplied: string, usedStep?: number | null) {
  const current = Math.floor(Date.now() / 30_000);
  const normalized = supplied.trim();
  if (!/^\d{6}$/u.test(normalized)) return null;
  for (const delta of [-1, 0, 1]) {
    const step = current + delta;
    if (usedStep !== null && usedStep !== undefined && step <= usedStep) continue;
    if (totp(secret, step) === normalized) return step;
  }
  return null;
}

function recoveryCode() { return randomBytes(7).toString("hex").toUpperCase(); }
function hashRecoveryCode(code: string) { return createHash("sha256").update(code.trim().toUpperCase()).digest("hex"); }

export interface PlatformMfaService {
  status(actor: SessionUser): Promise<{ required: boolean; configured: boolean }>;
  createChallenge(actor: SessionUser): Promise<{ challengeId: string; expiresAt: string }>;
  enroll(actor: SessionUser): Promise<{ secret: string; otpauthUrl: string; recoveryCodes: string[] }>;
  confirmEnrollment(actor: SessionUser, code: string): Promise<void>;
  verifyChallenge(actor: SessionUser, challengeId: string, code: string): Promise<void>;
}

async function operator(pool: Queryable, actor: SessionUser) {
  const [result] = await pool.query(`SELECT id, mfa_required, status FROM platform_operators WHERE user_id = ? LIMIT 1`, [actor.id]);
  const row = one<{ id: string; mfa_required: boolean; status: string }>(result);
  if (!row || row.status !== "active") fail(403, "平台运维账号已停用");
  return row;
}

export function createPlatformMfaService(pool: mysql.Pool): PlatformMfaService {
  return {
    async status(actor) {
      const current = await operator(pool, actor);
      const [result] = await pool.query(`SELECT enabled FROM platform_operator_mfa WHERE operator_id = ? LIMIT 1`, [current.id]);
      return { required: Boolean(current.mfa_required), configured: Boolean(one<{ enabled: boolean }>(result)?.enabled) };
    },
    async createChallenge(actor) {
      const current = await operator(pool, actor);
      const [mfaResult] = await pool.query(`SELECT enabled FROM platform_operator_mfa WHERE operator_id = ? LIMIT 1`, [current.id]);
      if (!one<{ enabled: boolean }>(mfaResult)?.enabled) fail(409, "请先完成平台 MFA 注册");
      const challengeId = `mfac_${randomUUID().replaceAll("-", "")}`;
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await pool.query(`INSERT INTO platform_mfa_challenges (id, operator_id, expires_at, created_at) VALUES (?, ?, ?, NOW(3))`, [challengeId, current.id, expiresAt]);
      return { challengeId, expiresAt };
    },
    async enroll(actor) {
      const current = await operator(pool, actor);
      const [existingResult] = await pool.query(`SELECT enabled FROM platform_operator_mfa WHERE operator_id = ? LIMIT 1`, [current.id]);
      if (one<{ enabled: boolean }>(existingResult)?.enabled) fail(409, "平台 MFA 已启用，不能使用登录注册凭证重置");
      const secret = encodeBase32(randomBytes(20));
      const encrypted = protect(secret);
      await pool.query(`INSERT INTO platform_operator_mfa (operator_id, secret_encrypted, enabled, failed_attempts, created_at, updated_at)
        VALUES (?, ?, FALSE, 0, NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE secret_encrypted = VALUES(secret_encrypted), enabled = FALSE, failed_attempts = 0, locked_until = NULL, updated_at = NOW(3)`, [current.id, encrypted]);
      const recoveryCodes = Array.from({ length: 8 }, recoveryCode);
      await pool.query(`DELETE FROM platform_mfa_recovery_codes WHERE operator_id = ?`, [current.id]);
      for (const code of recoveryCodes) await pool.query(`INSERT INTO platform_mfa_recovery_codes (id, operator_id, code_hash, created_at) VALUES (?, ?, ?, NOW(3))`, [`mfrc_${randomUUID()}`, current.id, hashRecoveryCode(code)]);
      const label = encodeURIComponent(actor.email);
      return { secret, otpauthUrl: `otpauth://totp/GoodJob%20CRM:${label}?secret=${secret}&issuer=GoodJob%20CRM`, recoveryCodes };
    },
    async confirmEnrollment(actor, code) {
      const current = await operator(pool, actor);
      const [result] = await pool.query(`SELECT secret_encrypted FROM platform_operator_mfa WHERE operator_id = ? LIMIT 1`, [current.id]);
      const row = one<{ secret_encrypted: string }>(result);
      if (!row) fail(409, "请先获取 MFA 注册密钥");
      const step = matches(reveal(row.secret_encrypted), code);
      if (step === null) fail(401, "MFA 验证码错误");
      await pool.query(`UPDATE platform_operator_mfa SET enabled = TRUE, last_used_step = ?, failed_attempts = 0, locked_until = NULL, updated_at = NOW(3) WHERE operator_id = ?`, [step, current.id]);
    },
    async verifyChallenge(actor, challengeId, code) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const current = await operator(connection, actor);
        const [challengeResult] = await connection.query(`SELECT id, expires_at, used, failed_attempts FROM platform_mfa_challenges WHERE id = ? AND operator_id = ? FOR UPDATE`, [challengeId, current.id]);
        const challenge = one<{ id: string; expires_at: string; used: boolean; failed_attempts: number }>(challengeResult);
        if (!challenge || challenge.used || new Date(challenge.expires_at).getTime() <= Date.now()) fail(401, "MFA 登录挑战已失效");
        const [mfaResult] = await connection.query(`SELECT secret_encrypted, last_used_step, locked_until FROM platform_operator_mfa WHERE operator_id = ? AND enabled = TRUE LIMIT 1 FOR UPDATE`, [current.id]);
        const mfa = one<{ secret_encrypted: string; last_used_step: number | null; locked_until: string | null }>(mfaResult);
        if (!mfa) fail(409, "平台 MFA 尚未完成注册");
        if (mfa.locked_until && new Date(mfa.locked_until).getTime() > Date.now()) fail(429, "MFA 验证暂时锁定，请稍后重试");
        const [recoveryResult] = await connection.query(`SELECT id FROM platform_mfa_recovery_codes WHERE operator_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1`, [current.id, hashRecoveryCode(code)]);
        const recovery = one<{ id: string }>(recoveryResult);
        const step = recovery ? mfa.last_used_step : matches(reveal(mfa.secret_encrypted), code, mfa.last_used_step);
        if (!recovery && step === null) {
          const attempts = Number(challenge.failed_attempts || 0) + 1;
          await connection.query(`UPDATE platform_mfa_challenges SET failed_attempts = ? WHERE id = ?`, [attempts, challenge.id]);
          if (attempts >= 5) await connection.query(`UPDATE platform_operator_mfa SET locked_until = DATE_ADD(NOW(3), INTERVAL 10 MINUTE), failed_attempts = failed_attempts + 1 WHERE operator_id = ?`, [current.id]);
          await connection.commit();
          fail(401, "MFA 验证码错误");
        }
        if (recovery) await connection.query(`UPDATE platform_mfa_recovery_codes SET used_at = NOW(3) WHERE id = ?`, [recovery.id]);
        await connection.query(`UPDATE platform_mfa_challenges SET used = TRUE, used_at = NOW(3) WHERE id = ?`, [challenge.id]);
        await connection.query(`UPDATE platform_operator_mfa SET last_used_step = ?, failed_attempts = 0, locked_until = NULL, updated_at = NOW(3) WHERE operator_id = ?`, [step, current.id]);
        await connection.commit();
      } catch (error) {
        try { await connection.rollback(); } catch { /* connection may already be closed */ }
        throw error;
      } finally { connection.release(); }
    }
  };
}

export async function ensurePlatformMfaTables(pool: mysql.Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_operator_mfa (
    operator_id VARCHAR(90) PRIMARY KEY, secret_encrypted TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_used_step BIGINT NULL, failed_attempts INT NOT NULL DEFAULT 0, locked_until DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_platform_mfa_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_mfa_challenges (
    id VARCHAR(120) PRIMARY KEY, operator_id VARCHAR(90) NOT NULL, expires_at DATETIME(3) NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE, failed_attempts INT NOT NULL DEFAULT 0, used_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL, INDEX idx_platform_mfa_challenge_operator(operator_id, expires_at),
    CONSTRAINT fk_platform_mfa_challenge_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS platform_mfa_recovery_codes (
    id VARCHAR(120) PRIMARY KEY, operator_id VARCHAR(90) NOT NULL, code_hash CHAR(64) NOT NULL,
    used_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL, UNIQUE KEY uk_platform_mfa_recovery_code(operator_id, code_hash),
    CONSTRAINT fk_platform_mfa_recovery_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export const platformMfaTestHelpers = { protect, reveal, totp, matches, hashRecoveryCode };
