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

  /**
   * 断开 / 登出属于**清理**语义，刻意不受通道开关（officialOnly / demoProviderEnabled）约束。
   *
   * 原先这里复用 `forAccount(accountId, true)`，而那个 `true` 只放开了 Demo；Baileys 在
   * officialOnly 运行时仍会被拦成 403。后果是：一个在环境切换前连上过的 Baileys 账号会永久
   * 卡在 connected —— 既登不出来，也删不掉（`DELETE /accounts/:id` 对非 unconfigured/logged_out
   * 的账号会先调 disconnect，403 抛出后 deleteAccount 根本执行不到），账号和被加密的会话一起
   * 留在库里。停用一条通道只应阻止「用它发消息」，不该连本地会话都收不回来。
   */
  async disconnect(accountId: string, logout = true): Promise<void> {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    await this.forProvider(account.provider).disconnect(accountId, logout);
  }

  async sendMessage(command: SendMessageCommand): Promise<ChatMessage> {
    const provider = await this.forAccount(command.accountId);
    return provider.sendMessage(command);
  }

  /**
   * 媒体发送按账号所属通道路由：
   * - meta   → Graph 媒体上传 + 发送（需要 24 小时服务窗口）
   * - baileys → 免费通道直传（officialOnly 运行时禁用）
   * - demo   → 本地落库，仅用于本机验收
   */
  async sendMedia(command: SendMediaCommand): Promise<ChatMessage> {
    const provider = await this.forAccount(command.accountId);
    return provider.sendMedia(command);
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

  /**
   * 按账号所属通道路由到具体 provider，并在路由前做通道开关校验。
   * 只用于**使用**通道的路径（连接 / 发消息 / 同步联系人 / 解析地址）；
   * 清理路径见 `disconnect`。
   */
  private async forAccount(accountId: string): Promise<ChannelProvider> {
    const account = await this.repository.getAccount(accountId);
    // 与 ownedAccount() 保持同一错误码：裸 Error 会被顶层当 500 记成"服务端异常"，
    // 而账号不存在是调用方可理解的 404。
    if (!account) throw new DomainError("ACCOUNT_NOT_FOUND", 404, "Account not found");
    if (account.provider === "demo" && !this.demoProviderEnabled) {
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
