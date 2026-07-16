import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

interface ProviderCredentialContext {
  id: string;
  providerId: string;
  ownerId: string;
  teamId: string;
}

interface ProviderConfiguration {
  apiKey: string;
  baseUrl: string;
}

interface AiModelCredentialContext {
  id: string;
  provider: string;
  ownerId: string;
  teamId: string;
}

interface ProviderResponseCacheContext {
  id: string;
  providerId: string;
  providerVersion: string;
  requestFingerprint: string;
  licenseScope: string;
}

const DEVELOPMENT_FALLBACK_SECRET = randomBytes(48).toString("base64url");

function credentialSecret() {
  const configured = process.env.PROVIDER_CREDENTIAL_KEY?.trim();
  if (configured && configured.length >= 32) return configured;
  if (configured) throw new Error("PROVIDER_CREDENTIAL_KEY 必须至少包含 32 个字符");
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置至少 32 个字符的 PROVIDER_CREDENTIAL_KEY");
  }
  return process.env.JWT_SECRET
    || process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || DEVELOPMENT_FALLBACK_SECRET;
}

function encryptionKey() {
  return createHash("sha256").update(credentialSecret()).digest();
}

function aiModelEncryptionKey() {
  return createHash("sha256")
    .update("goodjob-ai-model-api-key-v1|")
    .update(credentialSecret())
    .digest();
}

function providerResponseCacheEncryptionKey() {
  return createHash("sha256")
    .update("goodjob-provider-response-cache-v1|")
    .update(credentialSecret())
    .digest();
}

export function validateProviderCredentialSecurity() {
  encryptionKey();
}

function additionalData(context: ProviderCredentialContext) {
  return Buffer.from([context.id, context.providerId, context.ownerId, context.teamId].join("|"), "utf8");
}

export function createCredentialRef() {
  return `cred_${randomBytes(18).toString("base64url")}`;
}

export function encryptProviderConfiguration(
  context: ProviderCredentialContext,
  configuration: ProviderConfiguration
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(additionalData(context));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(configuration), "utf8"),
    cipher.final()
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptProviderConfiguration(
  context: ProviderCredentialContext,
  encryptedValue: string
): ProviderConfiguration {
  const [version, ivValue, tagValue, payloadValue] = encryptedValue.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !payloadValue) {
    throw new Error("Provider 连接配置密文格式无效");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadValue, "base64url")),
    decipher.final()
  ]);
  const value = JSON.parse(decrypted.toString("utf8")) as Partial<ProviderConfiguration>;
  return {
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : ""
  };
}

function providerResponseCacheAdditionalData(context: ProviderResponseCacheContext) {
  return Buffer.from([
    "provider-response-cache",
    context.id,
    context.providerId,
    context.providerVersion,
    context.requestFingerprint,
    context.licenseScope
  ].join("|"), "utf8");
}

export function encryptProviderResponseCachePayload(
  context: ProviderResponseCacheContext,
  payload: unknown
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", providerResponseCacheEncryptionKey(), iv);
  cipher.setAAD(providerResponseCacheAdditionalData(context));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final()
  ]);
  return [
    "cache-v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptProviderResponseCachePayload(
  context: ProviderResponseCacheContext,
  encryptedValue: string
): unknown {
  const [version, ivValue, tagValue, payloadValue] = encryptedValue.split(".");
  if (version !== "cache-v1" || !ivValue || !tagValue || !payloadValue) {
    throw new Error("Provider 响应缓存密文格式无效");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    providerResponseCacheEncryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAAD(providerResponseCacheAdditionalData(context));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadValue, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8")) as unknown;
}

function aiModelAdditionalData(context: AiModelCredentialContext) {
  return Buffer.from([
    "ai-model-api-key",
    context.id,
    context.provider,
    context.ownerId,
    context.teamId
  ].join("|"), "utf8");
}

export function isEncryptedAiModelApiKey(value: string) {
  return value.startsWith("ai-v1.");
}

export function encryptAiModelApiKey(context: AiModelCredentialContext, apiKey: string) {
  if (!apiKey) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aiModelEncryptionKey(), iv);
  cipher.setAAD(aiModelAdditionalData(context));
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return [
    "ai-v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptAiModelApiKey(context: AiModelCredentialContext, encryptedValue: string) {
  if (!encryptedValue) return "";
  const [version, ivValue, tagValue, payloadValue] = encryptedValue.split(".");
  if (version !== "ai-v1" || !ivValue || !tagValue || !payloadValue) {
    throw new Error("AI 模型密钥密文格式无效");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aiModelEncryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAAD(aiModelAdditionalData(context));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payloadValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
