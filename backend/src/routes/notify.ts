/**
 * 消息推送中心路由（当前：企业微信）。
 *  - 查看配置与推送记录：integration.read
 *  - 修改配置、发测试消息：integration.manage
 * Secret / 机器人地址只写不读：接口永远不回显明文。
 */
import type { Express } from "express";
import { z } from "zod";
import { hasIamPermission, requireAuth } from "../auth.js";
import { asyncRoute } from "../server-core.js";
import {
  DEFAULT_WECOM_RULES,
  encryptWecomSecret,
  readWecomLog,
  readWecomSettings,
  registerWecomPushHandlers,
  sendWecomMarkdown,
  wecomRecipientsFor,
  writeWecomSettings
} from "../wecom-push.js";

const settingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["app", "robot"]),
  corpId: z.string().trim().max(64).default(""),
  agentId: z.string().trim().regex(/^\d{0,12}$/u, "AgentID 只能是数字").default(""),
  /** 留空 = 不修改已保存的 Secret */
  secret: z.string().trim().max(200).optional(),
  /** 留空 = 不修改；传 "-" = 清除 */
  robotWebhook: z.string().trim().max(400).optional(),
  sendToOwner: z.boolean().default(false),
  recipients: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  rules: z.object({
    emailOpened: z.boolean(),
    emailReopened: z.boolean(),
    emailClicked: z.boolean(),
    emailReplied: z.boolean(),
    leadAds: z.boolean(),
    outreachSummary: z.boolean().default(true),
    outreachRound: z.boolean().default(true)
  }).default(DEFAULT_WECOM_RULES)
});

export function registerNotifyRoutes(app: Express) {
  registerWecomPushHandlers();

  app.get("/api/notify/wecom", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.read")) {
      res.status(403).json({ message: "没有查看消息推送配置的权限" });
      return;
    }
    const teamId = req.user!.teamId;
    const settings = await readWecomSettings(teamId);
    const log = await readWecomLog(teamId);
    res.json({
      settings: {
        enabled: settings.enabled,
        mode: settings.mode,
        corpId: settings.corpId,
        agentId: settings.agentId,
        secretSet: Boolean(settings.secretEnc),
        robotSet: Boolean(settings.robotWebhookEnc),
        sendToOwner: settings.sendToOwner,
        recipients: settings.recipients,
        rules: settings.rules,
        updatedAt: settings.updatedAt,
        configured: Boolean(settings.updatedAt)
      },
      canManage: hasIamPermission(req.user, "integration.manage"),
      log: log.slice(0, 60),
      stats: {
        sent: log.filter((item) => item.status === "sent").length,
        failed: log.filter((item) => item.status === "failed").length,
        lastSentAt: log.find((item) => item.status === "sent")?.at || ""
      }
    });
  }));

  app.put("/api/notify/wecom", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.manage")) {
      res.status(403).json({ message: "只有管理员可以修改消息推送配置" });
      return;
    }
    const body = settingsSchema.parse(req.body);
    const teamId = req.user!.teamId;
    const current = await readWecomSettings(teamId);
    const next = {
      ...current,
      enabled: body.enabled,
      mode: body.mode,
      corpId: body.corpId,
      agentId: body.agentId,
      sendToOwner: body.sendToOwner,
      recipients: [...new Set(body.recipients)],
      rules: body.rules,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user!.id
    };
    if (body.secret) next.secretEnc = encryptWecomSecret(teamId, "secret", body.secret);
    if (body.robotWebhook === "-") next.robotWebhookEnc = "";
    else if (body.robotWebhook) {
      if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[\w-]{8,}$/u.test(body.robotWebhook)) {
        res.status(400).json({ message: "群机器人地址格式不对，应为 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" });
        return;
      }
      next.robotWebhookEnc = encryptWecomSecret(teamId, "robot", body.robotWebhook);
    }
    if (next.enabled) {
      if (next.mode === "app" && (!next.corpId || !next.agentId || !next.secretEnc)) {
        res.status(400).json({ message: "启用自建应用推送需要填全 CorpID、AgentID 和 Secret" });
        return;
      }
      if (next.mode === "app" && !next.recipients.length && !next.sendToOwner) {
        res.status(400).json({ message: "至少填一个接收人，或者勾选「推给负责的业务员本人」" });
        return;
      }
      if (next.mode === "robot" && !next.robotWebhookEnc) {
        res.status(400).json({ message: "启用群机器人推送需要填写 Webhook 地址" });
        return;
      }
    }
    await writeWecomSettings(teamId, next);
    res.json({ ok: true });
  }));

  app.post("/api/notify/wecom/test", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.manage")) {
      res.status(403).json({ message: "只有管理员可以发送测试消息" });
      return;
    }
    const teamId = req.user!.teamId;
    const settings = await readWecomSettings(teamId);
    const recipients = wecomRecipientsFor({ ...settings, sendToOwner: settings.sendToOwner }, req.user!.id);
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const content = `**GoodJob CRM 推送测试**\n> 这是一条测试消息，收到说明企业微信推送已经接通。\n> 以后开发信被打开、客户回信、新的广告表单线索都会推到这里。\n> 发送人：${req.user!.name}\n> 时间：<font color="comment">${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}</font>`;
    try {
      const result = await sendWecomMarkdown(teamId, settings, content, recipients);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      res.status(502).json({ ok: false, delivered: [], failed: [], message: error instanceof Error ? error.message : "连接企业微信失败" });
    }
  }));
}
