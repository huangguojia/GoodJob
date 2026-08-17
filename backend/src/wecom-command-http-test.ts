import assert from "node:assert/strict";
import assert from "node:assert/strict";
import { encryptIntegrationValue } from "./integrations/integration-credential-vault.js";
import { app } from "./server.js";
import { getStore } from "./store.js";
import {
  assertWeComSignature,
  decryptWeComMessage,
  encryptWeComMessage
} from "./wecom-command-gateway.js";
import type { WecomCommandEndpoint, WecomMemberBinding } from "./types.js";

const config = {
  corpId: "ww_http_test_corp",
  callbackToken: "goodjob-http-callback-token",
  encodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
};
const masterKey = process.env.INTEGRATION_CREDENTIAL_KEY || "goodjob-wecom-http-test-master-key-at-least-32";
const endpoint: WecomCommandEndpoint = {
  id: "wce_http_test",
  connectionId: "wecom_connection_http_test",
  callbackPublicId: "wcb_http_test",
  teamId: "europe",
  ownerId: "u_admin",
  corpId: config.corpId,
  callbackTokenEncrypted: "",
  encodingAesKeyEncrypted: "",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const context = {
  teamId: endpoint.teamId,
  ownerId: endpoint.ownerId,
  connectionId: endpoint.connectionId,
  artifactType: "wecom_command_callback"
};
endpoint.callbackTokenEncrypted = encryptIntegrationValue(config.callbackToken, masterKey, context);
endpoint.encodingAesKeyEncrypted = encryptIntegrationValue(config.encodingAesKey, masterKey, context);

const binding: WecomMemberBinding = {
  id: "wmb_http_test",
  connectionId: endpoint.connectionId,
  teamId: endpoint.teamId,
  wecomUserId: "zhangsan",
  crmUserId: "u_sales_shirley",
  status: "active",
  verifiedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const otherBinding: WecomMemberBinding = {
  ...binding,
  id: "wmb_http_other",
  wecomUserId: "lisi",
  crmUserId: "u_sales_mia"
};
const store = getStore();
store.wecomCommandEndpoints = [endpoint];
store.wecomMemberBindings = [binding, otherBinding];
store.wecomCommandReceipts = [];
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

function encryptedRequest(content: string, msgId: string, timestamp = "1720000000", nonce = `nonce-${msgId}`) {
  const inboundXml = `<xml><ToUserName><![CDATA[${config.corpId}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${msgId}</MsgId><AgentID>1000001</AgentID></xml>`;
  const envelope = encryptWeComMessage(inboundXml, config, timestamp, nonce);
  return {
    body: `<xml><Encrypt><![CDATA[${envelope.encrypted}]]></Encrypt></xml>`,
    query: `msg_signature=${envelope.signature}&timestamp=${timestamp}&nonce=${nonce}`
  };
}

function decryptReply(body: string, timestamp: string, nonce: string) {
  const encrypted = body.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/u)?.[1] || "";
  const signature = body.match(/<MsgSignature>([\s\S]*?)<\/MsgSignature>/u)?.[1] || "";
  assert.ok(encrypted && signature, "企业微信回应应包含加密内容和签名");
  assertWeComSignature({ token: config.callbackToken, timestamp, nonce, encrypted, signature });
  return decryptWeComMessage(encrypted, config.encodingAesKey, config.corpId);
}

try {
  const salesLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "shirley@goodjob.com", password: "goodjob123" })
  });
  assert.equal(salesLogin.status, 200);
  const salesLoginBody = await salesLogin.json() as { token?: string };
  const selfBindings = await fetch(`${baseUrl}/api/wecom-command/bindings`, {
    headers: { authorization: `Bearer ${salesLoginBody.token || ""}` }
  });
  assert.equal(selfBindings.status, 200);
  const selfBindingBody = await selfBindings.json() as { bindings?: WecomMemberBinding[] };
  assert.deepEqual((selfBindingBody.bindings || []).map((item) => item.crmUserId), ["u_sales_shirley"]);

  const echo = encryptWeComMessage("echo-http-test", config, "1720000001", "echo-nonce");
  const echoResponse = await fetch(`${baseUrl}/api/wecom/commands/${endpoint.callbackPublicId}?msg_signature=${echo.signature}&timestamp=${echo.timestamp}&nonce=${echo.nonce}&echostr=${encodeURIComponent(echo.encrypted)}`);
  assert.equal(echoResponse.status, 200);
  assert.equal(await echoResponse.text(), "echo-http-test");

  const read = encryptedRequest("查我的待办", "msg-http-read");
  const readResponse = await fetch(`${baseUrl}/api/wecom/commands/${endpoint.callbackPublicId}?${read.query}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: read.body
  });
  assert.equal(readResponse.status, 200);
  assert.match(decryptReply(await readResponse.text(), "1720000000", "nonce-msg-http-read"), /我的待办/u);
  assert.equal(store.wecomCommandReceipts?.length, 1);

  const duplicateResponse = await fetch(`${baseUrl}/api/wecom/commands/${endpoint.callbackPublicId}?${read.query}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: read.body
  });
  assert.equal(duplicateResponse.status, 200);
  assert.match(decryptReply(await duplicateResponse.text(), "1720000000", "nonce-msg-http-read"), /处理过/u);
  assert.equal(store.wecomCommandReceipts?.length, 1);

  const customerBefore = store.customers.find((item) => item.id === "c1")?.company;
  const write = encryptedRequest("把客户转交给李四", "msg-http-write");
  const writeResponse = await fetch(`${baseUrl}/api/wecom/commands/${endpoint.callbackPublicId}?${write.query}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: write.body
  });
  assert.equal(writeResponse.status, 200);
  assert.match(decryptReply(await writeResponse.text(), "1720000000", "nonce-msg-http-write"), /待确认/u);
  assert.equal(store.customers.find((item) => item.id === "c1")?.company, customerBefore);

  const unbound = encryptedRequest("查我的客户", "msg-http-unbound").body;
  const unboundEnvelope = encryptWeComMessage(
    `<xml><ToUserName><![CDATA[${config.corpId}]]></ToUserName><FromUserName><![CDATA[unbound]]></FromUserName><CreateTime>1720000002</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[查我的客户]]></Content><MsgId>msg-http-unbound</MsgId><AgentID>1000001</AgentID></xml>`,
    config,
    "1720000002",
    "nonce-unbound"
  );
  const unboundResponse = await fetch(`${baseUrl}/api/wecom/commands/${endpoint.callbackPublicId}?msg_signature=${unboundEnvelope.signature}&timestamp=${unboundEnvelope.timestamp}&nonce=${unboundEnvelope.nonce}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: unbound.replace(/<Encrypt>[\s\S]*?<\/Encrypt>/u, `<Encrypt><![CDATA[${unboundEnvelope.encrypted}]]></Encrypt>`)
  });
  assert.match(await unboundResponse.text(), /<Encrypt>/u);
  assert.equal(store.wecomCommandReceipts?.length, 3);

  console.log(JSON.stringify({ ok: true, urlVerification: true, signedAesCallback: true, duplicateGuard: true, memberIsolation: true, writeApprovalBoundary: true }));
} finally {
  server.close();
}
