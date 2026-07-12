import whatsappWeb from "whatsapp-web.js";
import type { Client as WhatsAppClient, Message } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import twilio from "twilio";
import { randomBytes } from "node:crypto";
import type { WhatsAppBinding, WhatsAppMessage } from "./types.js";

const { Client, LocalAuth } = whatsappWeb;

// WhatsApp Web 客户端管理器
class WhatsAppWebManager {
  private clients: Map<string, WhatsAppClient> = new Map();
  private qrCallbacks: Map<string, (qr: string) => void> = new Map();
  private messageCallbacks: Map<string, (msg: WhatsAppMessage) => void> = new Map();

  // 创建新的 WhatsApp Web 客户端
  async createClient(userId: string, sessionData?: string): Promise<string> {
    const clientId = `wa_web_${randomBytes(24).toString("base64url")}`;

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: clientId,
        dataPath: `./.wwebjs_auth/${clientId}`
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    // QR 码生成事件
    client.on("qr", (qr) => {
      console.log(`QR Code generated for ${clientId}`);
      qrcode.generate(qr, { small: true });
      const callback = this.qrCallbacks.get(clientId);
      if (callback) {
        callback(qr);
      }
    });

    // 客户端就绪事件
    client.on("ready", () => {
      console.log(`WhatsApp Web client ${clientId} is ready!`);
    });

    // 接收消息事件
    client.on("message", async (message: Message) => {
      const contact = await message.getContact();
      const chat = await message.getChat();

      const waMessage: WhatsAppMessage = {
        id: `wam_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        customerId: "", // 需要通过电话号码匹配客户
        direction: "inbound",
        content: message.body,
        contentTranslated: "",
        mediaUrl: message.hasMedia ? "pending" : "",
        status: "received",
        waMessageId: message.id._serialized,
        createdAt: new Date(message.timestamp * 1000).toISOString()
      };

      const callback = this.messageCallbacks.get(clientId);
      if (callback) {
        callback(waMessage);
      }
    });

    // 认证失败事件
    client.on("auth_failure", (msg) => {
      console.error(`Authentication failed for ${clientId}:`, msg);
    });

    // 断开连接事件
    client.on("disconnected", (reason) => {
      console.log(`Client ${clientId} disconnected:`, reason);
      this.clients.delete(clientId);
    });

    await client.initialize();
    this.clients.set(clientId, client);

    return clientId;
  }

  // 注册 QR 码回调
  onQR(clientId: string, callback: (qr: string) => void) {
    this.qrCallbacks.set(clientId, callback);
    return () => {
      if (this.qrCallbacks.get(clientId) === callback) this.qrCallbacks.delete(clientId);
    };
  }

  // 注册消息回调
  onMessage(clientId: string, callback: (msg: WhatsAppMessage) => void) {
    this.messageCallbacks.set(clientId, callback);
  }

  // 发送消息
  async sendMessage(clientId: string, phoneNumber: string, message: string): Promise<boolean> {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client ${clientId} not found`);
    }

    try {
      // 格式化电话号码 (移除 + 和空格)
      const formattedNumber = phoneNumber.replace(/[^0-9]/g, "");
      const chatId = `${formattedNumber}@c.us`;

      await client.sendMessage(chatId, message);
      return true;
    } catch (error) {
      console.error("Error sending message:", error);
      return false;
    }
  }

  // 获取客户端状态
  getClientStatus(clientId: string): "connected" | "disconnected" | "qr-pending" {
    const client = this.clients.get(clientId);
    if (!client) return "disconnected";

    // 简化状态判断
    return "connected";
  }

  // 断开客户端
  async disconnectClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      await client.destroy();
      this.clients.delete(clientId);
      this.qrCallbacks.delete(clientId);
      this.messageCallbacks.delete(clientId);
    }
  }

  // 获取所有活跃客户端
  getActiveClients(): string[] {
    return Array.from(this.clients.keys());
  }
}

// Twilio 客户端管理器
class TwilioManager {
  private client: twilio.Twilio | null = null;
  private accountSid: string = "";
  private authToken: string = "";
  private webhookUrl: string = "";

  // 初始化 Twilio 客户端
  initialize(accountSid: string, authToken: string, webhookUrl: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.webhookUrl = webhookUrl;
    this.client = twilio(accountSid, authToken);
  }

  // 检查是否已初始化
  isInitialized(): boolean {
    return this.client !== null;
  }

  // 发送 WhatsApp 消息
  async sendMessage(from: string, to: string, body: string): Promise<boolean> {
    if (!this.client) {
      throw new Error("Twilio client not initialized");
    }

    try {
      // Twilio WhatsApp 格式: whatsapp:+1234567890
      const fromNumber = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
      const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

      const message = await this.client.messages.create({
        from: fromNumber,
        to: toNumber,
        body: body
      });

      console.log(`Twilio message sent: ${message.sid}`);
      return true;
    } catch (error) {
      console.error("Error sending Twilio message:", error);
      return false;
    }
  }

  // 发送模板消息（用于首次联系）
  async sendTemplateMessage(from: string, to: string, templateSid: string, variables: Record<string, string>): Promise<boolean> {
    if (!this.client) {
      throw new Error("Twilio client not initialized");
    }

    try {
      const fromNumber = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
      const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

      const message = await this.client.messages.create({
        from: fromNumber,
        to: toNumber,
        contentSid: templateSid,
        contentVariables: JSON.stringify(variables)
      });

      console.log(`Twilio template message sent: ${message.sid}`);
      return true;
    } catch (error) {
      console.error("Error sending Twilio template message:", error);
      return false;
    }
  }

  // 验证 Webhook 签名
  validateWebhook(signature: string, url: string, params: Record<string, any>): boolean {
    if (!this.authToken) return false;
    return twilio.validateRequest(this.authToken, signature, url, params);
  }

  // 获取账号信息
  async getAccountInfo() {
    if (!this.client) {
      throw new Error("Twilio client not initialized");
    }
    return await this.client.api.accounts(this.accountSid).fetch();
  }
}

// 导出单例
export const whatsappWebManager = new WhatsAppWebManager();
export const twilioManager = new TwilioManager();
