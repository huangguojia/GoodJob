import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * 开发信打开/点击追踪。
 *
 * 设计要点：
 * - 只有配置了公网可达的 EMAIL_TRACKING_BASE_URL 时才注入追踪，否则完全退回纯文本发送（本地开发不受影响）。
 * - 追踪链接全部带 HMAC 签名，点击跳转只信任签名内的目标地址，避免成为开放重定向。
 * - messageId 与 SMTP 的 Message-ID 一致，用于把打开/点击/回信/退信全部挂回同一封发出的邮件。
 */

const DEV_TRACKING_SECRET = "goodjob-crm-dev-email-tracking-secret";
const SIGNATURE_LENGTH = 32;

export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export function emailTrackingSecret() {
  const configured =
    process.env.EMAIL_TRACKING_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (configured && configured.length >= 16) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置至少 16 个字符的 EMAIL_TRACKING_SECRET 或 JWT_SECRET");
  }
  return DEV_TRACKING_SECRET;
}

export function emailTrackingBaseUrl() {
  const raw = process.env.EMAIL_TRACKING_BASE_URL?.trim() || "";
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

export function isEmailTrackingEnabled() {
  return Boolean(emailTrackingBaseUrl());
}

export function validateEmailTrackingSecurity() {
  const baseUrl = emailTrackingBaseUrl();
  if (!baseUrl) return;
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    throw new Error("生产环境 EMAIL_TRACKING_BASE_URL 必须使用 HTTPS");
  }
  emailTrackingSecret();
}

export function messageIdDomain() {
  const base = emailTrackingBaseUrl();
  if (base) {
    try {
      return new URL(base).hostname;
    } catch {
      /* ignore */
    }
  }
  return process.env.EMAIL_MESSAGE_ID_DOMAIN?.trim() || "goodjob-crm.local";
}

export function buildOutboundMessageId(prefix = "gj") {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "") || "gj";
  return `<${safePrefix}-${randomUUID()}@${messageIdDomain()}>`;
}

export function normalizeMessageIdValue(value: string) {
  return (value || "").trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

function encodePart(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string) {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded || "";
  } catch {
    return "";
  }
}

function sign(payload: string) {
  return createHmac("sha256", emailTrackingSecret())
    .update(payload)
    .digest("hex")
    .slice(0, SIGNATURE_LENGTH);
}

function signatureMatches(expected: string, received: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(received || "");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildOpenPixelUrl(messageId: string) {
  const base = emailTrackingBaseUrl();
  if (!base) return "";
  const normalized = normalizeMessageIdValue(messageId);
  if (!normalized) return "";
  const token = encodePart(normalized);
  return `${base}/api/email/track/open/${token}.gif?s=${sign(`open:${normalized}`)}`;
}

export function buildClickTrackingUrl(messageId: string, targetUrl: string) {
  const base = emailTrackingBaseUrl();
  if (!base) return targetUrl;
  const normalized = normalizeMessageIdValue(messageId);
  if (!normalized || !/^https?:\/\//i.test(targetUrl)) return targetUrl;
  const token = encodePart(normalized);
  const target = encodePart(targetUrl);
  const signature = sign(`click:${normalized}:${targetUrl}`);
  return `${base}/api/email/track/click/${token}?u=${target}&s=${signature}`;
}

export function verifyOpenToken(token: string, signature: string) {
  const normalized = normalizeMessageIdValue(decodePart(token.replace(/\.gif$/i, "")));
  if (!normalized) return "";
  return signatureMatches(sign(`open:${normalized}`), signature) ? normalized : "";
}

export function verifyClickToken(token: string, encodedUrl: string, signature: string) {
  const normalized = normalizeMessageIdValue(decodePart(token));
  const targetUrl = decodePart(encodedUrl);
  if (!normalized || !/^https?:\/\//i.test(targetUrl)) return null;
  if (!signatureMatches(sign(`click:${normalized}:${targetUrl}`), signature)) return null;
  return { messageId: normalized, targetUrl };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * 把纯文本正文转成带追踪的 HTML：链接改写为可追踪跳转，末尾追加 1x1 追踪像素。
 * 未开启追踪时返回 null，调用方继续按纯文本发送。
 */
export function buildTrackedEmailHtml(body: string, messageId: string) {
  if (!isEmailTrackingEnabled()) return null;
  const normalized = normalizeMessageIdValue(messageId);
  if (!normalized) return null;
  const text = body || "";
  let cursor = 0;
  let html = "";
  let linkCount = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    html += escapeHtml(text.slice(cursor, index));
    const rawUrl = match[0];
    const tracked = buildClickTrackingUrl(normalized, rawUrl);
    html += `<a href="${escapeHtml(tracked)}" target="_blank" rel="noopener">${escapeHtml(rawUrl)}</a>`;
    linkCount += 1;
    cursor = index + rawUrl.length;
  }
  html += escapeHtml(text.slice(cursor));
  html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br />");
  const pixel = buildOpenPixelUrl(normalized);
  const pixelTag = pixel
    ? `<img src="${escapeHtml(pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`
    : "";
  return {
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#16223b;"><div>${html}</div>${pixelTag}</body></html>`,
    linkCount,
    hasPixel: Boolean(pixel)
  };
}
