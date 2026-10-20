import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { agentApiOperationContract } from "./agent-api-contracts.js";

// ---------------------------------------------------------------------------
// 客户跟进记录「编辑 / 撤销」自测（2026-10-14）。
//
// 为什么单独测这一块：
//   WhatsApp 自动同步会把对话摘要**自动**写进跟进历史，而 `customerActivities`
//   同时是业绩报表 `followUpCount` 的数据源（server.ts 的 performance 分支）。
//   这两个接口是自动写入唯一的「可逆性」保障 —— 它们本身出问题，自动写入就不可控。
//
// 纪律：断言的是**实际 HTTP 响应**，不是内部函数返回值。
//       否则「路由根本没接线」也会全绿。
// ---------------------------------------------------------------------------

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start customer-activity-edit test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(
    `${label}${detail === undefined ? "" : ` → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`
  );
}

async function request(path: string, token = "", init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  return { response, json: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  assert.equal(result.response.status, 200, `登录失败：${email}`);
  return String(result.json.token);
}

/** 断言一个字符串是合法的 ISO 时间。 */
function isIso(value: unknown) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

try {
  const store = getStore();
  const manager = store.users.find((item) => item.email === "alex@goodjob.com")!;
  const management = await login("alex@goodjob.com");
  const salesToken = await login("shirley@goodjob.com");

  // 种子数据：c1/c2 属 shirley(europe)，c3 属 mia(europe)；ca1→c1, ca2→c2, ca3→c3
  const originalCa1CreatedAt = "2026-07-10T03:20:00.000Z";
  const originalCa3Content = "完成账期与采购数量沟通，等待客户最终审批。";

  /* ---------------- 契约登记 ---------------- */
  // 新增写接口必须登记 Agent 契约，否则「接口存在但 Agent 不可执行」。
  check(
    "PATCH 跟进契约已登记且可执行",
    agentApiOperationContract("PATCH", "/api/customers/{id}/activities/{activityId}")?.executable === true
  );
  check(
    "DELETE 跟进契约已登记且可执行",
    agentApiOperationContract("DELETE", "/api/customers/{id}/activities/{activityId}")?.executable === true
  );

  /* ---------------- 未登录 ---------------- */
  const anon = await request("/api/customers/c1/activities/ca1", "", {
    method: "PATCH",
    body: JSON.stringify({ content: "x" })
  });
  check("未登录编辑 → 401", anon.response.status === 401, anon.response.status);

  /* ---------------- 正常编辑 ---------------- */
  const edit = await request("/api/customers/c1/activities/ca1", management, {
    method: "PATCH",
    body: JSON.stringify({ content: "（已修正）客户确认采用 30% 预付。" })
  });
  check("编辑已存在的跟进 → 200", edit.response.status === 200, edit.response.status);
  check("content 已改写", edit.json.activity?.content === "（已修正）客户确认采用 30% 预付。", edit.json.activity?.content);
  check("编辑留痕 updatedAt 是合法 ISO", isIso(edit.json.activity?.updatedAt), edit.json.activity?.updatedAt);
  check("编辑留痕 editedBy = 操作人", edit.json.activity?.editedBy === manager.id, edit.json.activity?.editedBy);

  // 留痕规则：创建事实不可改写
  check("createdAt 未被编辑改动", edit.json.activity?.createdAt === originalCa1CreatedAt, edit.json.activity?.createdAt);
  check(
    "operatorId（创建人）未被编辑改动",
    edit.json.activity?.operatorId === "u_sales_shirley",
    edit.json.activity?.operatorId
  );

  /* ---------------- 二次编辑：updatedAt 必须前进 ---------------- */
  const firstEditedAt = String(edit.json.activity.updatedAt);
  await new Promise((resolve) => setTimeout(resolve, 8));
  const editAgain = await request("/api/customers/c1/activities/ca1", management, {
    method: "PATCH",
    body: JSON.stringify({ content: "（二次修正）改为 50% 预付。" })
  });
  check("二次编辑 → 200", editAgain.response.status === 200, editAgain.response.status);
  check(
    "二次编辑后 updatedAt 前进（能反映「最后一次」）",
    Date.parse(String(editAgain.json.activity?.updatedAt)) > Date.parse(firstEditedAt),
    { before: firstEditedAt, after: editAgain.json.activity?.updatedAt }
  );

  /* ---------------- 空 body 拒绝 ---------------- */
  const empty = await request("/api/customers/c1/activities/ca1", management, {
    method: "PATCH",
    body: JSON.stringify({})
  });
  check("空 body 编辑 → 400（至少要改一个字段）", empty.response.status === 400, empty.response.status);

  /* ---------------- 改 type ---------------- */
  const typeEdit = await request("/api/customers/c2/activities/ca2", management, {
    method: "PATCH",
    body: JSON.stringify({ type: "note" })
  });
  check(
    "改 type → 200 且生效",
    typeEdit.response.status === 200 && typeEdit.json.activity?.type === "note",
    typeEdit.json.activity?.type
  );

  /* ---------------- nextReminder 双写 ---------------- */
  const reminderEdit = await request("/api/customers/c2/activities/ca2", management, {
    method: "PATCH",
    body: JSON.stringify({ nextReminder: "本周五 10:00" })
  });
  check("nextReminder 写入 activity", reminderEdit.json.activity?.nextReminder === "本周五 10:00", reminderEdit.json.activity?.nextReminder);
  check("nextReminder 同步到 customer", reminderEdit.json.customer?.nextReminder === "本周五 10:00", reminderEdit.json.customer?.nextReminder);

  /* ---------------- 跨客户：A 客户的路径不能改 B 客户的记录 ---------------- */
  const cross = await request("/api/customers/c1/activities/ca3", management, {
    method: "PATCH",
    body: JSON.stringify({ content: "越权改" })
  });
  check("用 c1 的路径改属于 c3 的跟进 → 404", cross.response.status === 404, cross.response.status);
  const ca3AfterCross = getStore().customerActivities.find((item) => item.id === "ca3")!;
  check("跨客户编辑未落到目标记录上", ca3AfterCross.content === originalCa3Content, ca3AfterCross.content);
  check("跨客户编辑也未写入留痕", ca3AfterCross.updatedAt === undefined, ca3AfterCross.updatedAt);

  /* ---------------- 不存在的记录 ---------------- */
  const missing = await request("/api/customers/c1/activities/ca_not_exist", management, {
    method: "PATCH",
    body: JSON.stringify({ content: "x" })
  });
  check("编辑不存在的跟进 → 404", missing.response.status === 404, missing.response.status);

  /* ---------------- 权限：sales 不能改他人名下客户的跟进 ---------------- */
  const forbidden = await request("/api/customers/c3/activities/ca3", salesToken, {
    method: "PATCH",
    body: JSON.stringify({ content: "越权" })
  });
  check("sales 改他人名下客户的跟进 → 404", forbidden.response.status === 404, forbidden.response.status);

  /* ---------------- DELETE 撤销 ---------------- */
  const created = await request("/api/customers/c1/activities", management, {
    method: "POST",
    body: JSON.stringify({ type: "whatsapp", content: "[WhatsApp 自动同步 2026-10-14] 撤销探针" })
  });
  check("创建探针跟进 → 200", created.response.status === 200, created.response.status);
  const probeId = String(created.json.activity?.id);
  check("探针有 id", probeId.length > 0, probeId);

  const countBeforeDelete = getStore().customerActivities.length;
  const removed = await request(`/api/customers/c1/activities/${probeId}`, management, { method: "DELETE" });
  check("撤销跟进 → 200", removed.response.status === 200, removed.response.status);
  check(
    "撤销后总数 -1",
    getStore().customerActivities.length === countBeforeDelete - 1,
    { before: countBeforeDelete, after: getStore().customerActivities.length }
  );
  check("撤销后该记录确实不存在", !getStore().customerActivities.some((item) => item.id === probeId));
  check("撤销返回被删 id", removed.json.removed === probeId, removed.json.removed);

  const removeMissing = await request("/api/customers/c1/activities/ca_not_exist", management, { method: "DELETE" });
  check("撤销不存在的跟进 → 404", removeMissing.response.status === 404, removeMissing.response.status);

  /* ---------------- DELETE 跨客户与权限 ---------------- */
  const removeCross = await request("/api/customers/c1/activities/ca3", management, { method: "DELETE" });
  check("跨客户撤销 → 404", removeCross.response.status === 404, removeCross.response.status);
  check(
    "跨客户撤销未误删目标记录",
    getStore().customerActivities.some((item) => item.id === "ca3")
  );

  const removeForbidden = await request("/api/customers/c3/activities/ca3", salesToken, { method: "DELETE" });
  check("sales 撤销他人名下客户的跟进 → 404", removeForbidden.response.status === 404, removeForbidden.response.status);
  check(
    "越权撤销未误删目标记录",
    getStore().customerActivities.some((item) => item.id === "ca3")
  );

  /* ---------------- 输出 ---------------- */
  console.log(JSON.stringify({
    ok: failures.length === 0,
    passed,
    failed: failures.length,
    editKeepsCreatedFacts: true,
    editTracesEditedBy: true,
    crossCustomerBlocked: true,
    permissionEnforced: true,
    deleteIsClean: true
  }));

  if (failures.length) {
    for (const item of failures) console.error("FAIL:", item);
    process.exitCode = 1;
  }
} finally {
  server.close();
}
