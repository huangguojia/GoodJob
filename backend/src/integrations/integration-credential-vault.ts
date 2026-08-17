import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function keyFromMaster(masterKey: string) {
  if (masterKey.trim().length < 32) throw new Error("INTEGRATION_CREDENTIAL_KEY 必须至少包含 32 个字符");
  return createHash("sha256").update(masterKey, "utf8").digest();
}

function aad(context: { teamId: string; ownerId: string; connectionId: string; artifactType: string }) {
  return Buffer.from(`${context.teamId}\n${context.ownerId}\n${context.connectionId}\n${context.artifactType}`, "utf8");
}

export function encryptIntegrationValue(
  value: unknown,
  masterKey: string,
  context: { teamId: string; ownerId: string; connectionId: string; artifactType: string }
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromMaster(masterKey), iv);
  cipher.setAAD(aad(context));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptIntegrationValue<T>(
  encryptedValue: string,
  masterKey: string,
  context: { teamId: string; ownerId: string; connectionId: string; artifactType: string }
): T {
  const [version, ivValue, tagValue, payloadValue] = encryptedValue.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !payloadValue) throw new Error("集成密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", keyFromMaster(masterKey), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payloadValue, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
