import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

interface Envelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptionService {
  private constructor(private readonly key: Buffer) {}

  static async create(config: AppConfig): Promise<EncryptionService> {
    if (config.sessionMasterKey) {
      const key = Buffer.from(config.sessionMasterKey, "base64");
      if (key.length !== 32) throw new Error("SESSION_MASTER_KEY must decode to exactly 32 bytes");
      return new EncryptionService(key);
    }

    const keyPath = path.resolve(process.cwd(), ".data/dev-master.key");
    await mkdir(path.dirname(keyPath), { recursive: true });

    try {
      const stored = (await readFile(keyPath, "utf8")).trim();
      const key = Buffer.from(stored, "base64");
      if (key.length !== 32) throw new Error("Invalid development master key");
      return new EncryptionService(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await writeFile(keyPath, key.toString("base64"), { mode: 0o600 });
      return new EncryptionService(key);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    return JSON.stringify(envelope);
  }

  decrypt(value: string): string {
    const envelope = JSON.parse(value) as Envelope;
    if (envelope.version !== 1) throw new Error("Unsupported encrypted value version");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}

