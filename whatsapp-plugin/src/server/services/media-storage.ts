import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class MediaStorageService {
  constructor(private readonly rootPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
  }

  async save(buffer: Buffer, fileName: string): Promise<string> {
    await this.initialize();
    const extension = path.extname(fileName).toLowerCase();
    const safeExtension = /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
    const storageKey = `${randomUUID()}${safeExtension}`;
    await writeFile(this.resolve(storageKey), buffer, { flag: "wx", mode: 0o600 });
    return storageKey;
  }

  resolve(storageKey: string): string {
    if (!/^[a-f0-9-]{36}(?:\.[a-z0-9]{1,10})?$/u.test(storageKey)) {
      throw new Error("Invalid media storage key");
    }
    return path.join(this.rootPath, storageKey);
  }

  async remove(storageKey: string): Promise<void> {
    await unlink(this.resolve(storageKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
