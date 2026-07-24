import type { ChatMessage, ContactSyncResult } from "../../shared/types.js";

export interface SendMessageCommand {
  accountId: string;
  conversationId: string;
  clientMessageId: string;
  body: string;
}

export interface SendMediaCommand {
  accountId: string;
  conversationId: string;
  clientMessageId: string;
  kind: "image" | "video" | "file";
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  caption: string;
}

export interface SendTemplateMessageCommand {
  accountId: string;
  conversationId: string;
  clientMessageId: string;
  templateName: string;
  languageCode: string;
  bodyParameters: string[];
}

export interface ChannelProvider {
  connect(accountId: string): Promise<void>;
  disconnect(accountId: string, logout: boolean): Promise<void>;
  sendMessage(command: SendMessageCommand): Promise<ChatMessage>;
  syncContacts(accountId: string): Promise<ContactSyncResult>;
  resolveContactAddress(accountId: string, phone: string): Promise<string | null>;
  activeConnectionCount(): number;
}
