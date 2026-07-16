import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start collaboration test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

async function login(email: string) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  if (!result.response.ok) throw new Error(`login failed: ${email}`);
  return result.json.token as string;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  const store = getStore();
  store.users.push({
    id: "u_manager_other_team",
    name: "Other Team Manager",
    email: "other-manager@goodjob.com",
    password: "goodjob123",
    role: "manager",
    teamId: "other-team",
    avatar: "OT",
    status: "active",
    authVersion: 1
  });

  const unauthenticated = await request("/api/daily-reports");
  assert(unauthenticated.response.status === 401, "daily report API must require authentication");

  const shirleyToken = await login("shirley@goodjob.com");
  const miaToken = await login("mia@goodjob.com");
  const alexToken = await login("alex@goodjob.com");
  const otherManagerToken = await login("other-manager@goodjob.com");
  const reportDate = "2026-07-16";

  const created = await request("/api/daily-reports", {
    method: "POST",
    headers: auth(shirleyToken),
    body: JSON.stringify({
      reportDate,
      completedWork: "完成首轮客户筛选并发送三封开发信",
      customerProgress: "两位客户回复参数需求",
      results: "新增两个有效触点",
      risks: "一位客户交期较紧",
      nextPlan: "准备报价并确认认证范围",
      supportNeeded: "请主管协助确认最快交期"
    })
  });
  assert(created.response.status === 201 && created.json.created, "first report submission must create a report");
  const reportId = created.json.report?.id as string;
  assert(reportId, "created report must return an id");

  const updated = await request("/api/daily-reports", {
    method: "POST",
    headers: auth(shirleyToken),
    body: JSON.stringify({
      reportDate,
      completedWork: "完成首轮客户筛选、三封开发信和一份报价草案",
      customerProgress: "两位客户回复参数需求",
      results: "新增两个有效触点",
      risks: "一位客户交期较紧",
      nextPlan: "准备报价并确认认证范围",
      supportNeeded: "请主管协助确认最快交期"
    })
  });
  assert(updated.response.status === 200 && !updated.json.created, "same-day submission must update instead of duplicate");
  assert(updated.json.report?.id === reportId, "same-day update must retain report id");
  assert(store.dailyReports.filter((item) => item.ownerId === "u_sales_shirley" && item.reportDate === reportDate).length === 1,
    "same user and date must have exactly one report");

  const ownReports = await request("/api/daily-reports", { headers: auth(shirleyToken) });
  assert(ownReports.response.ok && ownReports.json.reports?.some((item: { id: string }) => item.id === reportId),
    "salesperson must see own report");
  const peerReports = await request("/api/daily-reports", { headers: auth(miaToken) });
  assert(!peerReports.json.reports?.some((item: { id: string }) => item.id === reportId),
    "salesperson must not see a peer report");
  const managerReports = await request("/api/daily-reports", { headers: auth(alexToken) });
  assert(managerReports.json.reports?.some((item: { id: string }) => item.id === reportId),
    "team manager must see team report");
  const otherTeamReports = await request("/api/daily-reports", { headers: auth(otherManagerToken) });
  assert(!otherTeamReports.json.reports?.some((item: { id: string }) => item.id === reportId),
    "other team manager must not see report");
  const otherTeamDetail = await request(`/api/daily-reports/${reportId}`, { headers: auth(otherManagerToken) });
  assert(otherTeamDetail.response.status === 404, "other team must not read report detail");

  const managerComment = await request(`/api/daily-reports/${reportId}/comments`, {
    method: "POST",
    headers: auth(alexToken),
    body: JSON.stringify({ content: "客户回复质量不错，请补充预计报价时间。" })
  });
  assert(managerComment.response.status === 201, "manager comment must be created");
  const commentId = managerComment.json.comment?.id as string;

  const salespersonInboxAfterComment = await request("/api/internal-messages?box=inbox", {
    headers: auth(shirleyToken)
  });
  const commentNotification = salespersonInboxAfterComment.json.messages?.find(
    (item: { relatedId: string; senderId: string }) => item.relatedId === reportId && item.senderId === "u_manager_alex"
  );
  assert(commentNotification, "report comment must notify report owner");

  const reply = await request(`/api/daily-reports/${reportId}/comments`, {
    method: "POST",
    headers: auth(shirleyToken),
    body: JSON.stringify({ content: "已补充，计划明日上午发出报价。", parentId: commentId })
  });
  assert(reply.response.status === 201 && reply.json.comment?.parentId === commentId,
    "comment reply must retain parent relation");

  const managerInboxBeforeRead = await request("/api/internal-messages?box=inbox", { headers: auth(alexToken) });
  const replyNotification = managerInboxBeforeRead.json.messages?.find(
    (item: { relatedId: string; subject: string }) => item.relatedId === reportId && item.subject.includes("回复")
  );
  assert(replyNotification, "comment reply must notify original commenter");
  const managerUnreadBefore = managerInboxBeforeRead.json.unreadCount as number;
  const readReply = await request(`/api/internal-messages/${replyNotification.id}/read`, {
    method: "POST",
    headers: auth(alexToken)
  });
  assert(readReply.response.ok && readReply.json.message?.readAt, "recipient must be able to mark message read");
  const managerInboxAfterRead = await request("/api/internal-messages?box=inbox", { headers: auth(alexToken) });
  assert(managerInboxAfterRead.json.unreadCount === managerUnreadBefore - 1, "read action must reduce unread count");

  const crossTeamMessage = await request("/api/internal-messages", {
    method: "POST",
    headers: auth(shirleyToken),
    body: JSON.stringify({
      recipientId: "u_manager_other_team",
      subject: "越权消息",
      content: "这条消息不应发送成功"
    })
  });
  assert(crossTeamMessage.response.status === 403, "normal user must not send cross-team messages");
  const otherTeamRecipients = await request("/api/internal-messages/recipients", {
    headers: auth(otherManagerToken)
  });
  assert(!otherTeamRecipients.json.recipients?.some((item: { teamId: string }) => item.teamId === "europe"),
    "recipient selector must not expose another team");

  const directMessage = await request("/api/internal-messages", {
    method: "POST",
    headers: auth(shirleyToken),
    body: JSON.stringify({
      recipientId: "u_sales_mia",
      subject: "客户资料协同",
      content: "请帮忙复核客户所在国家的认证要求。"
    })
  });
  assert(directMessage.response.status === 201, "same-team direct message must be sent");
  const directMessageId = directMessage.json.message?.id as string;
  const miaInboxBeforeRead = await request("/api/internal-messages?box=inbox", { headers: auth(miaToken) });
  assert(miaInboxBeforeRead.json.messages?.some((item: { id: string }) => item.id === directMessageId),
    "recipient inbox must contain direct message");
  const alexInbox = await request("/api/internal-messages?box=inbox", { headers: auth(alexToken) });
  assert(!alexInbox.json.messages?.some((item: { id: string }) => item.id === directMessageId),
    "unrelated team member must not see direct message");
  const shirleySent = await request("/api/internal-messages?box=sent", { headers: auth(shirleyToken) });
  assert(shirleySent.json.messages?.some((item: { id: string }) => item.id === directMessageId),
    "sender sent box must contain direct message");
  const unauthorizedRead = await request(`/api/internal-messages/${directMessageId}/read`, {
    method: "POST",
    headers: auth(alexToken)
  });
  assert(unauthorizedRead.response.status === 404, "non-recipient must not mark message read");
  const miaUnreadBefore = miaInboxBeforeRead.json.unreadCount as number;
  const miaRead = await request(`/api/internal-messages/${directMessageId}/read`, {
    method: "POST",
    headers: auth(miaToken)
  });
  assert(miaRead.response.ok && miaRead.json.message?.readAt, "direct message recipient must mark message read");
  const miaInboxAfterRead = await request("/api/internal-messages?box=inbox", { headers: auth(miaToken) });
  assert(miaInboxAfterRead.json.unreadCount === miaUnreadBefore - 1, "direct message read state must persist");

  console.log(JSON.stringify({
    ok: true,
    reportCreateAndUpdate: true,
    reportTeamIsolation: true,
    commentReplyNotification: true,
    messageTeamIsolation: true,
    messageReadState: true
  }, null, 2));
} finally {
  server.close();
}
