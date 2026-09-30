import assert from "node:assert/strict";
import {
  buildClickTrackingUrl,
  buildOpenPixelUrl,
  buildTrackedEmailHtml,
  emailTrackingBaseUrl,
  emailTrackingStatus,
  isEmailTrackingEnabled,
  setEmailTrackingRuntimeBaseUrl,
  verifyClickToken,
  verifyOpenToken
} from "./email-tracking.js";

let passed = 0;
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  passed += 1;
  console.log(`  ok - ${message}`);
}

console.log("== email-tracking 运行时覆盖与已读追踪 URL ==");

// ── 1. 未配置（无 env、无 runtime）→ 完全关闭 ────────────────────
delete process.env.EMAIL_TRACKING_BASE_URL;
setEmailTrackingRuntimeBaseUrl("");
check(emailTrackingBaseUrl() === "", "未配置时 base url 为空");
check(!isEmailTrackingEnabled(), "未配置时追踪关闭");
check(buildOpenPixelUrl("<gj-1@a.b>") === "", "未配置时不生成像素 URL");
check(buildTrackedEmailHtml("see https://x.com", "<gj-1@a.b>") === null, "未配置时正文保持纯文本");
check(emailTrackingStatus().source === "none", "状态来源标记为 none");

// ── 2. 运行时覆盖生效 ───────────────────────────────────────
setEmailTrackingRuntimeBaseUrl("https://crm.example.com/");
check(emailTrackingBaseUrl() === "https://crm.example.com", "runtime 覆盖生效且去尾部斜杠");
check(isEmailTrackingEnabled(), "runtime 覆盖后追踪开启");
check(emailTrackingStatus().source === "app_settings", "状态来源标记为 app_settings");
check(emailTrackingStatus().baseUrl === "https://crm.example.com", "状态里带 base url");

const pixel = buildOpenPixelUrl("<gj-abc-123@crm.example.com>");
check(pixel.includes("/api/email/track/open/") && pixel.includes(".gif?s="), "像素 URL 形态正确");
check(pixel.includes("?s="), "像素 URL 带签名");

// 篡改 token（换一个 messageId 的 token 配原签名）→ 拒绝
const otherToken = Buffer.from("gj-someone-else@x", "utf8").toString("base64url");
check(verifyOpenToken(otherToken, new URL(pixel).searchParams.get("s")!) === "", "token 与签名不匹配时拒绝");

// 正确往返：用同一 mid 构建再验证
const mid = "<gj-open-1@x>";
const openUrl = buildOpenPixelUrl(mid);
const [openToken, openSig] = [openUrl.split("/open/")[1]!.split("?")[0]!, new URL(openUrl).searchParams.get("s")!];
check(verifyOpenToken(openToken, openSig) === "gj-open-1@x", "open 令牌往返还原 messageId");
check(verifyOpenToken(openToken, "deadbeefdeadbeefdeadbeefdeadbeef") === "", "open 签名错误时拒绝");

// ── 3. 点击链接改写与验签 ─────────────────────────────────────
const click = buildClickTrackingUrl(mid, "https://longtec.com/products?a=1");
check(click.startsWith("https://crm.example.com/api/email/track/click/"), "点击 URL 指向追踪路由");
const verified = verifyClickToken(
  click.split("/click/")[1]!.split("?")[0]!,
  new URL(click).searchParams.get("u")!,
  new URL(click).searchParams.get("s")!
);
check(verified?.messageId === "gj-open-1@x" && verified?.targetUrl === "https://longtec.com/products?a=1", "点击令牌往返还原目标");
check(buildClickTrackingUrl(mid, "javascript:alert(1)") === "javascript:alert(1)", "非 http(s) 目标不改写");

// ── 4. 正文转追踪 HTML ────────────────────────────────────────
const html = buildTrackedEmailHtml(
  "Hello!\nVisit https://longtec.com/price or https://longtec.com/catalog\nThanks",
  mid
);
check(!!html && typeof html === "object", "开启追踪时返回 HTML 结构");
check(html!.linkCount === 2, "两个链接都被改写");
check(html!.html.includes("/api/email/track/click/"), "HTML 里包含点击追踪链接");
check(html!.html.includes("/api/email/track/open/"), "HTML 里包含打开像素");
check(html!.hasPixel, "hasPixel 为真");
check(html!.html.includes("<br />"), "换行转 <br />");

// ── 5. 非法 runtime 值被忽略（回落 env / 关闭）──────────────────
setEmailTrackingRuntimeBaseUrl("not-a-url");
check(emailTrackingBaseUrl() === "", "非法 runtime 值被忽略");
check(!isEmailTrackingEnabled(), "非法 runtime 值不启用追踪");
setEmailTrackingRuntimeBaseUrl("");
delete process.env.JWT_SECRET;
delete process.env.EMAIL_TRACKING_SECRET;

console.log(`\nemail-tracking: ${passed} assertions passed`);
