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

/** 运行时覆盖（app_settings 持久化，服务器启动时加载），优先于 env */
let runtimeBaseUrl = "";

export function setEmailTrackingRuntimeBaseUrl(value: string) {
  const raw = (value || "").trim();
  runtimeBaseUrl = /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, "") : "";
}

export function getEmailTrackingRuntimeBaseUrl() {
  return runtimeBaseUrl;
}

export function emailTrackingBaseUrl() {
  const raw = runtimeBaseUrl || process.env.EMAIL_TRACKING_BASE_URL?.trim() || "";
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

/** 供设置页展示：追踪状态与配置来源 */
export function emailTrackingStatus() {
  const base = emailTrackingBaseUrl();
  return {
    enabled: Boolean(base),
    baseUrl: base,
    source: runtimeBaseUrl ? "app_settings" : process.env.EMAIL_TRACKING_BASE_URL?.trim() ? "env" : "none"
  };
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
 *
 * trackingOptional=true（邮件中心手工写信）时：即使没开追踪也返回 HTML 版式，
 * 保证「撰写框里看到的」与「收件人收到的」字体版式一致（只是没有链接改写和像素）。
 */
export function buildTrackedEmailHtml(body: string, messageId: string, options?: { trackingOptional?: boolean }) {
  const trackingOptional = options?.trackingOptional === true;
  if (!isEmailTrackingEnabled() && !trackingOptional) return null;
  const trackingOn = isEmailTrackingEnabled();
  const normalized = normalizeMessageIdValue(messageId);
  if (!normalized && !trackingOptional) return null;
  const text = body || "";
  let cursor = 0;
  let html = "";
  let linkCount = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    html += escapeHtml(text.slice(cursor, index));
    const rawUrl = match[0];
    const tracked = trackingOn ? buildClickTrackingUrl(normalized, rawUrl) : rawUrl;
    html += `<a href="${escapeHtml(tracked)}" target="_blank" rel="noopener">${escapeHtml(rawUrl)}</a>`;
    linkCount += 1;
    cursor = index + rawUrl.length;
  }
  html += escapeHtml(text.slice(cursor));
  html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br />");
  const pixel = trackingOn ? buildOpenPixelUrl(normalized) : "";
  const pixelTag = pixel
    ? `<img src="${escapeHtml(pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`
    : "";
  return {
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#16223b;"><div>${html}</div>${pixelTag}</body></html>`,
    linkCount,
    hasPixel: Boolean(pixel)
  };
}

/**
 * 富文本（HTML）正文：走同样的「链接改写 + 追踪像素 + 基础版式包装」管线。
 * 与 buildTrackedEmailHtml 的差别只在输入是 HTML 片段而非纯文本。
 * 传入前调用方负责做基础消毒（去 script/iframe/on* 属性）。
 */
export function buildTrackedHtmlBody(fragmentHtml: string, messageId: string, options?: { trackingOptional?: boolean }) {
  const trackingOptional = options?.trackingOptional === true;
  if (!isEmailTrackingEnabled() && !trackingOptional) return null;
  const trackingOn = isEmailTrackingEnabled();
  const normalized = normalizeMessageIdValue(messageId);
  if (!normalized && !trackingOptional) return null;
  let html = fragmentHtml || "";
  let linkCount = 0;
  if (trackingOn) {
    html = html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (match, url: string) => {
      linkCount += 1;
      return `href="${escapeHtml(buildClickTrackingUrl(normalized, url))}"`;
    });
  }
  const pixel = trackingOn ? buildOpenPixelUrl(normalized) : "";
  const pixelTag = pixel
    ? `<img src="${escapeHtml(pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`
    : "";
  return {
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#16223b;"><div>${html}</div>${pixelTag}</body></html>`,
    linkCount,
    hasPixel: Boolean(pixel)
  };
}

/** 富文本正文的基础消毒：去 script/iframe/object/embed/style 标签与 on* 事件属性、javascript: 链接。 */
export function sanitizeEmailHtml(input: string) {
  return (input || "")
    .replace(/<\s*(script|iframe|object|embed|style|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|style|link|meta)\b[^>]*\/?\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/href\s*=\s*"\s*javascript:[^"]*"/gi, 'href="#"');
}

export interface InlineImageAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
}

/**
 * 抽出正文里的 data URI 内嵌图，替换为 cid: 引用并返回附件列表。
 * Gmail / Outlook 会吞 data URI 图片，只有 multipart/related 的 CID 内嵌图才能在对方邮箱显示。
 * 上限默认 10 张，超出原样保留（由外层总量守门兜底）。
 */
export function extractInlineDataImages(html: string, options?: { cidPrefix?: string; maxImages?: number }) {
  const images: InlineImageAttachment[] = [];
  const max = Math.max(1, options?.maxImages ?? 10);
  const prefix = (options?.cidPrefix || `mcimg-${Date.now().toString(36)}`).replace(/[^\w.-]/g, "");
  const next = (html || "").replace(
    /<img[^>]*\ssrc="data:image\/([^;]+);base64,([^"]+)"[^>]*>/gi,
    (match, ext: string, base64: string) => {
      if (images.length >= max) return match;
      const cleanExt = /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : "png";
      const cid = `${prefix}-${images.length + 1}@mail.inline`;
      images.push({
        filename: `inline-${images.length + 1}.${cleanExt === "jpeg" ? "jpg" : cleanExt}`,
        content: Buffer.from(base64, "base64"),
        contentType: `image/${cleanExt}`,
        cid
      });
      return match.replace(/src="[^"]*"/i, `src="cid:${cid}"`);
    }
  );
  return { html: next, images };
}
