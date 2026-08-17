import assert from "node:assert/strict";
import {
  assertWeComSignature,
  decryptWeComMessage,
  encryptWeComMessage,
  fastWeComCommand,
  looksLikeWriteCommand,
  parseWeComEncryptedXml,
  parseWeComInboundMessage,
  weComSignature
} from "./wecom-command-gateway.js";

const config = {
  corpId: "ww_test_corp",
  callbackToken: "goodjob-callback-token",
  encodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
};
const xml = "<xml><ToUserName><![CDATA[ww_test_corp]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1720000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[查我的待办]]></Content><MsgId>123456</MsgId><AgentID>1000001</AgentID></xml>";
const encrypted = encryptWeComMessage(xml, config, "1720000000", "nonce-test");
assert.equal(decryptWeComMessage(encrypted.encrypted, config.encodingAesKey, config.corpId), xml);
const exactBlock = encryptWeComMessage("x".repeat(32), config, "1720000001", "nonce-exact-block");
assert.equal(decryptWeComMessage(exactBlock.encrypted, config.encodingAesKey, config.corpId), "x".repeat(32));
assert.doesNotThrow(() => assertWeComSignature({ ...encrypted, token: config.callbackToken }));
assert.throws(() => assertWeComSignature({ ...encrypted, token: config.callbackToken, signature: "0".repeat(40) }), /签名校验失败/u);
assert.deepEqual(parseWeComInboundMessage(xml), {
  toUserName: "ww_test_corp", fromUserName: "zhangsan", createTime: "1720000000",
  msgType: "text", content: "查我的待办", msgId: "123456", agentId: "1000001"
});
assert.deepEqual(parseWeComEncryptedXml(`<xml><Encrypt><![CDATA[${encrypted.encrypted}]]></Encrypt></xml>`, config, encrypted.signature, encrypted.timestamp, encrypted.nonce).content, "查我的待办");
assert.equal(looksLikeWriteCommand("把客户转交给李四"), true);
assert.equal(looksLikeWriteCommand("查本周我的商机"), false);
assert.match(fastWeComCommand("查我的待办", {
  todos: [{ title: "跟进 Nordic Tools", dueAt: "今天 16:00", priority: "high" }], customers: [], deals: []
}), /Nordic Tools/u);
console.log(JSON.stringify({ ok: true, signature: true, encryption: true, parser: true, fastRead: true }));
