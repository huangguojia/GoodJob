import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runConnectorDriverComplianceSuite, type ConnectorManifest } from "@goodjob/integration-connector-sdk";
import { WeComConnectorDriver } from "../src/drivers/wecom-connector-driver.js";
import type { DriverRuntimeContext } from "../src/drivers/connector-driver.js";

const requests: Array<{ method: string; path: string; token: string; body: Record<string, unknown> }> = [];
let appTokenRequests = 0;
let customerTokenRequests = 0;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  let body: Record<string, unknown> = {};
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; } catch { body = {}; }
  requests.push({ method: request.method || "GET", path: url.pathname, token: url.searchParams.get("access_token") || "", body });
  response.setHeader("content-type", "application/json");

  if (url.pathname === "/wecom/cgi-bin/gettoken") {
    const secret = url.searchParams.get("corpsecret");
    if (url.searchParams.get("corpid") !== "ww_test_corp") return response.end(JSON.stringify({ errcode: 40013, errmsg: "invalid corpid" }));
    if (secret === "app_secret_123") {
      appTokenRequests += 1;
      return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", access_token: "app-token", expires_in: 7200 }));
    }
    if (secret === "customer_secret_123") {
      customerTokenRequests += 1;
      return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", access_token: "customer-token", expires_in: 7200 }));
    }
    return response.end(JSON.stringify({ errcode: 40001, errmsg: "invalid secret" }));
  }

  if (url.pathname === "/wecom/cgi-bin/agent/get" && url.searchParams.get("access_token") === "app-token") {
    return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", agentid: 1000002, name: "GoodJob CRM" }));
  }
  if (url.pathname === "/wecom/cgi-bin/department/list" && url.searchParams.get("access_token") === "app-token") {
    return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", department: [
      { id: 1, name: "GoodJob", parentid: 0, order: 100 },
      { id: 2, name: "外贸一部", parentid: 1, order: 90 }
    ] }));
  }
  if (url.pathname === "/wecom/cgi-bin/user/list" && url.searchParams.get("access_token") === "app-token") {
    return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", userlist: [
      { userid: "seller_a", name: "业务员A", mobile: "13800000000", email: "seller@example.test", department: [2], order: [10], is_leader_in_dept: [0], position: "外贸业务", status: 1, main_department: 2 }
    ] }));
  }
  if (url.pathname === "/wecom/cgi-bin/externalcontact/list" && url.searchParams.get("access_token") === "customer-token") {
    return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", external_userid: ["wm_customer_1"] }));
  }
  if (url.pathname === "/wecom/cgi-bin/externalcontact/get" && url.searchParams.get("access_token") === "customer-token") {
    return response.end(JSON.stringify({
      errcode: 0, errmsg: "ok",
      external_contact: {
        external_userid: "wm_customer_1", name: "Buyer One", type: 1, gender: 1,
        position: "Purchasing Manager", corp_name: "Example Imports",
        external_profile: { external_attr: [{ type: 0, name: "产品", text: { value: "LED lighting" } }] }
      },
      follow_user: [{ userid: "seller_a", remark: "展会客户", description: "等待报价", createtime: 1786000000, add_way: 2, tags: [{ group_name: "客户级别", tag_name: "A", tag_id: "tag_a", type: 1 }] }],
      next_cursor: ""
    }));
  }
  if (url.pathname === "/wecom/cgi-bin/message/send" && url.searchParams.get("access_token") === "app-token" && request.method === "POST") {
    return response.end(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: "wecom-message-001", invaliduser: "" }));
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ errcode: 404, errmsg: "not found" }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("企业微信测试服务器启动失败");

const manifest = {
  schemaVersion: "1.0" as const,
  stage: "available" as const,
  driver: "wecom" as const,
  endpoint: `http://127.0.0.1:${address.port}/wecom/`,
  approvedHosts: ["127.0.0.1"],
  allowedPorts: [address.port],
  allowInsecureLoopback: true,
  authentication: "api_token" as const,
  credentialFields: [
    { key: "corpId", label: "CorpID", secret: true as const, minLength: 3, maxLength: 128 },
    { key: "appSecret", label: "App Secret", secret: true as const, minLength: 8, maxLength: 256 },
    { key: "agentId", label: "AgentId", secret: true as const, minLength: 1, maxLength: 32 },
    { key: "customerContactSecret", label: "Customer Contact Secret", secret: true as const, minLength: 8, maxLength: 256 }
  ],
  maxTools: 5
};

const context: DriverRuntimeContext = {
  connectionId: "wecom-connection",
  timeoutMs: 2_000,
  maxResponseBytes: 2_000_000,
  requestId: "wecom-request-1",
  credentials: {
    corpId: "ww_test_corp", appSecret: "app_secret_123", agentId: "1000002", customerContactSecret: "customer_secret_123"
  },
  manifest
};

const driver = new WeComConnectorDriver();
assert.equal((await driver.discoverTools(context)).tools.length, 5);
const departments = await driver.invokeTool(context, "wecom.departments.list", {});
assert.equal((departments.structuredContent?.departments as unknown[]).length, 2);

const members = await driver.invokeTool(context, "wecom.members.list", { departmentId: 2, includeChildren: true });
const firstMember = (members.structuredContent?.members as Array<Record<string, unknown>>)[0];
assert.equal(firstMember.userId, "seller_a");
assert.equal("mobile" in firstMember, false);
assert.equal("email" in firstMember, false);

const contactIds = await driver.invokeTool(context, "wecom.external_contacts.list", { userId: "seller_a" });
assert.deepEqual(contactIds.structuredContent?.externalUserIds, ["wm_customer_1"]);
const contact = await driver.invokeTool(context, "wecom.external_contacts.get", { externalUserId: "wm_customer_1" });
assert.equal((contact.structuredContent?.externalContact as Record<string, unknown>).corpName, "Example Imports");

const sent = await driver.invokeTool(context, "wecom.app_message.send_text", { userIds: ["seller_a"], content: "你有一条新的 CRM 待办" });
assert.equal(sent.structuredContent?.externalReceiptId, "wecom-message-001");
assert.equal(sent.structuredContent?.deliveryAccepted, true);
const sendRequest = requests.find((item) => item.path === "/wecom/cgi-bin/message/send");
assert.equal(sendRequest?.body.touser, "seller_a");
assert.equal(sendRequest?.body.enable_duplicate_check, 1);

await assert.rejects(
  () => driver.invokeTool(context, "wecom.app_message.send_text", { userIds: ["@all"], content: "禁止全员发送" }),
  /INTEGRATION_INPUT_INVALID/u
);
await driver.healthCheck(context);
assert.equal(appTokenRequests, 1, "同一连接的应用 access token 应在内存中复用");
assert.equal(customerTokenRequests, 1, "同一连接的客户联系 access token 应在内存中复用");

const report = await runConnectorDriverComplianceSuite({
  driver,
  validManifest: manifest,
  invalidManifest: { ...manifest, endpoint: "https://unapproved.example.test/" } as ConnectorManifest,
  context,
  knownToolName: "wecom.departments.list",
  knownToolInput: {},
  maxTools: 5,
  getToolNames: (value) => value.tools.map((tool) => tool.remoteName),
  validateKnownResult: (value) => assert.ok(value.structuredContent),
  isUnknownToolDenied: (error) => /INTEGRATION_TOOL_NOT_FOUND/u.test(error instanceof Error ? error.message : String(error))
});
assert.equal(report.ok, true);

await driver.closeConnection(context.connectionId);
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("WeCom official API connector tests passed");
