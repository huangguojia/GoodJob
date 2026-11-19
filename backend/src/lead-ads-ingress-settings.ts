/**
 * 广告表单（Facebook Lead Ads 中转）接入配置。
 *
 * 与官网询盘入口（website-lead-ingress-settings.ts）同思路，但**独立密钥、独立文件、独立 AAD**：
 * 两个入口的密文不能互换，避免一个入口被攻破后横向复用另一个人口。
 *
 * 配置文件落在仓库内 `.data/private/`（600），不进版本控制；token 明文永不出现在日志 / 命令行参数里。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LeadAdsIngressSettings {
  schemaVersion: 1;
  enabled: boolean;
  /** 线索归属账号；留空时由路由按 lead.create 权限挑选第一个可用账号。 */
  ownerId: string;
  token: string;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_DIRECTORY = join(PROJECT_ROOT, ".data", "private");
const SETTINGS_PATH = join(PRIVATE_DIRECTORY, "lead-ads-ingress.enc.json");
const KEY_PATH = join(PRIVATE_DIRECTORY, "lead-ads-ingress.key");
const AAD = Buffer.from("goodjob-lead-ads-ingress:v1", "utf8");
const EMPTY_SETTINGS: LeadAdsIngressSettings = {
  schemaVersion: 1,
  enabled: false,
  ownerId: "",
  token: ""
};

let encryptionKey: Buffer | null = null;
let testSettings: LeadAdsIngressSettings | null = null;
let cached: { settings: LeadAdsIngressSettings; mtimeMs: number } | null = null;

function normalizeSettings(value: unknown): LeadAdsIngressSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lead Ads ingress settings must be an object.");
  }
  const candidate = value as Partial<LeadAdsIngressSettings>;
  const ownerId = String(candidate.ownerId || "").trim();
  const token = String(candidate.token || "").trim();
  const enabled = candidate.enabled === true;
  if (ownerId && !/^[A-Za-z0-9_-]{2,100}$/u.test(ownerId)) throw new Error("Lead Ads ingress owner ID is invalid.");
  if (token && (token.length < 24 || token.length > 200)) throw new Error("Lead Ads ingress token must contain 24 to 200 characters.");
  if (enabled && !token) throw new Error("Enabled Lead Ads ingress requires a token.");
  return { schemaVersion: 1, enabled, ownerId, token };
}

function atomicPrivateWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* 临时文件可能根本没建成 */ }
    throw error;
  }
}

function privateKey() {
  if (encryptionKey) return encryptionKey;
  try {
    const existing = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
    if (existing.length !== 32) throw new Error("Lead Ads ingress key must contain exactly 32 bytes.");
    chmodSync(KEY_PATH, 0o600);
    encryptionKey = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    encryptionKey = randomBytes(32);
    atomicPrivateWrite(KEY_PATH, `${encryptionKey.toString("base64")}\n`);
  }
  return encryptionKey;
}

function encrypt(settings: LeadAdsIngressSettings) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", privateKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decrypt(envelope: Record<string, unknown>) {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported Lead Ads ingress settings format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", privateKey(), Buffer.from(String(envelope.iv || ""), "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ""), "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ""), "base64")),
    decipher.final()
  ]);
  return normalizeSettings(JSON.parse(plaintext.toString("utf8")));
}

export function readLeadAdsIngressSettings(): LeadAdsIngressSettings {
  if (testSettings) return structuredClone(testSettings);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(SETTINGS_PATH).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_SETTINGS);
    throw error;
  }
  if (cached && cached.mtimeMs === mtimeMs) return structuredClone(cached.settings);
  try {
    const envelope = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    chmodSync(SETTINGS_PATH, 0o600);
    const settings = decrypt(envelope);
    cached = { settings, mtimeMs };
    return structuredClone(settings);
  } catch (error) {
    throw new Error(`Lead Ads ingress settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeLeadAdsIngressSettings(value: unknown): LeadAdsIngressSettings {
  const normalized = normalizeSettings(value);
  atomicPrivateWrite(SETTINGS_PATH, `${JSON.stringify(encrypt(normalized), null, 2)}\n`);
  cached = null;
  return normalized;
}

export function generateLeadAdsIngressToken() {
  return `gjla_${randomBytes(24).toString("base64url")}`;
}

/** 常数时间比较；两侧先做 sha256，长度差异不会泄露信息。 */
export function leadAdsTokenMatches(expected: string, supplied: string) {
  if (!expected || !supplied) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(left, right);
}

/** 仅供测试：注入 / 清空配置，避免读写真实私有文件。 */
export function setLeadAdsIngressSettingsForTest(value: LeadAdsIngressSettings | null) {
  testSettings = value ? normalizeSettings(value) : null;
  cached = null;
}
