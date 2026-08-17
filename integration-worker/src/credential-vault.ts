import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface ArtifactContext {
  teamId: string;
  ownerId: string;
  connectionId: string;
  artifactType: string;
}

const key = (masterKey: string) => createHash("sha256").update(masterKey, "utf8").digest();
const aad = (context: ArtifactContext) => Buffer.from(
  `${context.teamId}\n${context.ownerId}\n${context.connectionId}\n${context.artifactType}`,
  "utf8"
);

export function encryptValue(value: unknown, masterKey: string, context: ArtifactContext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(masterKey), iv);
  cipher.setAAD(aad(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptValue<T>(encryptedValue: string, masterKey: string, context: ArtifactContext): T {
  const [version, ivValue, tagValue, payloadValue] = encryptedValue.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !payloadValue) throw new Error("集成密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", key(masterKey), Buffer.from(ivValue, "base64url"));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payloadValue, "base64url")),
    decipher.final()
  ]).toString("utf8")) as T;
}
