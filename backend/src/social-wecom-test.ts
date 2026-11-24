import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { emitCrmEvent } from "./crm-events.js";
import { buildOpenPixelUrl, isEmailTrackingEnabled } from "./email-tracking.js";

// ---------------------------------------------------------------------------
// 社媒（Meta 官方接口）+ 企业微信推送中心：端到端自测。
// Meta Graph 与企业微信接口用本地模拟服务替身（同样的路径、参数和返回结构），
// 断言的是 CRM 的真实 HTTP 行为：授权换令牌、appsecret_proof、Webhook 签名、线索入池、推送内容与去重。
// ---------------------------------------------------------------------------

const APP_ID = "1234567890123";
const APP_SECRET = "test-app-secret-0123456789abcdef";
const graphCalls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
const wecomMessages: Array<Record<string, unknown>> = [];
let wecomIpBlocked = false;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const mock = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://mock");
  const path = url.pathname;
  // ---- 企业微信 ----
  if (path === "/cgi-bin/gettoken") {
    if (url.searchParams.get("corpsecret") !== "wecom-secret") return json(res, 200, { errcode: 40001, errmsg: "invalid credential" });
    return json(res, 200, { errcode: 0, access_token: "wx-token", expires_in: 7200 });
  }
  if (path === "/cgi-bin/user/get_userid_by_email") {
    const body = JSON.parse(await readBody(req)) as { email: string; email_type: number };
    if (body.email === "huangguojia@longtec.com" && body.email_type === 1) return json(res, 200, { errcode: 0, userid: "HuangGuoJia" });
    return json(res, 200, { errcode: 46013, errmsg: "email not found" });
  }
  if (path === "/cgi-bin/message/send") {
    if (wecomIpBlocked) return json(res, 200, { errcode: 60020, errmsg: "not allow to access from your ip" });
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    wecomMessages.push(body);
    return json(res, 200, { errcode: 0, errmsg: "ok", invaliduser: "" });
  }
  // ---- Meta Graph ----
  graphCalls.push({ method: req.method || "GET", path, query: url.searchParams });
  const token = url.searchParams.get("access_token") || "";
  if (token && url.searchParams.get("appsecret_proof") !== createHmac("sha256", APP_SECRET).update(token).digest("hex")) {
    return json(res, 400, { error: { message: "Invalid appsecret_proof", code: 100 } });
  }
  const p = path.replace(/^\/v23\.0\//u, "");
  if (p === "oauth/access_token") {
    if (url.searchParams.get("code")) return json(res, 200, { access_token: "short-user-token" });
    return json(res, 200, { access_token: "long-user-token", expires_in: 5_184_000 });
  }
  if (p === "me") return json(res, 200, { id: "fbuser1", name: "Huang Guojia", picture: { data: { url: "https://example.com/u.png" } } });
  if (p === "me/permissions") return json(res, 200, { data: [{ permission: "pages_show_list", status: "granted" }, { permission: "leads_retrieval", status: "granted" }, { permission: "ads_read", status: "granted" }] });
  if (p === "me/accounts") return json(res, 200, { data: [{ id: "page1", name: "Longtec Weighing", category: "Industrial Company", access_token: "page-token-1", tasks: ["ADVERTISE", "MANAGE"] }] });
  if (p === "me/adaccounts") return json(res, 200, { data: [{ id: "act_777", account_id: "777", name: "Longtec Ads", currency: "USD", account_status: 1 }] });
  if (p === "page1") return json(res, 200, { id: "page1", name: "Longtec Weighing", category: "Industrial Company", fan_count: 1520, followers_count: 1688, link: "https://facebook.com/longtec" });
  if (p === "page1/posts") return json(res, 200, { data: [{ id: "page1_9", message: "New load cell series", created_time: "2026-11-10T08:00:00+0000", permalink_url: "https://facebook.com/p/9", reactions: { summary: { total_count: 42 } }, comments: { summary: { total_count: 5 } }, shares: { count: 3 } }] });
  if (p === "page1/subscribed_apps" && req.method === "POST") return json(res, 200, { success: url.searchParams.get("subscribed_fields") === "leadgen" });
  if (p === "page1/subscribed_apps") return json(res, 200, { data: [{ id: APP_ID, subscribed_fields: ["leadgen"] }] });
  if (p === "page1/leadgen_forms") return json(res, 200, { data: [{ id: "form1", name: "Get a quote", status: "ACTIVE", leads_count: 2 }] });
  if (p === "form1/leads") return json(res, 200, { data: [
    { id: "lead_a", created_time: "2026-11-15T10:00:00+0000", form_id: "form1", campaign_name: "BR Moisture Q4", field_data: [{ name: "full_name", values: ["Maria Silva"] }, { name: "email", values: ["maria@agro.example"] }, { name: "company_name", values: ["Agro Brasil"] }] },
    { id: "lead_b", created_time: "2026-11-16T10:00:00+0000", form_id: "form1", campaign_name: "BR Moisture Q4", field_data: [{ name: "full_name", values: ["João Lima"] }, { name: "phone_number", values: ["+5511999990000"] }, { name: "company_name", values: ["Grãos SA"] }] }
  ] });
  if (p === "lead_c") return json(res, 200, { id: "lead_c", created_time: "2026-11-17T09:00:00+0000", form_id: "form1", ad_name: "Moisture ad", campaign_name: "BR Moisture Q4", field_data: [{ name: "full_name", values: ["Carlos Mendes"] }, { name: "email", values: ["carlos@agrosystem.example"] }, { name: "company_name", values: ["Agrosystem"] }] });
  if (p === "act_777/campaigns") return json(res, 200, { data: [{ id: "c1", name: "BR Moisture Q4", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget: "5000" }] });
  if (p === "act_777/insights") {
    if (url.searchParams.get("level") === "campaign") return json(res, 200, { data: [{ campaign_id: "c1", spend: "123.45", impressions: "10000", clicks: "250", ctr: "2.5", cpc: "0.49", actions: [{ action_type: "lead", value: "18" }] }] });
    return json(res, 200, { data: [{ spend: "123.45", impressions: "10000", reach: "8000", clicks: "250", ctr: "2.5", cpc: "0.49", actions: [{ action_type: "lead", value: "18" }] }] });
  }
  if (p === "fbuser1/permissions" && req.method === "DELETE") return json(res, 200, { success: true });
  return json(res, 404, { error: { message: `unmocked ${p}`, code: 100 } });
});
await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockAddress = mock.address();
if (!mockAddress || typeof mockAddress === "string") throw new Error("mock server failed");
const mockBase = `http://127.0.0.1:${mockAddress.port}`;
process.env.META_GRAPH_BASE_URL = mockBase;
process.env.META_DIALOG_BASE_URL = "https://www.facebook.com";
process.env.WECOM_API_BASE_URL = mockBase;

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start social test server");
const baseUrl = `http://127.0.0.1:${address.port}`;
process.env.SOCIAL_PUBLIC_BASE_URL = baseUrl;

async function request(path: string, token = "", init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { response, json: body };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", { method: "POST", body: JSON.stringify({ email, password: "goodjob123" }) });
  assert.equal(result.response.status, 200, `登录失败：${email}`);
  return String(result.json.token);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const admin = await login("admin@goodjob.com");
  const sales = await login("shirley@goodjob.com");
  const store = getStore();
  const adminUser = store.users.find((item) => item.email === "admin@goodjob.com")!;

  // ================= 企业微信推送中心 =================
  const salesSave = await request("/api/notify/wecom", sales, { method: "PUT", body: JSON.stringify({ enabled: true, mode: "app" }) });
  assert.equal(salesSave.response.status, 403, "业务员不能改推送配置");

  const incomplete = await request("/api/notify/wecom", admin, { method: "PUT", body: JSON.stringify({ enabled: true, mode: "app", corpId: "ww123", agentId: "1000002", recipients: [] }) });
  assert.equal(incomplete.response.status, 400, "启用自建应用必须填全 Secret");

  const saved = await request("/api/notify/wecom", admin, { method: "PUT", body: JSON.stringify({
    enabled: true, mode: "app", corpId: "ww123", agentId: "1000002", secret: "wecom-secret",
    recipients: ["huangguojia@longtec.com"], sendToOwner: false,
    rules: { emailOpened: true, emailReopened: false, emailClicked: true, emailReplied: true, leadAds: true }
  }) });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.json));
  const view = await request("/api/notify/wecom", admin);
  assert.equal(view.json.settings.secretSet, true);
  assert.equal(JSON.stringify(view.json).includes("wecom-secret"), false, "接口不能回显 Secret 明文");

  const testSend = await request("/api/notify/wecom/test", admin, { method: "POST" });
  assert.equal(testSend.response.status, 200, JSON.stringify(testSend.json));
  assert.deepEqual(testSend.json.delivered, ["huangguojia@longtec.com"]);
  assert.equal(wecomMessages.at(-1)?.touser, "HuangGuoJia", "邮箱必须换成企业微信成员账号");
  assert.equal(wecomMessages.at(-1)?.agentid, 1000002);
  assert.equal(wecomMessages.at(-1)?.msgtype, "markdown");

  wecomIpBlocked = true;
  const blocked = await request("/api/notify/wecom/test", admin, { method: "POST" });
  assert.equal(blocked.response.status, 400);
  assert.match(String(blocked.json.message), /企业可信 IP/u, "60020 必须翻成可信 IP 的处理办法");
  wecomIpBlocked = false;

  // 开发信被打开 → 推送（同一封只推一次）
  const teamId = adminUser.teamId;
  const log = {
    id: "oel_push_test", teamId, ownerId: adminUser.id, messageId: "<push-test@goodjob>", entityType: "lead", entityId: "",
    to: "buyer@agro.example", subject: "Weighing for your NIR lines", source: "development_email_send", dispatchStatus: "sent",
    sentAt: new Date().toISOString(), createdAt: new Date().toISOString(), openCount: 0, clickCount: 0
  } as unknown as (typeof store.outboundEmailLogs)[number];
  store.outboundEmailLogs.unshift(log);
  const before = wecomMessages.length;
  if (isEmailTrackingEnabled()) {
    const pixel = new URL(buildOpenPixelUrl(log.messageId));
    await fetch(`${baseUrl}${pixel.pathname}${pixel.search}`);
    await fetch(`${baseUrl}${pixel.pathname}${pixel.search}`);
  } else {
    emitCrmEvent({ type: "email.opened", teamId, ownerId: adminUser.id, logId: log.id, messageId: log.messageId, to: log.to!, subject: log.subject!, company: "Agro", openCount: 1, occurredAt: new Date().toISOString() });
    emitCrmEvent({ type: "email.opened", teamId, ownerId: adminUser.id, logId: log.id, messageId: log.messageId, to: log.to!, subject: log.subject!, company: "Agro", openCount: 1, occurredAt: new Date().toISOString() });
  }
  await sleep(300);
  assert.equal(wecomMessages.length - before, 1, "首次打开推一次，重复打开不刷屏");
  assert.match(String((wecomMessages.at(-1)?.markdown as { content: string }).content), /开发信被打开[\s\S]*buyer@agro\.example/u);

  // 邮件中心同步到回信（In-Reply-To 指向这封开发信）→ 记回信 + 推送
  emitCrmEvent({ type: "mail.inbound", teamId, ownerId: adminUser.id, messageId: "<r1@agro>", inReplyTo: "push-test@goodjob", from: "buyer@agro.example", subject: "Re: Weighing for your NIR lines", snippet: "Please send a quote for 20 units", occurredAt: new Date().toISOString() });
  await sleep(300);
  assert.ok(log.repliedAt, "回信必须写回开发信台账");
  assert.match(String((wecomMessages.at(-1)?.markdown as { content: string }).content), /客户回信了[\s\S]*20 units/u);

  // ================= 社媒：Meta 应用 + 授权 =================
  const salesApp = await request("/api/social/meta/app", sales, { method: "PUT", body: JSON.stringify({ appId: APP_ID, appSecret: APP_SECRET }) });
  assert.equal(salesApp.response.status, 403, "业务员不能配置 Meta 应用");
  const appSaved = await request("/api/social/meta/app", admin, { method: "PUT", body: JSON.stringify({ appId: APP_ID, appSecret: APP_SECRET, graphVersion: "v23.0" }) });
  assert.equal(appSaved.response.status, 200, JSON.stringify(appSaved.json));
  const overview = await request("/api/social/overview", admin);
  assert.equal(overview.json.meta.configured, true);
  assert.equal(JSON.stringify(overview.json).includes(APP_SECRET), false, "App Secret 不能回显");
  const webhookPath = new URL(overview.json.meta.webhookUrl).pathname;
  const verifyToken = String(overview.json.meta.verifyToken);
  assert.ok(verifyToken.length > 20);

  const start = await request("/api/social/meta/oauth/start", admin, { method: "POST", headers: { origin: baseUrl } });
  const dialog = new URL(start.json.url);
  assert.equal(dialog.searchParams.get("client_id"), APP_ID);
  assert.equal(dialog.searchParams.get("redirect_uri"), `${baseUrl}/api/social/meta/oauth/callback`);
  assert.match(String(dialog.searchParams.get("scope")), /leads_retrieval/u);
  const state = String(dialog.searchParams.get("state"));

  const forged = await request(`/api/social/meta/oauth/callback?code=abc&state=forged`);
  assert.equal(forged.response.status, 400, "伪造的 state 必须拒绝");
  const callback = await request(`/api/social/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(callback.response.status, 302);
  assert.match(String(callback.response.headers.get("location")), /social_oauth=ok/u);
  const replay = await request(`/api/social/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(replay.response.status, 400, "state 只能用一次");
  assert.ok(graphCalls.some((call) => call.path.endsWith("oauth/access_token") && call.query.get("grant_type") === "fb_exchange_token"), "必须换成长效令牌");

  const connected = await request("/api/social/overview", admin);
  const connection = connected.json.connections[0];
  assert.equal(connection.pages[0].id, "page1");
  assert.equal(connection.adAccounts[0].id, "act_777");
  assert.equal(JSON.stringify(connected.json).match(/page-token-1|long-user-token/u), null, "令牌不能出现在接口里");

  // 主页 / 帖子 / 广告
  const page = await request("/api/social/meta/pages/page1", admin);
  assert.equal(page.json.page.followers, 1688);
  assert.equal(page.json.posts[0].reactions, 42);
  const ads = await request("/api/social/meta/adaccounts/act_777/campaigns?range=last_7d", admin);
  assert.equal(ads.json.summary.leads, 18);
  assert.equal(ads.json.campaigns[0].dailyBudget, 50);
  assert.equal(ads.json.campaigns[0].spend, 123.45);

  // 表单：订阅 Webhook + 回填
  const forms = await request("/api/social/meta/pages/page1/leadforms", admin);
  assert.equal(forms.json.forms[0].leadsCount, 2);
  const subscribe = await request("/api/social/meta/pages/page1/leadgen/subscribe", admin, { method: "POST", body: JSON.stringify({ subscribe: true }) });
  assert.equal(subscribe.json.leadgenSubscribed, true);
  const leadsBefore = store.leads.length;
  const backfill = await request("/api/social/meta/forms/form1/backfill", admin, { method: "POST", body: JSON.stringify({ pageId: "page1" }) });
  assert.equal(backfill.json.created, 2, JSON.stringify(backfill.json));
  const again = await request("/api/social/meta/forms/form1/backfill", admin, { method: "POST", body: JSON.stringify({ pageId: "page1" }) });
  assert.equal(again.json.duplicate, 2, "重复回填不能重复建线索");
  assert.equal(store.leads.length - leadsBefore, 2);
  const maria = store.leads.find((lead) => lead.email === "maria@agro.example");
  assert.equal(maria?.sourceChannel, "facebook_lead_ads");
  assert.match(String(maria?.sourceCampaign || ""), /BR Moisture Q4/u);

  // Webhook：校验 + 签名
  const verify = await request(`${webhookPath}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=777`);
  assert.equal(verify.json.text ?? String(verify.json), "777");
  const verifyBad = await request(`${webhookPath}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=777`);
  assert.equal(verifyBad.response.status, 403);
  const payload = JSON.stringify({ object: "page", entry: [{ id: "page1", time: 1, changes: [{ field: "leadgen", value: { leadgen_id: "lead_c", page_id: "page1", form_id: "form1" } }] }] });
  const unsigned = await request(webhookPath, "", { method: "POST", body: payload });
  assert.equal(unsigned.response.status, 401, "没有签名的推送必须拒绝");
  const pushedBefore = wecomMessages.length;
  const signed = await request(webhookPath, "", { method: "POST", body: payload, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(payload).digest("hex")}` } });
  assert.equal(signed.response.status, 200);
  assert.equal(signed.json.handled, 1);
  assert.ok(store.leads.some((lead) => lead.email === "carlos@agrosystem.example"), "Webhook 线索必须进线索池");
  await sleep(300);
  assert.ok(wecomMessages.length > pushedBefore, "新表单线索要推企业微信");
  assert.match(String((wecomMessages.at(-1)?.markdown as { content: string }).content), /Facebook 表单线索[\s\S]*Agrosystem/u);

  // 数据删除回调（signed_request）
  const signedPayload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "fbuser1" })).toString("base64url");
  const signature = createHmac("sha256", APP_SECRET).update(signedPayload).digest("base64url");
  const deletion = await request(webhookPath.replace("/webhook/", "/data-deletion/"), "", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `signed_request=${signature}.${signedPayload}`
  });
  assert.ok(deletion.json.confirmation_code, JSON.stringify(deletion.json));
  const afterDeletion = await request("/api/social/overview", admin);
  assert.equal(afterDeletion.json.connections.length, 0, "数据删除请求后连接必须清空");
  const status = await request(new URL(deletion.json.url).pathname);
  assert.match(String(status.json.text), /已全部删除/u);

  console.log(JSON.stringify({ ok: true, checked: "social-wecom", wecomMessages: wecomMessages.length, graphCalls: graphCalls.length }, null, 2));
} finally {
  server.close();
  mock.close();
}
process.exit(0);
