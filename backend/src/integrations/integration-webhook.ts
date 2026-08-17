import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface NormalizedWebhookNotification {
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export function deriveWebhookSecret(masterKey: string, context: {
  teamId: string;
  ownerId: string;
  connectionId: string;
  webhookPublicId: string;
}) {
  if (masterKey.trim().length < 32) webhookError("INTEGRATION_WEBHOOK_NOT_CONFIGURED", "Webhook 主密钥无效", 503);
  return createHmac("sha256", masterKey)
    .update(`goodjob-webhook-v1\n${context.teamId}\n${context.ownerId}\n${context.connectionId}\n${context.webhookPublicId}`)
    .digest("base64url");
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function constantTimeTextEqual(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

function webhookError(code: string, message: string, status = 401): never {
  throw Object.assign(new Error(message), { code, status });
}

export function verifyHmacWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string;
  nonce: string;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}) {
  if (input.secret.length < 32) webhookError("INTEGRATION_WEBHOOK_NOT_CONFIGURED", "Webhook 密钥无效", 503);
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.nonce)) {
    webhookError("INTEGRATION_WEBHOOK_SIGNATURE_INVALID", "Webhook nonce 无效");
  }
  const parts = Object.fromEntries(input.signatureHeader.split(",").map((item) => {
    const [key, ...rest] = item.trim().split("=");
    return [key, rest.join("=")];
  }));
  const timestamp = Number(parts.t || "");
  const supplied = String(parts.v1 || "").toLowerCase();
  if (!Number.isInteger(timestamp) || !/^[a-f0-9]{64}$/u.test(supplied)) {
    webhookError("INTEGRATION_WEBHOOK_SIGNATURE_INVALID", "Webhook 签名格式无效");
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  if (Math.abs(nowSeconds - timestamp) > (input.toleranceSeconds ?? 300)) {
    webhookError("INTEGRATION_WEBHOOK_EXPIRED", "Webhook 请求时间已超出允许窗口");
  }
  const signed = Buffer.concat([
    Buffer.from(`${timestamp}.${input.nonce}.`, "utf8"),
    input.rawBody
  ]);
  const expected = createHmac("sha256", input.secret).update(signed).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) {
    webhookError("INTEGRATION_WEBHOOK_SIGNATURE_INVALID", "Webhook 签名校验失败");
  }
  return { timestamp, payloadHash: sha256(input.rawBody) };
}

function microsoftNotifications(body: unknown, clientState: string): NormalizedWebhookNotification[] {
  const value = body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).value)
    ? (body as { value: unknown[] }).value : [];
  if (!value.length || value.length > 100) {
    webhookError("INTEGRATION_WEBHOOK_PAYLOAD_INVALID", "Microsoft Graph 通知内容无效", 400);
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      webhookError("INTEGRATION_WEBHOOK_PAYLOAD_INVALID", "Microsoft Graph 通知项无效", 400);
    }
    const item = raw as Record<string, unknown>;
    if (!constantTimeTextEqual(String(item.clientState || ""), clientState)) {
      webhookError("INTEGRATION_WEBHOOK_SIGNATURE_INVALID", "Microsoft Graph clientState 校验失败");
    }
    const resourceData = item.resourceData && typeof item.resourceData === "object"
      ? item.resourceData as Record<string, unknown> : {};
    const stablePayload = JSON.stringify(item);
    const externalEventId = String(item.id || "").trim()
      || `ms_${sha256(stablePayload).slice(0, 60)}`;
    const changeType = String(item.changeType || item.lifecycleEvent || "changed").slice(0, 40);
    const resourceType = String(resourceData["@odata.type"] || item.resource || "resource").slice(0, 50);
    return {
      externalEventId: externalEventId.slice(0, 200),
      eventType: `microsoft.${resourceType.replace(/^#?microsoft\.graph\./u, "")}.${changeType}`.slice(0, 100),
      payload: item
    };
  });
}

export function normalizeVerifiedWebhook(input: {
  connectorCode: string;
  body: unknown;
  rawBody: Buffer;
  secret: string;
  signatureHeader?: string;
  nonce?: string;
  eventId?: string;
  eventType?: string;
  nowMs?: number;
}): { payloadHash: string; notifications: NormalizedWebhookNotification[] } {
  if (input.connectorCode === "microsoft-365") {
    return {
      payloadHash: sha256(input.rawBody),
      notifications: microsoftNotifications(input.body, input.secret)
    };
  }
  const verified = verifyHmacWebhookSignature({
    rawBody: input.rawBody,
    signatureHeader: String(input.signatureHeader || ""),
    nonce: String(input.nonce || ""),
    secret: input.secret,
    nowMs: input.nowMs
  });
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body)
    ? input.body as Record<string, unknown> : {};
  const externalEventId = String(input.eventId || body.id || body.eventId || "").trim();
  if (!/^[A-Za-z0-9._:@/-]{1,200}$/u.test(externalEventId)) {
    webhookError("INTEGRATION_WEBHOOK_EVENT_ID_INVALID", "Webhook 缺少稳定事件 ID", 400);
  }
  const eventType = String(input.eventType || body.type || body.eventType || "event").trim().slice(0, 100);
  return {
    payloadHash: verified.payloadHash,
    notifications: [{ externalEventId, eventType, payload: body }]
  };
}

export function createWebhookSignature(rawBody: Buffer, secret: string, timestamp: number, nonce: string) {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.${nonce}.`, "utf8"), rawBody]);
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(signed).digest("hex")}`;
}
