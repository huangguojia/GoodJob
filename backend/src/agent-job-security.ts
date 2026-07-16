import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

interface AgentJobPayloadContext {
  id: string;
  teamId: string;
  ownerId: string;
  jobType: string;
}

const DEVELOPMENT_FALLBACK_SECRET = randomBytes(48).toString("base64url");

function masterSecret() {
  const configured = process.env.AGENT_JOB_ENCRYPTION_KEY?.trim()
    || process.env.PROVIDER_CREDENTIAL_KEY?.trim();
  if (configured && configured.length >= 32) return configured;
  if (configured) throw new Error("智能获客任务加密主密钥必须至少包含 32 个字符");
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 AGENT_JOB_ENCRYPTION_KEY 或 PROVIDER_CREDENTIAL_KEY");
  }
  return process.env.JWT_SECRET
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || DEVELOPMENT_FALLBACK_SECRET;
}

function encryptionKey() {
  return createHash("sha256")
    .update("goodjob-agent-job-payload-v1|")
    .update(masterSecret())
    .digest();
}

export function validateAgentJobSecurity() {
  encryptionKey();
}

function additionalData(context: AgentJobPayloadContext, payloadType: "input" | "output") {
  return Buffer.from([
    context.id,
    context.teamId,
    context.ownerId,
    context.jobType,
    payloadType
  ].join("|"), "utf8");
}

export function encryptAgentJobPayload(
  context: AgentJobPayloadContext,
  payloadType: "input" | "output",
  payload: Record<string, unknown>
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(additionalData(context, payloadType));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptAgentJobPayload(
  context: AgentJobPayloadContext,
  payloadType: "input" | "output",
  encryptedValue: string
): Record<string, unknown> {
  if (!encryptedValue) return {};
  const [version, ivValue, tagValue, payloadValue] = encryptedValue.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !payloadValue) {
    throw new Error("智能获客任务密文格式无效");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(additionalData(context, payloadType));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadValue, "base64url")),
    decipher.final()
  ]);
  const parsed = JSON.parse(decrypted.toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
