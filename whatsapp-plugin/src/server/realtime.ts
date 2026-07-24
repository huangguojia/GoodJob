import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import type { RealtimeEvent } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import { verifyCrmToken } from "./crm-auth.js";

export class RealtimeHub {
  private readonly socket: SocketServer;
  private readonly accountOwners = new Map<string, string>();
  readonly events = new EventEmitter();

  constructor(server: HttpServer, config: AppConfig) {
    this.socket = new SocketServer(server, {
      cors: { origin: config.webOrigin, credentials: true }
    });
    this.socket.use((socket, next) => {
      const header = socket.handshake.headers.authorization;
      const cookie = String(socket.handshake.headers.cookie || "").split(";").find((item) => item.trim().startsWith("gj_session="))?.split("=").slice(1).join("=") || "";
      let token = header?.startsWith("Bearer ") ? header.slice(7) : cookie;
      try { token = decodeURIComponent(token); } catch { token = ""; }
      const identity = verifyCrmToken(config.crmJwtSecret, token);
      if (!identity) {
        next(new Error("CRM login required"));
        return;
      }
      socket.data.crmUserId = identity.userId;
      socket.join(`crm-owner:${identity.userId}`);
      next();
    });
  }

  registerAccountOwner(accountId: string, ownerUserId: string | null): void {
    if (ownerUserId) this.accountOwners.set(accountId, ownerUserId);
  }

  publish<T>(eventType: string, accountId: string | null, data: T): RealtimeEvent<T> {
    const event: RealtimeEvent<T> = {
      eventId: randomUUID(),
      eventType,
      accountId,
      occurredAt: new Date().toISOString(),
      data
    };
    const owner = accountId ? this.accountOwners.get(accountId) : null;
    if (owner) this.socket.to(`crm-owner:${owner}`).emit("plugin:event", event);
    this.events.emit("plugin:event", event);
    return event;
  }

  async close(): Promise<void> {
    this.socket.disconnectSockets(true);
    await new Promise<void>((resolve) => {
      this.socket.close(() => resolve());
    });
  }
}
