import { NativeMcpClient, type NativeMcpClientOptions } from "./native-mcp-client.js";

interface SessionEntry {
  client: NativeMcpClient;
  fingerprint: string;
  createdAt: number;
  usedAt: number;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly maxIdleMs = 2 * 60_000,
    private readonly maxLifetimeMs = 15 * 60_000
  ) {}

  async get(connectionId: string, options: NativeMcpClientOptions) {
    const now = Date.now();
    const fingerprint = JSON.stringify({ endpoint: options.endpoint, policy: options.endpointPolicy, token: options.tokenFingerprint || "" });
    const existing = this.sessions.get(connectionId);
    if (existing && existing.fingerprint === fingerprint
      && now - existing.usedAt <= this.maxIdleMs
      && now - existing.createdAt <= this.maxLifetimeMs) {
      existing.usedAt = now;
      return existing.client;
    }
    if (existing) await this.closeConnection(connectionId);
    const client = new NativeMcpClient(options);
    await client.connect();
    this.sessions.set(connectionId, { client, fingerprint, createdAt: now, usedAt: now });
    return client;
  }

  async closeConnection(connectionId: string) {
    const existing = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    await existing?.client.close();
  }

  async sweep() {
    const now = Date.now();
    const expired = [...this.sessions.entries()].filter(([, entry]) =>
      now - entry.usedAt > this.maxIdleMs || now - entry.createdAt > this.maxLifetimeMs
    );
    await Promise.allSettled(expired.map(([connectionId]) => this.closeConnection(connectionId)));
  }

  async close() {
    await Promise.allSettled([...this.sessions.keys()].map((connectionId) => this.closeConnection(connectionId)));
  }
}
