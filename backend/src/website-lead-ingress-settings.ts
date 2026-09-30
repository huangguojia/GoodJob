import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WebsiteLeadIngressKey {
  id: string;
  secret: string;
}

export interface WebsiteLeadIngressSettings {
  schemaVersion: 1;
  enabled: boolean;
  ownerId: string;
  current: WebsiteLeadIngressKey | null;
  previous: WebsiteLeadIngressKey | null;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_DIRECTORY = join(PROJECT_ROOT, ".data", "private");
const SETTINGS_PATH = join(PRIVATE_DIRECTORY, "website-lead-ingress.enc.json");
const KEY_PATH = join(PRIVATE_DIRECTORY, "website-lead-ingress.key");
const AAD = Buffer.from("goodjob-website-lead-ingress:v1", "utf8");
const EMPTY_SETTINGS: WebsiteLeadIngressSettings = {
  schemaVersion: 1,
  enabled: false,
  ownerId: "",
  current: null,
  previous: null
};

let encryptionKey: Buffer | null = null;
let testSettings: WebsiteLeadIngressSettings | null = null;

function normalizedKey(value: unknown): WebsiteLeadIngressKey | null {
  if (value === null || value === undefined || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ingress signing key must be an object.");
  const candidate = value as Partial<WebsiteLeadIngressKey>;
  const id = String(candidate.id || "").trim();
  const secret = String(candidate.secret || "");
  if (!/^[A-Za-z0-9_-]{2,80}$/u.test(id)) throw new Error("Ingress key ID is invalid.");
  if (secret.length < 32 || secret.length > 512) throw new Error("Ingress signing secret must contain 32 to 512 characters.");
  return { id, secret };
}

function normalizeSettings(value: unknown): WebsiteLeadIngressSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ingress settings must be an object.");
  const candidate = value as Partial<WebsiteLeadIngressSettings>;
  const ownerId = String(candidate.ownerId || "").trim();
  const current = normalizedKey(candidate.current);
  const previous = normalizedKey(candidate.previous);
  const enabled = candidate.enabled === true;
  if (ownerId && !/^[A-Za-z0-9_-]{2,100}$/u.test(ownerId)) throw new Error("Ingress owner ID is invalid.");
  if (previous && current?.id === previous.id) throw new Error("Current and previous ingress key IDs must differ.");
  if (enabled && (!ownerId || !current)) throw new Error("Enabled ingress requires an owner and current signing key.");
  return { schemaVersion: 1, enabled, ownerId, current, previous };
}

function atomicPrivateWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function privateKey() {
  if (encryptionKey) return encryptionKey;
  try {
    const existing = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
    if (existing.length !== 32) throw new Error("Ingress settings key must contain exactly 32 bytes.");
    chmodSync(KEY_PATH, 0o600);
    encryptionKey = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    encryptionKey = randomBytes(32);
    atomicPrivateWrite(KEY_PATH, `${encryptionKey.toString("base64")}\n`);
  }
  return encryptionKey;
}

function encrypt(settings: WebsiteLeadIngressSettings) {
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
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported ingress settings format.");
  const decipher = createDecipheriv("aes-256-gcm", privateKey(), Buffer.from(String(envelope.iv || ""), "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ""), "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ""), "base64")),
    decipher.final()
  ]);
  return normalizeSettings(JSON.parse(plaintext.toString("utf8")));
}

export function readWebsiteLeadIngressSettings(): WebsiteLeadIngressSettings {
  if (testSettings) return structuredClone(testSettings);
  try {
    const envelope = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    chmodSync(SETTINGS_PATH, 0o600);
    return decrypt(envelope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_SETTINGS);
    throw new Error(`Private ingress settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeWebsiteLeadIngressSettings(value: unknown) {
  const normalized = normalizeSettings(value);
  atomicPrivateWrite(SETTINGS_PATH, `${JSON.stringify(encrypt(normalized), null, 2)}\n`);
  return {
    enabled: normalized.enabled,
    ownerId: normalized.ownerId,
    currentKeyId: normalized.current?.id || "",
    previousKeyId: normalized.previous?.id || ""
  };
}

export function setWebsiteLeadIngressSettingsForTest(value: unknown) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test ingress settings are available only during tests.");
  testSettings = normalizeSettings(value);
}

export function validateWebsiteLeadIngressSettings(required = process.env.NODE_ENV === "production") {
  const settings = readWebsiteLeadIngressSettings();
  if (required && !settings.enabled) throw new Error("Production website lead ingress must be enabled in the encrypted private settings store.");
  return settings;
}

