import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccount, ChatMessage, Conversation } from "../src/shared/types";
import type { AppConfig } from "../src/server/config";
import type { Repository } from "../src/server/db/repository";
import { BaileysProvider } from "../src/server/providers/baileys-provider";
import type { RealtimeHub } from "../src/server/realtime";
import type { EncryptionService } from "../src/server/security/encryption";
import type { TranslationService } from "../src/server/services/translation";

const mocks = vi.hoisted(() => ({
  createEncryptedAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
  makeWASocket: vi.fn()
}));

vi.mock("@whiskeysockets/baileys", () => ({
  Browsers: { macOS: vi.fn(() => ["CRM Plugin", "macOS", "1.0"]) },
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: mocks.fetchLatestBaileysVersion,
  getContentType: vi.fn(),
  jidNormalizedUser: vi.fn((jid: string) => jid),
  makeWASocket: mocks.makeWASocket,
  normalizeMessageContent: vi.fn()
}));

vi.mock("../src/server/providers/baileys-auth-store.js", () => ({
  createEncryptedAuthState: mocks.createEncryptedAuthState
}));

const account = (status: ChannelAccount["status"] = "logged_out"): ChannelAccount => ({
  id: "account-1",
  name: "Sales account",
  provider: "baileys",
  phone: null,
  avatarUrl: null,
  status,
  purposeLabel: "Sales",
  leadTypes: [],
  region: "Global",
  priority: 1,
  riskAccepted: true,
  lastConnectedAt: null,
  lastEventAt: null,
  lastError: null,
  qrDataUrl: null,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z"
});

function createSocket() {
  return {
    ev: { on: vi.fn() },
    end: vi.fn(),
    logout: vi.fn(),
    onWhatsApp: vi.fn(),
    sendMessage: vi.fn(),
    user: undefined
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createProvider(initialAccount = account()) {
  const repository = {
    getAccount: vi.fn().mockResolvedValue(initialAccount),
    updateAccountStatus: vi.fn(async (_accountId: string, status: ChannelAccount["status"]) => ({
      ...initialAccount,
      status
    }))
  };
  const realtime = { publish: vi.fn() };
  const translation = { processIncoming: vi.fn().mockResolvedValue(null) };
  const provider = new BaileysProvider(
    repository as unknown as Repository,
    {} as EncryptionService,
    realtime as unknown as RealtimeHub,
    translation as unknown as TranslationService,
    { baileysProxyUrl: undefined } as AppConfig
  );
  return { provider, realtime, repository, translation };
}

type ProviderInternals = {
  cancelledConnections: Set<string>;
  connecting: Set<string>;
  inFlightConnections: Map<string, Promise<void>>;
  sockets: Map<string, ReturnType<typeof createSocket>>;
};

describe("BaileysProvider lifecycle", () => {
  beforeEach(() => {
    mocks.createEncryptedAuthState.mockReset();
    mocks.fetchLatestBaileysVersion.mockReset();
    mocks.makeWASocket.mockReset();
    mocks.createEncryptedAuthState.mockResolvedValue({ state: {}, saveCreds: vi.fn() });
    mocks.fetchLatestBaileysVersion.mockResolvedValue({ version: [2, 3000, 1], isLatest: true });
    mocks.makeWASocket.mockImplementation(() => createSocket());
  });

  it("cancels and awaits an in-flight connect before shutdown cleanup", async () => {
    const version = createDeferred<{ version: [number, number, number]; isLatest: boolean }>();
    mocks.fetchLatestBaileysVersion.mockReturnValue(version.promise);
    const { provider, repository } = createProvider();
    const internals = provider as unknown as ProviderInternals;

    const firstConnect = provider.connect("account-1");
    await vi.waitFor(() => expect(mocks.fetchLatestBaileysVersion).toHaveBeenCalledOnce());
    const duplicateConnect = provider.connect("account-1");

    expect(duplicateConnect).toBe(firstConnect);
    expect(internals.inFlightConnections.get("account-1")).toBe(firstConnect);
    const shutdown = provider.shutdown();
    expect(internals.cancelledConnections.has("account-1")).toBe(true);
    await expect(provider.connect("account-2")).rejects.toThrow("shutting down");

    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(internals.cancelledConnections.has("account-1")).toBe(true);

    version.resolve({ version: [2, 3000, 1], isLatest: true });
    await expect(firstConnect).rejects.toThrow("cancelled");
    await expect(duplicateConnect).rejects.toThrow("cancelled");
    await shutdown;

    expect(mocks.makeWASocket).not.toHaveBeenCalled();
    expect(repository.getAccount).toHaveBeenCalledTimes(1);
    expect(repository.updateAccountStatus).toHaveBeenCalledTimes(1);
    expect(internals.inFlightConnections.size).toBe(0);
    expect(internals.connecting.size).toBe(0);
    expect(internals.cancelledConnections.size).toBe(0);
  });

  it("closes a socket when shutdown starts during socket construction", async () => {
    const { provider, repository } = createProvider();
    const socket = createSocket();
    let shutdown: Promise<void> | undefined;
    mocks.makeWASocket.mockImplementation(() => {
      shutdown = provider.shutdown();
      return socket;
    });

    await expect(provider.connect("account-1")).rejects.toThrow("cancelled");
    await shutdown;

    expect(repository.getAccount).toHaveBeenCalledTimes(2);
    expect(repository.updateAccountStatus).toHaveBeenCalledTimes(1);
    expect(socket.end).toHaveBeenCalledOnce();
    expect(socket.ev.on).not.toHaveBeenCalled();
    expect((provider as unknown as ProviderInternals).sockets.size).toBe(0);
  });

  it("reports background translation failures instead of leaving an unhandled rejection", async () => {
    const connectedAccount = account("connected");
    const { provider, realtime, repository, translation } = createProvider(connectedAccount);
    const conversation: Conversation = {
      id: "conversation-1",
      accountId: connectedAccount.id,
      contactId: "contact-1",
      providerConversationId: "12025550123@s.whatsapp.net",
      contactName: "Customer",
      contactPhone: "+12025550123",
      contactAvatarUrl: null,
      unreadCount: 0,
      lastMessage: null,
      lastMessageAt: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
    const sendingMessage: ChatMessage = {
      id: "message-1",
      accountId: connectedAccount.id,
      conversationId: conversation.id,
      providerMessageId: null,
      clientMessageId: "client-message-1",
      direction: "outbound",
      messageType: "text",
      body: "Hello",
      status: "sending",
      sourceLanguage: "en",
      occurredAt: "2026-07-17T00:00:00.000Z",
      createdAt: "2026-07-17T00:00:00.000Z",
      translations: []
    };
    Object.assign(repository, {
      createMessage: vi.fn().mockResolvedValue(sendingMessage),
      findMessageByIdempotency: vi.fn().mockResolvedValue(undefined),
      getConversation: vi.fn().mockResolvedValue(conversation),
      updateMessageStatus: vi.fn().mockResolvedValue({
        ...sendingMessage,
        providerMessageId: "provider-message-1",
        status: "accepted"
      })
    });
    const socket = createSocket();
    socket.sendMessage.mockResolvedValue({ key: { id: "provider-message-1" } });
    (provider as unknown as ProviderInternals).sockets.set(connectedAccount.id, socket);
    translation.processIncoming.mockRejectedValue(new Error("translation unavailable"));

    await expect(provider.sendMessage({
      accountId: connectedAccount.id,
      conversationId: conversation.id,
      clientMessageId: "client-message-1",
      body: "Hello"
    })).resolves.toMatchObject({ status: "accepted" });

    await vi.waitFor(() => expect(realtime.publish).toHaveBeenCalledWith(
      "provider.event.failed",
      connectedAccount.id,
      {
        provider: "baileys",
        event: "translation.processIncoming",
        error: "Automatic translation failed"
      }
    ));
    await provider.shutdown();
  });

  it("sends image media with metadata and records the provider message id", async () => {
    const connectedAccount = account("connected");
    const { provider, realtime, repository } = createProvider(connectedAccount);
    const conversation: Conversation = {
      id: "conversation-media",
      accountId: connectedAccount.id,
      contactId: "contact-media",
      providerConversationId: "12025550123@s.whatsapp.net",
      contactName: "Media customer",
      contactPhone: "+12025550123",
      contactAvatarUrl: null,
      unreadCount: 0,
      lastMessage: null,
      lastMessageAt: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
    const sendingMessage: ChatMessage = {
      id: "message-media",
      accountId: connectedAccount.id,
      conversationId: conversation.id,
      providerMessageId: null,
      clientMessageId: "client-media-1",
      direction: "outbound",
      messageType: "image",
      body: "Product photo",
      status: "sending",
      sourceLanguage: "en",
      occurredAt: "2026-07-17T00:00:00.000Z",
      createdAt: "2026-07-17T00:00:00.000Z",
      translations: [],
      media: {
        fileName: "product.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 5,
        available: false,
        expiresAt: null
      }
    };
    Object.assign(repository, {
      createMessage: vi.fn().mockResolvedValue(sendingMessage),
      findMessageByIdempotency: vi.fn().mockResolvedValue(undefined),
      getConversation: vi.fn().mockResolvedValue(conversation),
      updateMessageStatus: vi.fn().mockResolvedValue({
        ...sendingMessage,
        providerMessageId: "provider-media-1",
        status: "accepted"
      })
    });
    const socket = createSocket();
    socket.sendMessage.mockResolvedValue({ key: { id: "provider-media-1" } });
    (provider as unknown as ProviderInternals).sockets.set(connectedAccount.id, socket);

    const result = await provider.sendMedia({
      accountId: connectedAccount.id,
      conversationId: conversation.id,
      clientMessageId: "client-media-1",
      kind: "image",
      fileName: "product.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("image"),
      caption: "Product photo"
    });

    expect(repository.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: "image",
      media: { fileName: "product.jpg", mimeType: "image/jpeg", sizeBytes: 5 }
    }));
    expect(socket.sendMessage).toHaveBeenCalledWith(conversation.providerConversationId, {
      image: Buffer.from("image"),
      caption: "Product photo",
      mimetype: "image/jpeg"
    });
    expect(result).toMatchObject({ providerMessageId: "provider-media-1", status: "accepted" });
    expect(realtime.publish).toHaveBeenCalledWith("message.status.changed", connectedAccount.id, result);
    await provider.shutdown();
  });

  it("revokes only a sent outbound message using its WhatsApp message key", async () => {
    const connectedAccount = account("connected");
    const { provider, realtime, repository } = createProvider(connectedAccount);
    const conversation = {
      id: "conversation-revoke",
      accountId: connectedAccount.id,
      providerConversationId: "12025550123@s.whatsapp.net"
    } as Conversation;
    const sentMessage = {
      id: "message-revoke",
      accountId: connectedAccount.id,
      conversationId: conversation.id,
      providerMessageId: "provider-message-revoke",
      direction: "outbound",
      revokedAt: null
    } as ChatMessage;
    const revokedMessage = {
      ...sentMessage,
      revokedAt: "2026-07-18T00:00:00.000Z"
    } as ChatMessage;
    Object.assign(repository, {
      getConversation: vi.fn().mockResolvedValue(conversation),
      getMessage: vi.fn().mockResolvedValue(sentMessage),
      markMessageRevoked: vi.fn().mockResolvedValue(revokedMessage)
    });
    const socket = createSocket();
    socket.sendMessage.mockResolvedValue({ key: { id: "revoke-operation" } });
    (provider as unknown as ProviderInternals).sockets.set(connectedAccount.id, socket);

    await expect(provider.revokeMessage(connectedAccount.id, sentMessage.id)).resolves.toBe(revokedMessage);
    expect(socket.sendMessage).toHaveBeenCalledWith(conversation.providerConversationId, {
      delete: {
        remoteJid: conversation.providerConversationId,
        fromMe: true,
        id: sentMessage.providerMessageId
      }
    });
    expect(repository.markMessageRevoked).toHaveBeenCalledWith(sentMessage.id);
    expect(realtime.publish).toHaveBeenCalledWith("message.revoked", connectedAccount.id, revokedMessage);
    await provider.shutdown();
  });
});
