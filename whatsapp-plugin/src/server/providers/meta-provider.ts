import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isE164PhoneNumber, type ChatMessage, type ContactSyncResult, type MessageStatus } from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { RealtimeHub } from "../realtime.js";
import { EncryptionService } from "../security/encryption.js";
import { TranslationService, detectLanguage } from "../services/translation.js";
import { ConversationIntelligenceService } from "../services/conversation-intelligence.js";
import type { ChannelProvider, SendMessageCommand, SendTemplateMessageCommand } from "./types.js";

const META_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface MetaWebhookValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<{
    from?: string;
    id?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
    image?: { id?: string; caption?: string; mime_type?: string; sha256?: string };
    video?: { id?: string; caption?: string; mime_type?: string; sha256?: string };
    audio?: { id?: string; mime_type?: string; voice?: boolean };
    document?: { id?: string; caption?: string; filename?: string; mime_type?: string; sha256?: string };
    sticker?: { id?: string; mime_type?: string; animated?: boolean };
    location?: { latitude?: number; longitude?: number; name?: string; address?: string };
    contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string; wa_id?: string }> }>;
    interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string; description?: string } };
    button?: { text?: string; payload?: string };
    reaction?: { message_id?: string; emoji?: string };
    order?: { catalog_id?: string; product_items?: Array<{ product_retailer_id?: string; quantity?: string; item_price?: string; currency?: string }> };
    referral?: { source_url?: string; source_type?: string; headline?: string; body?: string };
    errors?: Array<{ code?: number; title?: string; message?: string }>;
  }>;
  statuses?: Array<{ id?: string; status?: string; timestamp?: string }>;
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: MetaWebhookValue }>;
  }>;
}

function maskSafeEqual(actualHex: string, expectedHex: string): boolean {
  if (!/^[a-f\d]+$/iu.test(actualHex) || actualHex.length !== expectedHex.length) return false;
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeDisplayPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const phone = `+${value.replace(/\D/gu, "")}`;
  return isE164PhoneNumber(phone) ? phone : null;
}

function webhookTimestamp(value: string | undefined): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function metaStatus(value: string | undefined): MessageStatus | null {
  if (value === "sent") return "accepted";
  if (value === "delivered") return "delivered";
  if (value === "read") return "read";
  if (value === "failed") return "failed";
  return null;
}

function inboundMessageContent(item: NonNullable<MetaWebhookValue["messages"]>[number]): {
  body: string;
  messageType: ChatMessage["messageType"];
} {
  if (item.type === "text") return { body: item.text?.body?.trim() || "[空文本消息]", messageType: "text" };
  if (item.type === "image") return { body: item.image?.caption?.trim() || "[图片]", messageType: "image" };
  if (item.type === "video") return { body: item.video?.caption?.trim() || "[视频]", messageType: "video" };
  if (item.type === "audio") return { body: item.audio?.voice ? "[语音消息]" : "[音频]", messageType: "audio" };
  if (item.type === "document") return { body: item.document?.caption?.trim() || `[文档] ${item.document?.filename || "未命名文件"}`, messageType: "file" };
  if (item.type === "sticker") return { body: item.sticker?.animated ? "[动态贴纸]" : "[贴纸]", messageType: "image" };
  if (item.type === "location") {
    const location = item.location;
    return { body: `[位置] ${[location?.name, location?.address, location?.latitude, location?.longitude].filter((value) => value !== undefined && value !== "").join(" · ")}`, messageType: "system" };
  }
  if (item.type === "contacts") {
    const names = item.contacts?.map((contact) => contact.name?.formatted_name).filter(Boolean).join("、");
    return { body: `[联系人] ${names || "未命名联系人"}`, messageType: "system" };
  }
  if (item.type === "interactive") {
    const reply = item.interactive?.button_reply ?? item.interactive?.list_reply;
    return { body: `[交互回复] ${reply?.title || reply?.id || "未知选项"}`, messageType: "text" };
  }
  if (item.type === "button") return { body: `[按钮回复] ${item.button?.text || item.button?.payload || "未知按钮"}`, messageType: "text" };
  if (item.type === "reaction") return { body: `[回应 ${item.reaction?.message_id || ""}] ${item.reaction?.emoji || "已移除"}`, messageType: "system" };
  if (item.type === "order") return { body: `[订单] ${item.order?.product_items?.length ?? 0} 个商品`, messageType: "system" };
  if (item.type === "unsupported" || item.errors?.length) {
    return { body: `[Meta 不支持的消息] ${item.errors?.map((error) => error.title || error.message || error.code).filter(Boolean).join("；") || "请在手机端查看"}`, messageType: "system" };
  }
  return { body: `[${item.type || "未知"}消息]`, messageType: "system" };
}

export class MetaProvider implements ChannelProvider {
  private readonly connected = new Set<string>();
  private readonly connectionEpochs = new Map<string, number>();
  private readonly pendingSends = new Map<string, Promise<ChatMessage>>();
  private readonly graphBaseUrl: string;

  constructor(
    private readonly repository: Repository,
    private readonly encryption: EncryptionService,
    private readonly realtime: RealtimeHub,
    private readonly translation: TranslationService,
    config: AppConfig,
    private readonly intelligence?: ConversationIntelligenceService
  ) {
    this.graphBaseUrl = (config.metaGraphBaseUrl ?? "https://graph.facebook.com").replace(/\/+$/u, "");
  }

  async connect(accountId: string): Promise<void> {
    const connectionEpoch = (this.connectionEpochs.get(accountId) ?? 0) + 1;
    this.connectionEpochs.set(accountId, connectionEpoch);
    const account = await this.repository.getAccount(accountId);
    if (!account || account.provider !== "meta") throw new DomainError("META_ACCOUNT_NOT_FOUND", 404, "Meta account not found");
    const credential = await this.repository.getMetaCredentialSecret(accountId);
    if (!credential) throw new DomainError("META_NOT_CONFIGURED", 409, "Meta account is not configured");

    const connecting = await this.repository.updateAccountStatus(accountId, "connecting");
    this.realtime.publish("account.connection.changed", accountId, connecting);
    try {
      const authorization = `Bearer ${this.encryption.decrypt(credential.accessTokenCipher)}`;
      const url = this.graphUrl(credential.graphApiVersion, credential.phoneNumberId);
      url.searchParams.set("fields", "id,display_phone_number,verified_name,quality_rating");
      const response = await fetch(url, {
        headers: { authorization },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        throw new DomainError(
          response.status === 401 || response.status === 403 ? "META_CREDENTIAL_INVALID" : "META_GRAPH_UNAVAILABLE",
          response.status === 401 || response.status === 403 ? 422 : 502,
          `Meta Graph API validation failed (HTTP ${response.status})`
        );
      }
      const payload = (await response.json()) as {
        id?: string;
        display_phone_number?: string;
        verified_name?: string;
        quality_rating?: string;
      };
      if (payload.id !== credential.phoneNumberId) {
        throw new DomainError("META_PHONE_NUMBER_MISMATCH", 422, "Meta Phone Number ID validation mismatch");
      }
      const wabaUrl = this.graphUrl(credential.graphApiVersion, `${credential.wabaId}/phone_numbers`);
      wabaUrl.searchParams.set("fields", "id");
      wabaUrl.searchParams.set("limit", "100");
      const wabaResponse = await fetch(wabaUrl, {
        headers: { authorization },
        signal: AbortSignal.timeout(15_000)
      });
      if (!wabaResponse.ok) {
        throw new DomainError(
          wabaResponse.status === 401 || wabaResponse.status === 403 ? "META_CREDENTIAL_INVALID" : "META_GRAPH_UNAVAILABLE",
          wabaResponse.status === 401 || wabaResponse.status === 403 ? 422 : 502,
          `Meta WABA validation failed (HTTP ${wabaResponse.status})`
        );
      }
      const wabaPayload = (await wabaResponse.json()) as { data?: Array<{ id?: string }> };
      if (!wabaPayload.data?.some((phoneNumber) => phoneNumber.id === credential.phoneNumberId)) {
        throw new DomainError("META_WABA_MISMATCH", 422, "Meta Phone Number ID does not belong to the configured WABA");
      }
      const phone = normalizeDisplayPhone(payload.display_phone_number);
      if (phone) {
        const activeConflict = await this.repository.findActiveAccountByPhone(phone, accountId);
        if (activeConflict) {
          throw new DomainError(
            "PHONE_ACTIVE_ON_OTHER_ACCOUNT",
            409,
            `This WhatsApp number is already active on account “${activeConflict.name}”; pause that account before switching channels`
          );
        }
      }
      if (this.connectionEpochs.get(accountId) !== connectionEpoch) return;
      await this.repository.updateMetaVerification({
        accountId,
        enabled: true,
        displayPhoneNumber: payload.display_phone_number ?? null,
        verifiedName: payload.verified_name ?? null,
        qualityRating: payload.quality_rating ?? null
      });
      this.connected.add(accountId);
      const connected = await this.repository.updateAccountStatus(accountId, "connected", { phone, error: null });
      this.realtime.publish("account.connection.changed", accountId, connected);
    } catch (error) {
      if (this.connectionEpochs.get(accountId) !== connectionEpoch) return;
      this.connected.delete(accountId);
      const domainError =
        error instanceof DomainError
          ? error
          : new DomainError("META_GRAPH_UNAVAILABLE", 502, "Meta Graph API validation request failed");
      await this.repository.updateMetaVerification({ accountId, enabled: false, error: domainError.message });
      const failed = await this.repository.updateAccountStatus(
        accountId,
        domainError.code === "META_CREDENTIAL_INVALID" ||
          domainError.code === "META_PHONE_NUMBER_MISMATCH" ||
          domainError.code === "META_WABA_MISMATCH"
          ? "credential_invalid"
          : "degraded",
        { error: domainError.message }
      );
      this.realtime.publish("account.connection.changed", accountId, failed);
      throw domainError;
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const account = await this.repository.getAccount(accountId);
    if (!account || account.provider !== "meta") throw new DomainError("META_ACCOUNT_NOT_FOUND", 404, "Meta account not found");
    this.connectionEpochs.set(accountId, (this.connectionEpochs.get(accountId) ?? 0) + 1);
    this.connected.delete(accountId);
    await this.repository.setMetaSendingEnabled(accountId, false);
    const updated = await this.repository.updateAccountStatus(accountId, "logged_out");
    this.realtime.publish("account.connection.changed", accountId, updated);
  }

  async sendMessage(command: SendMessageCommand): Promise<ChatMessage> {
    const pendingKey = `${command.accountId}:${command.clientMessageId}`;
    const pending = this.pendingSends.get(pendingKey);
    if (pending) return pending;
    const send = this.sendMessageOnce(command);
    this.pendingSends.set(pendingKey, send);
    try {
      return await send;
    } finally {
      if (this.pendingSends.get(pendingKey) === send) this.pendingSends.delete(pendingKey);
    }
  }

  async sendTemplateMessage(command: SendTemplateMessageCommand): Promise<ChatMessage> {
    const pendingKey = `${command.accountId}:${command.clientMessageId}`;
    const pending = this.pendingSends.get(pendingKey);
    if (pending) return pending;
    const template = {
      name: command.templateName,
      language: { code: command.languageCode },
      ...(command.bodyParameters.length > 0
        ? {
            components: [{
              type: "body",
              parameters: command.bodyParameters.map((text) => ({ type: "text", text }))
            }]
          }
        : {})
    };
    const parameterSummary = command.bodyParameters.length > 0 ? ` · 参数：${command.bodyParameters.join(" | ")}` : "";
    const send = this.sendPreparedMessage(
      command,
      `[Meta 模板] ${command.templateName} (${command.languageCode})${parameterSummary}`,
      false,
      { type: "template", template }
    );
    this.pendingSends.set(pendingKey, send);
    try {
      return await send;
    } finally {
      if (this.pendingSends.get(pendingKey) === send) this.pendingSends.delete(pendingKey);
    }
  }

  private async sendMessageOnce(command: SendMessageCommand): Promise<ChatMessage> {
    return this.sendPreparedMessage(
      command,
      command.body,
      true,
      { type: "text", text: { preview_url: false, body: command.body } }
    );
  }

  // 统一处理 Meta 文本和模板发送，确保凭据、幂等与不确定结果语义一致。
  private async sendPreparedMessage(
    command: Pick<SendMessageCommand, "accountId" | "conversationId" | "clientMessageId">,
    storedBody: string,
    requiresServiceWindow: boolean,
    graphContent: Record<string, unknown>
  ): Promise<ChatMessage> {
    const account = await this.repository.getAccount(command.accountId);
    const conversation = await this.repository.getConversation(command.conversationId);
    const credential = await this.repository.getMetaCredentialSecret(command.accountId);
    if (!account || account.provider !== "meta" || account.status !== "connected" || !credential?.sendingEnabled) {
      throw new DomainError("ACCOUNT_NOT_CONNECTED", 409, "Selected account is not connected");
    }
    if (!conversation || conversation.accountId !== command.accountId) {
      throw new DomainError("ACCOUNT_CONVERSATION_MISMATCH", 409, "Account and conversation do not match");
    }

    const existing = await this.repository.findMessageByIdempotency(command.accountId, undefined, command.clientMessageId);
    if (existing) return existing;

    if (requiresServiceWindow) {
      const lastInboundAt = await this.repository.getLastInboundAt(conversation.id);
      const lastInboundTime = lastInboundAt ? new Date(lastInboundAt).getTime() : Number.NaN;
      if (!Number.isFinite(lastInboundTime) || Date.now() - lastInboundTime > META_SERVICE_WINDOW_MS) {
        throw new DomainError(
          "TEMPLATE_REQUIRED",
          409,
          "Outside the Meta 24-hour customer service window; an approved template is required"
        );
      }
    }

    if (!/^[1-9]\d{7,14}$/u.test(conversation.providerConversationId)) {
      throw new DomainError("INVALID_META_RECIPIENT", 422, "Meta recipient must be a valid WhatsApp ID");
    }

    const message = await this.repository.createMessage({
      accountId: command.accountId,
      conversationId: conversation.id,
      clientMessageId: command.clientMessageId,
      direction: "outbound",
      body: storedBody,
      status: "sending",
      sourceLanguage: detectLanguage(storedBody)
    });
    this.realtime.publish("message.accepted", command.accountId, message);

    try {
      const response = await fetch(this.graphUrl(credential.graphApiVersion, `${credential.phoneNumberId}/messages`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.encryption.decrypt(credential.accessTokenCipher)}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: conversation.providerConversationId,
          ...graphContent
        }),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) {
        const status = response.status >= 400 && response.status < 500 && response.status !== 408 ? "failed" : "unknown";
        const updated = await this.repository.updateMessageStatus(message.id, status);
        this.realtime.publish("message.status.changed", command.accountId, updated);
        throw new DomainError(
          status === "failed" ? "META_SEND_REJECTED" : "META_SEND_UNCERTAIN",
          status === "failed" ? 422 : 502,
          `Meta Graph API send failed (HTTP ${response.status})`
        );
      }
      const payload = (await response.json()) as { messages?: Array<{ id?: string }> };
      const providerMessageId = payload.messages?.[0]?.id;
      if (!providerMessageId) {
        const unknown = await this.repository.updateMessageStatus(message.id, "unknown");
        this.realtime.publish("message.status.changed", command.accountId, unknown);
        throw new DomainError("META_SEND_UNCERTAIN", 502, "Meta Graph API did not return a message ID");
      }
      const accepted = await this.repository.updateMessageStatus(message.id, "accepted", providerMessageId);
      this.realtime.publish("message.status.changed", command.accountId, accepted);
      void this.translation.processIncoming(accepted).catch(() => {
        this.publishTranslationFailure(command.accountId);
      });
      return accepted;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const unknown = await this.repository.updateMessageStatus(message.id, "unknown");
      this.realtime.publish("message.status.changed", command.accountId, unknown);
      throw new DomainError("META_SEND_UNCERTAIN", 502, "Meta Graph API send result is unknown");
    }
  }

  async syncContacts(accountId: string): Promise<ContactSyncResult> {
    const account = await this.repository.getAccount(accountId);
    if (!account || account.provider !== "meta") throw new DomainError("META_ACCOUNT_NOT_FOUND", 404, "Meta account not found");
    const contacts = await this.repository.listContacts(accountId);
    const result = {
      count: contacts.length,
      note: "Meta standard Cloud API does not expose a full address book; this count only includes known interactions, manual contacts, and CRM imports."
    };
    this.realtime.publish("contact.sync.progress", accountId, { status: "completed", ...result });
    return result;
  }

  async resolveContactAddress(accountId: string, phone: string): Promise<string | null> {
    const account = await this.repository.getAccount(accountId);
    if (!account || account.provider !== "meta") throw new DomainError("META_ACCOUNT_NOT_FOUND", 404, "Meta account not found");
    return isE164PhoneNumber(phone) ? phone.slice(1) : null;
  }

  activeConnectionCount(): number {
    return this.connected.size;
  }

  shutdown(): void {
    this.connected.clear();
    this.connectionEpochs.clear();
    this.pendingSends.clear();
  }

  async verifyWebhookSubscription(webhookKey: string, mode: string, verifyToken: string): Promise<boolean> {
    if (mode !== "subscribe") return false;
    const app = await this.repository.getMetaAppSecretByWebhookKey(webhookKey);
    if (!app) return false;
    const actualDigest = createHash("sha256").update(verifyToken, "utf8").digest("hex");
    return maskSafeEqual(actualDigest, app.verifyTokenDigest);
  }

  async handleWebhook(webhookKey: string, signature: string | undefined, rawBody: Buffer): Promise<void> {
    const app = await this.repository.getMetaAppSecretByWebhookKey(webhookKey);
    if (!app) throw new DomainError("META_WEBHOOK_NOT_FOUND", 404, "Meta webhook configuration not found");
    const signatureHex = signature?.startsWith("sha256=") ? signature.slice(7) : "";
    const expected = createHmac("sha256", this.encryption.decrypt(app.appSecretCipher)).update(rawBody).digest("hex");
    if (!maskSafeEqual(signatureHex, expected)) {
      throw new DomainError("META_WEBHOOK_SIGNATURE_INVALID", 401, "Invalid Meta webhook signature");
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as MetaWebhookPayload;
    } catch {
      throw new DomainError("META_WEBHOOK_INVALID_JSON", 400, "Invalid Meta webhook JSON");
    }
    const event = await this.repository.createMetaWebhookEvent({
      appConfigId: app.id,
      eventHash: createHash("sha256").update(rawBody).digest("hex"),
      payloadCipher: this.encryption.encrypt(rawBody.toString("utf8"))
    });
    const claimed = await this.repository.claimMetaWebhookEvent(event.id, {
      maxAttempts: 8,
      staleBefore: new Date(Date.now() - 5 * 60 * 1_000).toISOString()
    });
    if (!claimed) return;

    try {
      await this.processWebhookPayload(payload, app.id);
      await this.repository.markMetaWebhookEventProcessed(claimed.id);
    } catch (error) {
      await this.repository.markMetaWebhookEventFailed(
        claimed.id,
        error instanceof Error ? error.message : "Meta webhook processing failed"
      );
      throw error;
    }
  }

  async recoverPendingWebhookEvents(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const candidates = await this.repository.listRecoverableMetaWebhookEvents({
      maxAttempts: 8,
      staleBefore: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
      limit: 100
    });
    for (const event of candidates) {
      const claimed = await this.repository.claimMetaWebhookEvent(event.id, {
        maxAttempts: 8,
        staleBefore: new Date(Date.now() - 5 * 60 * 1_000).toISOString()
      });
      if (!claimed) continue;
      try {
        const rawBody = this.encryption.decrypt(claimed.payloadCipher);
        const payload = JSON.parse(rawBody) as MetaWebhookPayload;
        await this.processWebhookPayload(payload, claimed.appConfigId);
        await this.repository.markMetaWebhookEventProcessed(claimed.id);
        processed += 1;
      } catch (error) {
        await this.repository.markMetaWebhookEventFailed(
          claimed.id,
          error instanceof Error ? error.message : "Meta webhook recovery failed"
        );
        failed += 1;
      }
    }
    return { processed, failed };
  }

  private async processWebhookPayload(payload: MetaWebhookPayload, appConfigId: string): Promise<void> {
    if (payload.object !== "whatsapp_business_account") return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value?.metadata?.phone_number_id) continue;
        const credential = await this.repository.getMetaCredentialByPhoneNumberId(change.value.metadata.phone_number_id);
        if (!credential || credential.appConfigId !== appConfigId || (entry.id && entry.id !== credential.wabaId)) {
          await this.repository.audit("meta.webhook.orphan", "meta_app", appConfigId, "ignored", {
            phoneNumberId: change.value.metadata.phone_number_id
          });
          continue;
        }
        await this.repository.touchMetaWebhook(credential.accountId);
        const account = await this.repository.getAccount(credential.accountId);
        if (!credential.sendingEnabled || account?.status !== "connected") {
          await this.processStatuses(credential.accountId, change.value);
          await this.repository.audit("meta.webhook.paused", "account", credential.accountId, "ignored", {
            inboundMessages: change.value.messages?.length ?? 0
          });
          continue;
        }
        await this.processInboundMessages(credential.accountId, change.value);
        await this.processStatuses(credential.accountId, change.value);
      }
    }
  }

  private async processInboundMessages(accountId: string, value: MetaWebhookValue): Promise<void> {
    for (const item of value.messages ?? []) {
      if (!item.id || !item.from) continue;
      const phone = `+${item.from}`;
      if (!isE164PhoneNumber(phone)) continue;
      const existing = await this.repository.findMessageByIdempotency(accountId, item.id);
      if (existing) continue;
      const profile = value.contacts?.find((contact) => contact.wa_id === item.from)?.profile;
      const contact = await this.repository.upsertContact({
        accountId,
        providerContactId: item.from,
        displayName: profile?.name,
        phone,
        source: "meta",
        origin: "inbound_message"
      });
      const conversation = await this.repository.upsertConversation({
        accountId,
        contactId: contact.id,
        providerConversationId: item.from
      });
      const content = inboundMessageContent(item);
      const message = await this.repository.createMessage({
        accountId,
        conversationId: conversation.id,
        providerMessageId: item.id,
        direction: "inbound",
        messageType: content.messageType,
        body: content.body,
        status: "delivered",
        sourceLanguage: content.messageType === "text" ? detectLanguage(content.body) : null,
        occurredAt: webhookTimestamp(item.timestamp)
      });
      this.realtime.publish("contact.upserted", accountId, contact);
      this.realtime.publish("conversation.upserted", accountId, conversation);
      this.realtime.publish("message.received", accountId, message);

      const accountOwner = await this.repository.getAccount(accountId);
      const preference = await this.repository.getTranslationPreference(accountOwner?.ownerUserId ?? undefined);
      if (preference.crmAutoCreate && !contact.crmContactId) {
        const crmContact = await this.repository.createCrmContact(contact.id);
        this.realtime.publish("crm.contact.created", accountId, crmContact);
      }
      void this.translation.processIncoming(message).catch(() => {
        this.publishTranslationFailure(accountId);
      });
      void this.intelligence?.analyzeConversation(conversation.id).catch(() => undefined);
    }
  }

  private async processStatuses(accountId: string, value: MetaWebhookValue): Promise<void> {
    for (const item of value.statuses ?? []) {
      const status = metaStatus(item.status);
      if (!item.id || !status) continue;
      const existing = await this.repository.findMessageByIdempotency(accountId, item.id);
      if (!existing) continue;
      const updated = await this.repository.updateMessageStatusMonotonic(existing.id, status);
      this.realtime.publish("message.status.changed", accountId, {
        ...updated,
        providerOccurredAt: webhookTimestamp(item.timestamp) ?? null
      });
    }
  }

  private graphUrl(version: string, resource: string): URL {
    return new URL(`${this.graphBaseUrl}/${version}/${resource}`);
  }

  private publishTranslationFailure(accountId: string): void {
    this.realtime.publish("provider.event.failed", accountId, {
      provider: "meta",
      event: "translation.processIncoming",
      error: "Automatic translation failed"
    });
  }
}
