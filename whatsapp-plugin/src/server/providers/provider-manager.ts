import type { ChatMessage, ContactSyncResult, ProviderKind } from "../../shared/types.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { BaileysProvider } from "./baileys-provider.js";
import { DemoProvider } from "./demo-provider.js";
import { MetaProvider } from "./meta-provider.js";
import type { ChannelProvider, SendMediaCommand, SendMessageCommand, SendTemplateMessageCommand } from "./types.js";

export class ProviderManager {
  constructor(
    private readonly repository: Repository,
    readonly demo: DemoProvider,
    readonly baileys: BaileysProvider,
    readonly meta: MetaProvider,
    private readonly demoProviderEnabled = true,
    private readonly officialOnly = false
  ) {}

  async connect(accountId: string): Promise<void> {
    const provider = await this.forAccount(accountId);
    await provider.connect(accountId);
  }

  async disconnect(accountId: string, logout = true): Promise<void> {
    const provider = await this.forAccount(accountId, true);
    await provider.disconnect(accountId, logout);
  }

  async sendMessage(command: SendMessageCommand): Promise<ChatMessage> {
    const provider = await this.forAccount(command.accountId);
    return provider.sendMessage(command);
  }

  async sendMedia(command: SendMediaCommand): Promise<ChatMessage> {
    const account = await this.repository.getAccount(command.accountId);
    if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    if (account.provider !== "baileys") {
      throw new DomainError("MEDIA_PROVIDER_UNSUPPORTED", 409, "媒体附件当前仅支持 Baileys 免费通道");
    }
    if (this.officialOnly) {
      throw new DomainError("UNOFFICIAL_PROVIDER_DISABLED", 403, "Baileys is disabled in this runtime");
    }
    return this.baileys.sendMedia(command);
  }

  async revokeMessage(accountId: string, messageId: string): Promise<ChatMessage> {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    if (account.provider !== "baileys") {
      throw new DomainError("REVOKE_PROVIDER_UNSUPPORTED", 409, "消息撤回当前仅支持 Baileys 免费通道");
    }
    if (this.officialOnly) {
      throw new DomainError("UNOFFICIAL_PROVIDER_DISABLED", 403, "Baileys is disabled in this runtime");
    }
    return this.baileys.revokeMessage(accountId, messageId);
  }

  async sendTemplateMessage(command: SendTemplateMessageCommand): Promise<ChatMessage> {
    const account = await this.repository.getAccount(command.accountId);
    if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    if (account.provider !== "meta") {
      throw new DomainError("TEMPLATE_PROVIDER_UNSUPPORTED", 409, "Approved template messages are only available for Meta accounts");
    }
    return this.meta.sendTemplateMessage(command);
  }

  async syncContacts(accountId: string): Promise<ContactSyncResult> {
    const provider = await this.forAccount(accountId);
    return provider.syncContacts(accountId);
  }

  async resolveContactAddress(accountId: string, phone: string): Promise<string | null> {
    const provider = await this.forAccount(accountId);
    return provider.resolveContactAddress(accountId, phone);
  }

  activeConnectionCount(): number {
    return this.demo.activeConnectionCount() + this.baileys.activeConnectionCount() + this.meta.activeConnectionCount();
  }

  async shutdown(): Promise<void> {
    this.demo.shutdown();
    this.meta.shutdown();
    await this.baileys.shutdown();
  }

  private async forAccount(accountId: string, allowDisabledDemo = false): Promise<ChannelProvider> {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new Error("Account not found");
    if (account.provider === "demo" && !this.demoProviderEnabled && !allowDisabledDemo) {
      throw new DomainError("DEMO_PROVIDER_DISABLED", 403, "Demo Provider is disabled in this environment");
    }
    if (account.provider === "baileys" && this.officialOnly) {
      throw new DomainError(
        "UNOFFICIAL_PROVIDER_DISABLED",
        403,
        "Baileys is disabled because this runtime accepts official WhatsApp channels only"
      );
    }
    return this.forProvider(account.provider);
  }

  private forProvider(provider: ProviderKind): ChannelProvider {
    if (provider === "demo") return this.demo;
    if (provider === "baileys") return this.baileys;
    return this.meta;
  }
}
