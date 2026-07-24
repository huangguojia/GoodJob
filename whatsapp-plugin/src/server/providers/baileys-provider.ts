import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  makeWASocket,
  normalizeMessageContent,
  type AnyMessageContent,
  type Contact as BaileysContact,
  type WAMessage,
  type WASocket
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { isE164PhoneNumber, type ChatMessage, type MessageStatus } from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { RealtimeHub } from "../realtime.js";
import { EncryptionService } from "../security/encryption.js";
import { TranslationService, detectLanguage } from "../services/translation.js";
import { createEncryptedAuthState } from "./baileys-auth-store.js";
import type { ChannelProvider, SendMediaCommand, SendMessageCommand } from "./types.js";

function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const user = jid.split("@")[0].split(":")[0].replace(/\D/gu, "");
  const phone = user ? `+${user}` : "";
  return isE164PhoneNumber(phone) ? phone : null;
}

function phoneJidFromCandidates(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = jidNormalizedUser(candidate);
    if (phoneFromJid(normalized)) return normalized;
  }
  return null;
}

function shouldIgnoreJid(jid: string): boolean {
  return jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

function textFromMessage(message: WAMessage): { body: string; type: ChatMessage["messageType"] } | null {
  const content = normalizeMessageContent(message.message);
  const contentType = getContentType(content);
  if (!content || !contentType) return null;
  if (content.conversation) return { body: content.conversation, type: "text" };
  if (content.extendedTextMessage?.text) return { body: content.extendedTextMessage.text, type: "text" };
  if (content.imageMessage) return { body: content.imageMessage.caption ?? "[图片]", type: "image" };
  if (content.videoMessage) return { body: content.videoMessage.caption ?? "[视频]", type: "file" };
  if (content.documentMessage) return { body: content.documentMessage.fileName ?? content.documentMessage.caption ?? "[文件]", type: "file" };
  if (content.audioMessage) return { body: "[语音消息]", type: "audio" };
  if (content.buttonsResponseMessage?.selectedDisplayText) {
    return { body: content.buttonsResponseMessage.selectedDisplayText, type: "text" };
  }
  if (content.listResponseMessage?.title) return { body: content.listResponseMessage.title, type: "text" };
  return null;
}

function statusFromBaileys(value: number | null | undefined): MessageStatus {
  if (value === undefined || value === null) return "unknown";
  if (value >= 4) return "read";
  if (value === 3) return "delivered";
  if (value === 2 || value === 1) return "accepted";
  return "unknown";
}

class ConnectionCancelledError extends Error {
  constructor(message = "Baileys connection was cancelled") {
    super(message);
    this.name = "ConnectionCancelledError";
  }
}

export class BaileysProvider implements ChannelProvider {
  private readonly sockets = new Map<string, WASocket>();
  private readonly connected = new Set<string>();
  private readonly connecting = new Set<string>();
  private readonly inFlightConnections = new Map<string, Promise<void>>();
  private readonly cancelledConnections = new Set<string>();
  private readonly connectionUpdateQueues = new Map<string, Promise<void>>();
  private readonly pendingSends = new Map<string, Promise<ChatMessage>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly logger = pino({ level: "silent" });
  private readonly proxyAgent?: HttpsProxyAgent<string>;
  private readonly fetchDispatcher?: ProxyAgent;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly repository: Repository,
    private readonly encryption: EncryptionService,
    private readonly realtime: RealtimeHub,
    private readonly translation: TranslationService,
    config: AppConfig
  ) {
    if (config.baileysProxyUrl) {
      this.proxyAgent = new HttpsProxyAgent(config.baileysProxyUrl);
      this.fetchDispatcher = new ProxyAgent(config.baileysProxyUrl);
    }
  }

  connect(accountId: string): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new ConnectionCancelledError("Baileys provider is shutting down"));
    }
    const pending = this.inFlightConnections.get(accountId);
    if (pending) return pending;
    if (this.sockets.has(accountId)) return Promise.resolve();

    this.cancelledConnections.delete(accountId);
    this.connecting.add(accountId);
    let tracked: Promise<void>;
    tracked = this.connectOnce(accountId).finally(() => {
      this.connecting.delete(accountId);
      if (this.inFlightConnections.get(accountId) === tracked) {
        this.inFlightConnections.delete(accountId);
      }
    });
    this.inFlightConnections.set(accountId, tracked);
    return tracked;
  }

  private async connectOnce(accountId: string): Promise<void> {
    const account = await this.repository.getAccount(accountId);
    this.throwIfConnectionCancelled(accountId);
    if (!account || account.provider !== "baileys") throw new Error("Baileys account not found");
    if (!account.riskAccepted) throw new Error("Non-official channel risk must be accepted before connecting");

    const connecting = await this.repository.updateAccountStatus(accountId, "connecting");
    this.throwIfConnectionCancelled(accountId);
    this.realtime.publish("account.connection.changed", accountId, connecting);
    let socket: WASocket | undefined;
    try {
      const { state, saveCreds } = await createEncryptedAuthState(accountId, this.repository, this.encryption);
      this.throwIfConnectionCancelled(accountId);
      const requestOptions = this.fetchDispatcher
        ? ({ dispatcher: this.fetchDispatcher } as RequestInit)
        : undefined;
      const { version } = await fetchLatestBaileysVersion(requestOptions);
      this.throwIfConnectionCancelled(accountId);
      const currentAccount = await this.repository.getAccount(accountId);
      this.throwIfConnectionCancelled(accountId);
      if (!currentAccount) throw new ConnectionCancelledError("Baileys account was removed while connecting");

      socket = makeWASocket({
        auth: state,
        version,
        logger: this.logger,
        browser: Browsers.macOS("CRM Plugin"),
        syncFullHistory: true,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        ...(this.proxyAgent ? { agent: this.proxyAgent, fetchAgent: this.proxyAgent } : {}),
        ...(requestOptions ? { options: requestOptions } : {})
      });
      this.throwIfConnectionCancelled(accountId);
      const activeSocket = socket;
      this.sockets.set(accountId, activeSocket);
      activeSocket.ev.on("creds.update", saveCreds);
      activeSocket.ev.on("connection.update", (update) => this.enqueueConnectionUpdate(accountId, activeSocket, update));
      activeSocket.ev.on("contacts.upsert", (contacts) => this.runProviderEvent(accountId, "contacts.upsert", () => this.handleContacts(accountId, contacts)));
      activeSocket.ev.on("contacts.update", (contacts) => this.runProviderEvent(accountId, "contacts.update", () => this.handleContacts(accountId, contacts)));
      activeSocket.ev.on("messaging-history.set", (history) => {
        this.runProviderEvent(accountId, "messaging-history.contacts", () => this.handleContacts(accountId, history.contacts));
        this.runProviderEvent(accountId, "messaging-history.messages", () => this.handleMessages(accountId, history.messages));
      });
      activeSocket.ev.on("messages.upsert", ({ messages }) => this.runProviderEvent(accountId, "messages.upsert", () => this.handleMessages(accountId, messages)));
      activeSocket.ev.on("messages.update", (updates) => {
        this.runProviderEvent(accountId, "messages.update", () => Promise.all(
          updates.map(async (update) => {
            if (!update.key.id || update.update.status === undefined) return;
            const existing = await this.repository.findMessageByIdempotency(accountId, update.key.id);
            if (!existing) return;
            const message = await this.repository.updateMessageStatusMonotonic(existing.id, statusFromBaileys(update.update.status));
            this.realtime.publish("message.status.changed", accountId, message);
          })
        ).then(() => undefined));
      });
    } catch (error) {
      if (socket) {
        if (this.sockets.get(accountId) === socket) this.sockets.delete(accountId);
        socket.end(new Error("Connection cancelled before initialization completed"));
      }
      if (error instanceof ConnectionCancelledError || this.isConnectionCancelled(accountId)) throw error;

      const reason = error instanceof Error ? error.message : "Unable to connect";
      const failed = await this.repository.updateAccountStatus(accountId, "degraded", { error: reason });
      this.throwIfConnectionCancelled(accountId);
      this.realtime.publish("account.connection.changed", accountId, failed);
      this.sockets.delete(accountId);
      throw error;
    }
  }

  async disconnect(accountId: string, logout: boolean): Promise<void> {
    this.cancelledConnections.add(accountId);
    const timer = this.retryTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(accountId);
    this.retryAttempts.delete(accountId);
    const socket = this.sockets.get(accountId);
    this.sockets.delete(accountId);
    this.connected.delete(accountId);
    let logoutError: string | null = null;
    if (socket) {
      try {
        if (logout) await socket.logout();
        else socket.end(new Error("Disconnected by operator"));
      } catch (error) {
        logoutError = error instanceof Error ? error.message : "Remote logout failed";
        socket.end(new Error("Local session closed after remote logout failure"));
        this.publishProviderError(accountId, "logout", error);
      }
    }
    if (logout) await this.repository.deleteSessionValue(accountId);
    const updated = await this.repository.updateAccountStatus(accountId, "logged_out", { error: logoutError });
    this.realtime.publish("account.connection.changed", accountId, updated);
  }

  async sendMessage(command: SendMessageCommand): Promise<ChatMessage> {
    const sendKey = `${command.accountId}:${command.clientMessageId}`;
    const pending = this.pendingSends.get(sendKey);
    if (pending) return pending;
    const task = this.sendMessageOnce(command);
    this.pendingSends.set(sendKey, task);
    try {
      return await task;
    } finally {
      if (this.pendingSends.get(sendKey) === task) this.pendingSends.delete(sendKey);
    }
  }

  async sendMedia(command: SendMediaCommand): Promise<ChatMessage> {
    const sendKey = `${command.accountId}:${command.clientMessageId}`;
    const pending = this.pendingSends.get(sendKey);
    if (pending) return pending;
    const task = this.sendMediaOnce(command);
    this.pendingSends.set(sendKey, task);
    try {
      return await task;
    } finally {
      if (this.pendingSends.get(sendKey) === task) this.pendingSends.delete(sendKey);
    }
  }

  private async sendMediaOnce(command: SendMediaCommand): Promise<ChatMessage> {
    const account = await this.repository.getAccount(command.accountId);
    const conversation = await this.repository.getConversation(command.conversationId);
    const socket = this.sockets.get(command.accountId);
    if (!account || account.status !== "connected" || !socket) throw new Error("Selected account is not connected");
    if (!conversation || conversation.accountId !== command.accountId) throw new Error("Account and conversation do not match");
    const existing = await this.repository.findMessageByIdempotency(command.accountId, undefined, command.clientMessageId);
    if (existing) return existing;

    const body = command.caption || command.fileName;
    const message = await this.repository.createMessage({
      accountId: command.accountId,
      conversationId: command.conversationId,
      clientMessageId: command.clientMessageId,
      direction: "outbound",
      messageType: command.kind,
      body,
      status: "sending",
      sourceLanguage: command.caption ? detectLanguage(command.caption) : null,
      media: { fileName: command.fileName, mimeType: command.mimeType, sizeBytes: command.buffer.byteLength }
    });
    this.realtime.publish("message.accepted", command.accountId, message);
    const content: AnyMessageContent = command.kind === "image"
      ? { image: command.buffer, caption: command.caption || undefined, mimetype: command.mimeType }
      : command.kind === "video"
        ? { video: command.buffer, caption: command.caption || undefined, mimetype: command.mimeType, fileName: command.fileName }
        : { document: command.buffer, caption: command.caption || undefined, mimetype: command.mimeType, fileName: command.fileName };
    try {
      const result = await socket.sendMessage(conversation.providerConversationId, content);
      const accepted = await this.repository.updateMessageStatus(message.id, "accepted", result?.key.id ?? undefined);
      this.realtime.publish("message.status.changed", command.accountId, accepted);
      return accepted;
    } catch (error) {
      const failed = await this.repository.updateMessageStatus(message.id, "failed");
      this.realtime.publish("message.status.changed", command.accountId, failed);
      throw error;
    }
  }

  async revokeMessage(accountId: string, messageId: string): Promise<ChatMessage> {
    const account = await this.repository.getAccount(accountId);
    const message = await this.repository.getMessage(messageId);
    const conversation = message ? await this.repository.getConversation(message.conversationId) : null;
    const socket = this.sockets.get(accountId);
    if (!account || account.status !== "connected" || !socket) throw new Error("Selected account is not connected");
    if (!message || !conversation || message.accountId !== accountId || conversation.accountId !== accountId) throw new Error("Message not found");
    if (message.direction !== "outbound" || !message.providerMessageId) throw new Error("Only sent messages can be revoked");
    if (message.revokedAt) return message;
    await socket.sendMessage(conversation.providerConversationId, {
      delete: {
        remoteJid: conversation.providerConversationId,
        fromMe: true,
        id: message.providerMessageId
      }
    });
    const revoked = await this.repository.markMessageRevoked(message.id);
    this.realtime.publish("message.revoked", accountId, revoked);
    return revoked;
  }

  private async sendMessageOnce(command: SendMessageCommand): Promise<ChatMessage> {
    const account = await this.repository.getAccount(command.accountId);
    const conversation = await this.repository.getConversation(command.conversationId);
    const socket = this.sockets.get(command.accountId);
    if (!account || account.status !== "connected" || !socket) throw new Error("Selected account is not connected");
    if (!conversation || conversation.accountId !== command.accountId) throw new Error("Account and conversation do not match");
    const existing = await this.repository.findMessageByIdempotency(command.accountId, undefined, command.clientMessageId);
    if (existing) return existing;

    const message = await this.repository.createMessage({
      accountId: command.accountId,
      conversationId: command.conversationId,
      clientMessageId: command.clientMessageId,
      direction: "outbound",
      body: command.body,
      status: "sending",
      sourceLanguage: detectLanguage(command.body)
    });
    this.realtime.publish("message.accepted", command.accountId, message);
    try {
      const result = await socket.sendMessage(conversation.providerConversationId, { text: command.body });
      const accepted = await this.repository.updateMessageStatus(message.id, "accepted", result?.key.id ?? undefined);
      this.realtime.publish("message.status.changed", command.accountId, accepted);
      this.processTranslation(command.accountId, accepted);
      return accepted;
    } catch (error) {
      const failed = await this.repository.updateMessageStatus(message.id, "failed");
      this.realtime.publish("message.status.changed", command.accountId, failed);
      throw error;
    }
  }

  async syncContacts(accountId: string): Promise<{ count: number }> {
    if (!this.sockets.has(accountId)) throw new Error("Account is not connected");
    const contacts = await this.repository.listContacts(accountId);
    this.realtime.publish("contact.sync.progress", accountId, {
      status: "completed",
      count: contacts.length,
      note: "Baileys contacts are synchronized from WhatsApp history and contact events"
    });
    return { count: contacts.length };
  }

  async resolveContactAddress(accountId: string, phone: string): Promise<string | null> {
    const account = await this.repository.getAccount(accountId);
    const socket = this.sockets.get(accountId);
    if (!account || account.provider !== "baileys") throw new Error("Baileys account not found");
    if (account.status !== "connected" || !socket) throw new Error("Selected account is not connected");
    if (!isE164PhoneNumber(phone)) return null;
    const matches = await socket.onWhatsApp(phone);
    const match = matches?.find((item) => item.exists);
    if (!match) return null;
    return phoneJidFromCandidates(match.jid) ?? `${phone.slice(1)}@s.whatsapp.net`;
  }

  activeConnectionCount(): number {
    return this.connected.size;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.shuttingDown = true;
    for (const accountId of this.connecting) this.cancelledConnections.add(accountId);
    for (const accountId of this.sockets.keys()) this.cancelledConnections.add(accountId);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();

    await Promise.allSettled([...this.inFlightConnections.values()]);
    for (const socket of this.sockets.values()) socket.end(new Error("Service shutdown"));
    await Promise.allSettled([...this.connectionUpdateQueues.values()]);
    this.sockets.clear();
    this.connected.clear();
    this.connectionUpdateQueues.clear();
    this.pendingSends.clear();
    this.proxyAgent?.destroy();
    await this.fetchDispatcher?.close();
    this.cancelledConnections.clear();
  }

  private enqueueConnectionUpdate(
    accountId: string,
    socket: WASocket,
    update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }
  ): void {
    const previous = this.connectionUpdateQueues.get(accountId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleConnectionUpdate(accountId, socket, update))
      .catch((error) => this.publishProviderError(accountId, "connection.update", error));
    this.connectionUpdateQueues.set(accountId, next);
    void next.finally(() => {
      if (this.connectionUpdateQueues.get(accountId) === next) this.connectionUpdateQueues.delete(accountId);
    });
  }

  private runProviderEvent(accountId: string, event: string, handler: () => Promise<void>): void {
    void handler().catch((error) => this.publishProviderError(accountId, event, error));
  }

  private publishProviderError(accountId: string, event: string, error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown provider event error";
    this.realtime.publish("provider.event.failed", accountId, { provider: "baileys", event, error: message });
  }

  private isConnectionCancelled(accountId: string): boolean {
    return this.shuttingDown || this.cancelledConnections.has(accountId);
  }

  private throwIfConnectionCancelled(accountId: string): void {
    if (this.isConnectionCancelled(accountId)) throw new ConnectionCancelledError();
  }

  private processTranslation(accountId: string, message: ChatMessage): void {
    void this.translation
      .processIncoming(message)
      .catch(() => this.realtime.publish("provider.event.failed", accountId, {
        provider: "baileys",
        event: "translation.processIncoming",
        error: "Automatic translation failed"
      }));
  }

  private async handleConnectionUpdate(
    accountId: string,
    socket: WASocket,
    update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }
  ): Promise<void> {
    if (this.shuttingDown || this.cancelledConnections.has(accountId) || this.sockets.get(accountId) !== socket) return;
    if (update.qr) {
      const qrDataUrl = await QRCode.toDataURL(update.qr, { width: 320, margin: 1 });
      if (this.isConnectionCancelled(accountId) || this.sockets.get(accountId) !== socket) return;
      const waiting = await this.repository.updateAccountStatus(accountId, "waiting_qr", { qrDataUrl });
      if (this.isConnectionCancelled(accountId) || this.sockets.get(accountId) !== socket) return;
      this.realtime.publish("account.qr.updated", accountId, waiting);
    }
    if (update.connection === "open") {
      this.retryAttempts.delete(accountId);
      const phone = socket.user?.id ? phoneFromJid(jidNormalizedUser(socket.user.id)) : null;
      if (phone) {
        const activeConflict = await this.repository.findActiveAccountByPhone(phone, accountId);
        if (this.isConnectionCancelled(accountId) || this.sockets.get(accountId) !== socket) return;
        if (activeConflict) {
          this.sockets.delete(accountId);
          this.connected.delete(accountId);
          socket.end(new Error("WhatsApp number is active on another channel account"));
          const blocked = await this.repository.updateAccountStatus(accountId, "degraded", {
            phone,
            error: `This WhatsApp number is already active on account “${activeConflict.name}”; pause that account before switching channels`
          });
          if (this.isConnectionCancelled(accountId)) return;
          this.realtime.publish("account.connection.changed", accountId, blocked);
          return;
        }
      }
      this.connected.add(accountId);
      const connected = await this.repository.updateAccountStatus(accountId, "connected", { phone, qrDataUrl: null });
      if (this.isConnectionCancelled(accountId) || this.sockets.get(accountId) !== socket) return;
      this.realtime.publish("account.connection.changed", accountId, connected);
      return;
    }
    if (update.connection !== "close") return;

    this.sockets.delete(accountId);
    this.connected.delete(accountId);
    if (this.shuttingDown) return;
    const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      await this.repository.deleteSessionValue(accountId);
      const loggedOut = await this.repository.updateAccountStatus(accountId, "logged_out", { error: "WhatsApp logged out this linked device" });
      this.realtime.publish("account.connection.changed", accountId, loggedOut);
      return;
    }

    const reconnecting = await this.repository.updateAccountStatus(accountId, "reconnecting", {
      error: `Connection closed${statusCode ? ` (${statusCode})` : ""}`
    });
    this.realtime.publish("account.connection.changed", accountId, reconnecting);
    this.scheduleReconnect(accountId);
  }

  private scheduleReconnect(accountId: string): void {
    if (this.shuttingDown || this.cancelledConnections.has(accountId) || this.retryTimers.has(accountId)) return;
    const attempt = (this.retryAttempts.get(accountId) ?? 0) + 1;
    this.retryAttempts.set(accountId, attempt);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(() => {
      this.retryTimers.delete(accountId);
      void this.connect(accountId).catch(() => this.scheduleReconnect(accountId));
    }, delay);
    timer.unref();
    this.retryTimers.set(accountId, timer);
  }

  private async handleContacts(accountId: string, contacts: Array<Partial<BaileysContact>>): Promise<void> {
    for (const item of contacts) {
      const jid = phoneJidFromCandidates(item.phoneNumber, item.id);
      if (!jid || shouldIgnoreJid(jid)) continue;
      const phone = phoneFromJid(jid);
      if (!phone) continue;
      const contact = await this.repository.upsertContact({
        accountId,
        providerContactId: jid,
        displayName: item.name ?? item.notify ?? item.verifiedName,
        phone,
        avatarUrl: item.imgUrl === "changed" ? undefined : item.imgUrl,
        source: "baileys",
        origin: "whatsapp_sync"
      });
      this.realtime.publish("contact.upserted", accountId, contact);
    }
  }

  private async handleMessages(accountId: string, messages: WAMessage[]): Promise<void> {
    for (const item of messages) {
      const remoteJid = phoneJidFromCandidates(item.key.remoteJidAlt, item.key.remoteJid);
      if (!remoteJid || shouldIgnoreJid(remoteJid) || !item.key.id) continue;
      const content = textFromMessage(item);
      if (!content) continue;
      const phone = phoneFromJid(remoteJid);
      if (!phone) continue;
      const contact = await this.repository.upsertContact({
        accountId,
        providerContactId: remoteJid,
        displayName: item.pushName,
        phone,
        source: "baileys",
        origin: item.key.fromMe ? "whatsapp_sync" : "inbound_message"
      });
      const conversation = await this.repository.upsertConversation({
        accountId,
        contactId: contact.id,
        providerConversationId: remoteJid
      });
      const timestamp = item.messageTimestamp ? new Date(Number(item.messageTimestamp) * 1000).toISOString() : undefined;
      const message = await this.repository.createMessage({
        accountId,
        conversationId: conversation.id,
        providerMessageId: item.key.id,
        direction: item.key.fromMe ? "outbound" : "inbound",
        messageType: content.type,
        body: content.body,
        status: item.key.fromMe ? statusFromBaileys(item.status) : "delivered",
        sourceLanguage: detectLanguage(content.body),
        occurredAt: timestamp
      });
      this.realtime.publish(item.key.fromMe ? "message.accepted" : "message.received", accountId, message);

      if (!item.key.fromMe) {
        const accountOwner = await this.repository.getAccount(accountId);
        const preference = await this.repository.getTranslationPreference(accountOwner?.ownerUserId ?? undefined);
        if (preference.crmAutoCreate && !contact.crmContactId) {
          const crmContact = await this.repository.createCrmContact(contact.id);
          this.realtime.publish("crm.contact.created", accountId, crmContact);
        }
      }
      this.processTranslation(accountId, message);
    }
  }
}
