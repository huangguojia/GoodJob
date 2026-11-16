/**
 * 配置广告表单入站（Facebook Lead Ads 中转）。
 *
 * 用法一（推荐，生成新令牌）：
 *   node dist/configure-lead-ads-ingress.js --generate [--owner=<userId>]
 *
 * 用法二（从 stdin 读 JSON，便于轮换 / 关闭）：
 *   echo '{"enabled":true,"ownerId":"u_admin","token":"..."}' | node dist/configure-lead-ads-ingress.js
 *
 * 令牌只在此处打印一次，之后只能重生成；不要把令牌写进命令行参数（会进 shell 历史与进程列表）。
 */
import { stdin } from "node:process";
import {
  generateLeadAdsIngressToken,
  readLeadAdsIngressSettings,
  writeLeadAdsIngressSettings
} from "./lead-ads-ingress-settings.js";

const args = process.argv.slice(2);
const ownerArg = args.find((item) => item.startsWith("--owner="))?.slice("--owner=".length) || "";

if (args.includes("--generate") || args.includes("--rotate")) {
  const previous = readLeadAdsIngressSettings();
  const token = generateLeadAdsIngressToken();
  const settings = writeLeadAdsIngressSettings({
    enabled: true,
    ownerId: ownerArg || previous.ownerId,
    token
  });
  console.log(JSON.stringify({
    configured: true,
    enabled: settings.enabled,
    ownerId: settings.ownerId || "(自动选择第一个有 lead.create 权限的启用账号)",
    endpoint: "/api/lead-ads/webhook",
    token: settings.token
  }, null, 2));
} else {
  let source = "";
  for await (const chunk of stdin) source += String(chunk);
  if (!source.trim()) {
    throw new Error("Provide --generate, or pass the ingress configuration as JSON on standard input.");
  }
  const settings = writeLeadAdsIngressSettings(JSON.parse(source));
  console.log(JSON.stringify({
    configured: true,
    enabled: settings.enabled,
    ownerId: settings.ownerId,
    endpoint: "/api/lead-ads/webhook"
  }, null, 2));
}
