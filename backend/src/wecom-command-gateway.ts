import { createHash, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

export interface WeComCallbackConfig {
  corpId: string;
  callbackToken: string;
  encodingAesKey: string;
}

export interface WeComInboundMessage {
  toUserName: string;
  fromUserName: string;
  createTime: string;
  msgType: string;
  content: string;
  msgId: string;
  agentId: string;
}

function xmlDecode(value: string) {
  return value.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlValue(xml: string, tag: string) {
  const pattern = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, "i");
  const match = xml.match(pattern);
  return xmlDecode(String(match?.[1] ?? match?.[2] ?? "").trim());
}

function paddedKey(encodingAesKey: string) {
  const raw = Buffer.from(`${encodingAesKey.trim()}=`, "base64");
  if (raw.length !== 32) throw new Error("企业微信 EncodingAESKey 无效");
  return raw;
}

function pkcs7Unpad(value: Buffer) {
  if (!value.length) throw new Error("企业微信消息为空");
  const pad = value[value.length - 1] || 0;
  if (pad < 1 || pad > 32 || pad > value.length) throw new Error("企业微信消息填充无效");
  for (let index = value.length - pad; index < value.length; index += 1) {
    if (value[index] !== pad) throw new Error("企业微信消息填充无效");
  }
  return value.subarray(0, value.length - pad);
}

function pkcs7Pad(value: Buffer) {
  const remainder = value.length % 32;
  const pad = remainder === 0 ? 32 : 32 - remainder;
  return Buffer.concat([value, Buffer.alloc(pad, pad)]);
}

export function weComSignature(token: string, timestamp: string, nonce: string, encrypted: string) {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

export function assertWeComSignature(input: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
  signature: string;
}) {
  const expected = weComSignature(input.token, input.timestamp, input.nonce, input.encrypted);
  const actual = String(input.signature || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(actual)) throw new Error("企业微信签名格式无效");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new Error("企业微信签名校验失败");
}

export function decryptWeComMessage(encrypted: string, encodingAesKey: string, expectedCorpId = "") {
  const key = paddedKey(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]));
  if (plain.length < 20) throw new Error("企业微信消息结构无效");
  const messageLength = plain.readUInt32BE(16);
  if (messageLength < 1 || messageLength > plain.length - 20) throw new Error("企业微信消息长度无效");
  const message = plain.subarray(20, 20 + messageLength).toString("utf8");
  const corpId = plain.subarray(20 + messageLength).toString("utf8");
  if (expectedCorpId && corpId !== expectedCorpId) throw new Error("企业微信 CorpID 不匹配");
  return message;
}

export function encryptWeComMessage(message: string, config: WeComCallbackConfig, timestamp = String(Math.floor(Date.now() / 1000)), nonce = "goodjob") {
  const key = paddedKey(config.encodingAesKey);
  const content = Buffer.from(message, "utf8");
  const corpId = Buffer.from(config.corpId, "utf8");
  const plain = pkcs7Pad(Buffer.concat([Buffer.alloc(16), Buffer.from([content.length >>> 24, content.length >>> 16 & 255, content.length >>> 8 & 255, content.length & 255]), content, corpId]));
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
  return {
    encrypted,
    signature: weComSignature(config.callbackToken, timestamp, nonce, encrypted),
    timestamp,
    nonce
  };
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildWeComEncryptedReply(envelope: ReturnType<typeof encryptWeComMessage>) {
  return `<xml><Encrypt><![CDATA[${envelope.encrypted}]]></Encrypt><MsgSignature>${xmlEscape(envelope.signature)}</MsgSignature><TimeStamp>${xmlEscape(envelope.timestamp)}</TimeStamp><Nonce>${xmlEscape(envelope.nonce)}</Nonce></xml>`;
}

export function parseWeComInboundMessage(xml: string): WeComInboundMessage {
  const message = {
    toUserName: xmlValue(xml, "ToUserName"),
    fromUserName: xmlValue(xml, "FromUserName"),
    createTime: xmlValue(xml, "CreateTime"),
    msgType: xmlValue(xml, "MsgType").toLowerCase(),
    content: xmlValue(xml, "Content").slice(0, 2_000),
    msgId: xmlValue(xml, "MsgId"),
    agentId: xmlValue(xml, "AgentID")
  };
  if (!message.fromUserName || !message.msgType) throw new Error("企业微信消息缺少发送人或消息类型");
  return message;
}

export function parseWeComEncryptedXml(xml: string, config: WeComCallbackConfig, signature: string, timestamp: string, nonce: string) {
  const encrypted = xmlValue(xml, "Encrypt");
  if (!encrypted) throw new Error("企业微信回调缺少加密消息");
  assertWeComSignature({ token: config.callbackToken, timestamp, nonce, encrypted, signature });
  return parseWeComInboundMessage(decryptWeComMessage(encrypted, config.encodingAesKey, config.corpId));
}

export function looksLikeWriteCommand(content: string) {
  return /(新建|创建|修改|更新|删除|转交|分配|导出|发送|报价|推进|认领|释放|审批|同步|上传|下单|发邮件|发消息)/u.test(content);
}

export function fastWeComCommand(content: string, input: {
  todos: Array<{ title: string; dueAt: string; priority: string }>;
  customers: Array<{ company: string; stage: string; nextReminder: string }>;
  deals: Array<{ title: string; stage: string; amount: number; currency: string; expectedCloseAt: string }>;
}) {
  const text = content.trim();
  if (/(待办|提醒)/u.test(text)) {
    const rows = input.todos.slice(0, 8).map((item, index) => `${index + 1}. ${item.title}（${item.dueAt || "待定"}）`).join("\n");
    return rows ? `我的待办（${input.todos.length} 条）\n${rows}` : "当前没有未完成待办。";
  }
  if (/(我的客户|客户列表|客户情况)/u.test(text)) {
    const rows = input.customers.slice(0, 8).map((item, index) => `${index + 1}. ${item.company} · ${item.stage || "未分级"}${item.nextReminder ? ` · ${item.nextReminder}` : ""}`).join("\n");
    return rows ? `我的客户（${input.customers.length} 家）\n${rows}` : "当前没有名下客户。";
  }
  if (/(商机|预计成交|销售漏斗)/u.test(text)) {
    const rows = input.deals.slice(0, 8).map((item, index) => `${index + 1}. ${item.title} · ${item.stage} · ${item.amount || 0} ${item.currency || ""}${item.expectedCloseAt ? ` · ${item.expectedCloseAt}` : ""}`).join("\n");
    return rows ? `我的活跃商机（${input.deals.length} 个）\n${rows}` : "当前没有活跃商机。";
  }
  return "";
}
