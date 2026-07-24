import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { ChatMessage, Translation } from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { DomainError } from "../errors.js";
import { RealtimeHub } from "../realtime.js";
import { EncryptionService } from "../security/encryption.js";

const mockTranslations = new Map<string, string>([
  ["Hola, nos interesan 500 unidades. ¿Podrían compartir el precio FOB?", "您好，我们对 500 件产品感兴趣。可以提供 FOB 报价吗？"],
  ["Necesitamos muestras antes de confirmar el pedido.", "我们需要先收到样品，再确认订单。"],
  ["Could you confirm the lead time for the custom packaging?", "可以确认定制包装的交货周期吗？"],
  ["Can you send the latest catalog?", "可以发送最新的产品目录吗？"],
  ["¿Cuál es la cantidad mínima de pedido?", "最小起订量是多少？"]
]);

function normalizeLanguage(language: string): string {
  return language.toLowerCase().split("-")[0];
}

export function detectLanguage(text: string): string {
  if (/[一-鿿]/u.test(text)) return "zh";
  if (/[а-яё]/iu.test(text)) return "ru";
  if (/\b(hola|gracias|pedido|precio|muestras|necesitamos|cuál|pueden|podrían)\b/iu.test(text)) return "es";
  if (/\b(olá|obrigado|preço|pedido|amostras|vocês)\b/iu.test(text)) return "pt";
  if (/\b(bonjour|merci|prix|commande|échantillon)\b/iu.test(text)) return "fr";
  return "en";
}

function isTranslatable(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /^\d+([.,]\d+)?$/u.test(trimmed)) return false;
  if (/^(https?:\/\/|www\.)\S+$/iu.test(trimmed)) return false;
  if (/^[\p{Emoji}\p{Emoji_Presentation}\s]+$/u.test(trimmed)) return false;
  return /\p{L}/u.test(trimmed);
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0.0.0.0") return true;
  if (address.startsWith("10.") || address.startsWith("127.") || address.startsWith("192.168.")) return true;
  if (address.startsWith("169.254.") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const match = address.match(/^172\.(\d+)\./u);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export class TranslationService {
  constructor(
    private readonly repository: Repository,
    private readonly encryption: EncryptionService,
    private readonly realtime: RealtimeHub,
    private readonly config: AppConfig
  ) {}

  async processIncoming(message: ChatMessage): Promise<Translation | null> {
    const ownerUserId = await this.repository.getMessageOwnerUserId(message.id);
    const preference = await this.repository.getTranslationPreference(ownerUserId ?? undefined);
    if (!preference.autoTranslate) return null;
    return this.translate(message.id, "automatic");
  }

  async translate(messageId: string, trigger: "automatic" | "manual"): Promise<Translation | null> {
    const message = await this.repository.getMessage(messageId);
    if (!message || !isTranslatable(message.body)) return null;

    const ownerUserId = await this.repository.getMessageOwnerUserId(message.id);
    const preference = await this.repository.getTranslationPreference(ownerUserId ?? undefined);
    const sourceLanguage = message.sourceLanguage ?? detectLanguage(message.body);
    if (normalizeLanguage(sourceLanguage) === normalizeLanguage(preference.targetLanguage)) return null;
    if (trigger === "automatic" && !preference.autoTranslate) return null;
    if (!preference.providerId) {
      if (trigger === "automatic") return null;
      throw new DomainError("AI_PROVIDER_NOT_CONFIGURED", 409, "Configure an AI Provider before translating messages");
    }

    const profile = await this.repository.getAiProfile(preference.providerId, ownerUserId ?? undefined);
    if (!profile || !profile.enabled) throw new Error("AI Provider is unavailable");

    const pending = await this.repository.createPendingTranslation({
      messageId: message.id,
      sourceLanguage,
      targetLanguage: preference.targetLanguage,
      profileId: profile.id,
      model: profile.model,
      trigger
    });
    if (pending.status === "translated") return pending;

    this.realtime.publish("translation.started", message.accountId, pending);
    try {
      const result =
        profile.kind === "mock"
          ? this.mockTranslate(message.body, preference.targetLanguage)
          : await this.openAiTranslate(
              profile.baseUrl,
              profile.apiKeyCipher,
              profile.model,
              message.body,
              sourceLanguage,
              preference.targetLanguage
            );
      const completed = await this.repository.completeTranslation(pending.id, result.text, result.tokenUsage);
      this.realtime.publish("translation.completed", message.accountId, completed);
      return completed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown translation error";
      const failed = await this.repository.failTranslation(pending.id, reason);
      this.realtime.publish("translation.failed", message.accountId, failed);
      return failed;
    }
  }

  async testProvider(profileId: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const profile = await this.repository.getAiProfile(profileId);
    if (!profile) return { ok: false, error: "AI Provider not found" };
    try {
      const result =
        profile.kind === "mock"
          ? this.mockTranslate("Can you send the latest catalog?", "zh-CN")
          : await this.openAiTranslate(profile.baseUrl, profile.apiKeyCipher, profile.model, "Hello", "en", "zh-CN");
      await this.repository.updateAiProfileTest(profile.id, "success", null);
      return { ok: true, text: result.text };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown provider error";
      await this.repository.updateAiProfileTest(profile.id, "failed", reason);
      return { ok: false, error: reason };
    }
  }

  private mockTranslate(text: string, targetLanguage: string): { text: string; tokenUsage: number } {
    const translated = mockTranslations.get(text) ?? `[${targetLanguage} 模拟译文] ${text}`;
    return { text: translated, tokenUsage: Math.ceil((text.length + translated.length) / 3) };
  }

  private async openAiTranslate(
    baseUrl: string | null,
    apiKeyCipher: string | null,
    model: string,
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<{ text: string; tokenUsage: number }> {
    if (!baseUrl) throw new Error("AI Base URL is not configured");
    if (!apiKeyCipher) throw new Error("AI API Key is not configured");
    const endpoint = await this.validateEndpoint(baseUrl);
    const apiKey = this.encryption.decrypt(apiKeyCipher);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a precise B2B trade translator. Preserve names, numbers, currencies, dates, model numbers, URLs, paragraphs and tone. Return only the translation."
          },
          {
            role: "user",
            content: `Translate from ${sourceLanguage} to ${targetLanguage}:\n\n${text}`
          }
        ]
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const safeBody = (await response.text()).slice(0, 300);
      throw new Error(`AI request failed (${response.status}): ${safeBody}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const translated = payload.choices?.[0]?.message?.content?.trim();
    if (!translated) throw new Error("AI response did not contain translated text");
    return { text: translated, tokenUsage: payload.usage?.total_tokens ?? 0 };
  }

  private async validateEndpoint(baseUrl: string): Promise<string> {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !(this.config.allowPrivateAiEndpoints && url.protocol === "http:")) {
      throw new Error("AI Base URL must use HTTPS");
    }
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
    if (!this.config.allowPrivateAiEndpoints && addresses.some((item) => isPrivateAddress(item.address))) {
      throw new Error("Private AI endpoints are disabled");
    }
    const normalized = url.toString().replace(/\/$/u, "");
    if (normalized.endsWith("/chat/completions")) return normalized;
    return normalized.endsWith("/v1") ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
  }
}
