import { randomUUID } from "node:crypto";
import { isE164PhoneNumber, type ChatMessage } from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { RealtimeHub } from "../realtime.js";
import { TranslationService, detectLanguage } from "../services/translation.js";
import type { ChannelProvider, SendMessageCommand } from "./types.js";

export class DemoProvider implements ChannelProvider {
  private readonly connected = new Set<string>();

  constructor(
    private readonly repository: Repository,
    private readonly realtime: RealtimeHub,
    private readonly translation: TranslationService
  ) {}

  async connect(accountId: string): Promise<void> {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new Error("Account not found");
    this.connected.add(accountId);
    const updated = await this.repository.updateAccountStatus(accountId, "connected", { phone: account.phone });
    this.realtime.publish("account.connection.changed", accountId, updated);
  }

  async disconnect(accountId: string): Promise<void> {
    this.connected.delete(accountId);
    const updated = await this.repository.updateAccountStatus(accountId, "logged_out");
    this.realtime.publish("account.connection.changed", accountId, updated);
  }

  async sendMessage(command: SendMessageCommand): Promise<ChatMessage> {
    const account = await this.repository.getAccount(command.accountId);
    const conversation = await this.repository.getConversation(command.conversationId);
    if (!account || account.status !== "connected") throw new Error("Selected account is not connected");
    if (!conversation || conversation.accountId !== command.accountId) {
      throw new Error("Account and conversation do not match");
    }
    const message = await this.repository.createMessage({
      accountId: command.accountId,
      conversationId: command.conversationId,
      providerMessageId: `demo-out-${randomUUID()}`,
      clientMessageId: command.clientMessageId,
      direction: "outbound",
      body: command.body,
      status: "delivered",
      sourceLanguage: detectLanguage(command.body)
    });
    this.realtime.publish("message.accepted", command.accountId, message);
    this.realtime.publish("message.status.changed", command.accountId, message);
    void this.translation.processIncoming(message).catch(() => {
      this.publishTranslationFailure(command.accountId);
    });
    return message;
  }

  async syncContacts(accountId: string): Promise<{ count: number }> {
    const contacts = await this.repository.listContacts(accountId);
    this.realtime.publish("contact.sync.progress", accountId, { status: "completed", count: contacts.length });
    return { count: contacts.length };
  }

  async resolveContactAddress(accountId: string, phone: string): Promise<string | null> {
    const account = await this.repository.getAccount(accountId);
    if (!account || account.provider !== "demo") throw new Error("Demo account not found");
    if (!isE164PhoneNumber(phone)) return null;
    return `${phone.slice(1)}@s.whatsapp.net`;
  }

  activeConnectionCount(): number {
    return this.connected.size;
  }

  shutdown(): void {
    this.connected.clear();
  }

  async simulateInbound(input: {
    accountId: string;
    displayName: string;
    phone: string;
    body: string;
  }): Promise<ChatMessage> {
    const account = await this.repository.getAccount(input.accountId);
    if (!account || account.provider !== "demo") throw new Error("Demo account not found");
    const phone = input.phone;
    if (!isE164PhoneNumber(phone)) throw new Error("Invalid E.164 phone number");
    const providerContactId = `${phone.replace(/\D/gu, "")}@s.whatsapp.net`;
    const contact = await this.repository.upsertContact({
      accountId: input.accountId,
      providerContactId,
      displayName: input.displayName,
      phone,
      source: "demo",
      origin: "inbound_message"
    });
    const conversation = await this.repository.upsertConversation({
      accountId: input.accountId,
      contactId: contact.id,
      providerConversationId: providerContactId
    });
    const message = await this.repository.createMessage({
      accountId: input.accountId,
      conversationId: conversation.id,
      providerMessageId: `demo-in-${randomUUID()}`,
      direction: "inbound",
      body: input.body,
      status: "delivered",
      sourceLanguage: detectLanguage(input.body)
    });
    this.realtime.publish("contact.upserted", input.accountId, contact);
    this.realtime.publish("conversation.upserted", input.accountId, conversation);
    this.realtime.publish("message.received", input.accountId, message);

    const accountOwner = await this.repository.getAccount(input.accountId);
    const preference = await this.repository.getTranslationPreference(accountOwner?.ownerUserId ?? undefined);
    if (preference.crmAutoCreate && !contact.crmContactId) {
      const crmContact = await this.repository.createCrmContact(contact.id);
      this.realtime.publish("crm.contact.created", input.accountId, crmContact);
    }
    void this.translation.processIncoming(message).catch(() => {
      this.publishTranslationFailure(input.accountId);
    });
    return message;
  }

  private publishTranslationFailure(accountId: string): void {
    this.realtime.publish("provider.event.failed", accountId, {
      provider: "demo",
      event: "translation.processIncoming",
      error: "Automatic translation failed"
    });
  }
}
