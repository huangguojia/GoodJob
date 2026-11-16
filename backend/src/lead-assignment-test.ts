import assert from "node:assert/strict";
import {
  applyLeadAssignment,
  assignableMembersFor,
  canAssignLead,
  canAssignLeads,
  leadAssignmentRows
} from "./lead-assignment.js";
import type { Lead, SessionUser, User } from "./types.js";

// ---------------------------------------------------------------------------
// 线索指派 / 改派：权限口径、接收人过滤、归属变更、一览表可见范围
//
// 全部纯函数，不连库、不起服务。
// ---------------------------------------------------------------------------

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
}

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "u_admin",
    name: "Admin",
    email: "admin@goodjob.com",
    role: "admin",
    teamId: "europe",
    avatar: "AD",
    authVersion: 1,
    ...overrides
  } as SessionUser;
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: "u_sales",
    name: "Mia",
    email: "mia@goodjob.com",
    password: "x",
    role: "sales",
    teamId: "europe",
    avatar: "MI",
    status: "active",
    ...overrides
  } as User;
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead_1",
    company: "Acme Weighing",
    contact: "Tom",
    country: "Germany",
    email: "tom@acme.de",
    phone: "",
    wechat: "",
    source: "手动录入",
    intent: "中",
    stage: "新线索",
    status: "new",
    ownerId: "u_sales",
    teamId: "europe",
    estimatedAmount: 0,
    nextFollowAt: "",
    lastActivityAt: "",
    remark: "",
    convertedCustomerId: "",
    convertedDealId: "",
    sourceType: "outbound",
    sourceChannel: "manual",
    sourceCampaign: "",
    externalId: "",
    sourceUrl: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides
  };
}

// ── 1. 谁能指派 ────────────────────────────────────────────────────────────
ok(canAssignLeads(sessionUser({ role: "admin" })) === true, "legacy admin 能指派");
ok(canAssignLeads(sessionUser({ role: "manager" })) === true, "legacy manager 能指派");
ok(canAssignLeads(sessionUser({ role: "sales", id: "u_sales" })) === false, "legacy sales 不能指派");
ok(canAssignLeads(undefined) === false, "未登录不能指派");
ok(
  canAssignLeads(sessionUser({ role: "sales", iamPermissions: { "lead.assign": ["self"] } })) === true,
  "IAM 授权了 lead.assign 的业务员能指派自己的线索"
);

// ── 2. 上级可以指派本团队任意线索（含下属名下） ──────────────────────────
ok(
  canAssignLead(sessionUser({ role: "manager" }), lead({ ownerId: "u_sales" })),
  "主管可以改派下属名下的线索"
);
ok(
  canAssignLead(sessionUser({ role: "admin" }), lead({ ownerId: "u_sales" })),
  "管理员可以指派本团队任意线索"
);
ok(
  !canAssignLead(sessionUser({ role: "manager" }), lead({ teamId: "asia" })),
  "跨团队线索不能被指派"
);
ok(
  canAssignLead(
    sessionUser({ role: "sales", id: "u_lead", iamPermissions: { "lead.assign": ["org_subtree"] } }),
    lead({ ownerId: "u_sales" })
  ),
  "IAM 授权到子树范围时可以指派下属线索"
);

// ── 3. 业务员只能处理「进自己账号 / 自己派出去」的线索 ────────────────────
const rep = sessionUser({ role: "sales", id: "u_sales", iamPermissions: { "lead.assign": ["self"] } });
ok(canAssignLead(rep, lead({ ownerId: "u_sales" })), "业务员可以指派自己名下的线索");
ok(!canAssignLead(rep, lead({ ownerId: "u_other" })), "业务员不能指派别人名下的线索");
ok(
  canAssignLead(rep, lead({ ownerId: "u_other", assignedBy: "u_sales" })),
  "业务员可以改派自己之前派出去的线索"
);
ok(
  !canAssignLead(rep, lead({ ownerId: "u_other", assignedBy: "u_manager" })),
  "业务员不能改派别人派出去的线索"
);

// ── 4. 接收人过滤 ──────────────────────────────────────────────────────────
const members = assignableMembersFor(
  [
    user({ id: "u_admin", name: "Admin", role: "admin" }),
    user({ id: "u_manager", name: "Alex", role: "manager" }),
    user({ id: "u_sales", name: "Mia", role: "sales" }),
    user({ id: "u_disabled", name: "Gone", role: "sales", status: "disabled" }),
    user({ id: "u_other_team", name: "Bob", role: "sales", teamId: "asia" }),
    user({ id: "u_super", name: "Root", role: "super_admin" })
  ],
  sessionUser({ id: "u_admin" })
);
ok(members.length === 2, `接收人只含同团队在职员工（不含自己），实际 ${members.length}`);
ok(!members.some((member) => member.id === "u_admin"), "指派给自己不出现在候选列表（收回走单独选项）");
ok(members.some((member) => member.id === "u_manager"), "主管出现在候选列表");
ok(members.some((member) => member.id === "u_sales"), "在职业务员出现在候选列表");
ok(!members.some((member) => member.id === "u_disabled"), "停用账号被排除");
ok(!members.some((member) => member.id === "u_other_team"), "跨团队账号被排除");
ok(!members.some((member) => member.id === "u_super"), "super_admin 被排除");

// ── 5. 归属变更与留痕字段 ─────────────────────────────────────────────────
const targetLead = lead({ ownerId: "u_sales" });
const applied = applyLeadAssignment({
  lead: targetLead,
  toOwnerId: "u_manager",
  actorId: "u_admin",
  note: " 德国区优先 ",
  now: "2026-11-11T08:00:00.000Z"
});
ok(applied.changed === true, "指派确实发生变更");
ok(applied.fromOwnerId === "u_sales", "返回改派前负责人");
ok(targetLead.ownerId === "u_manager", "负责人已变更为接收人");
ok(targetLead.assignmentFrom === "u_sales", "记录改派前负责人");
ok(targetLead.assignedBy === "u_admin", "记录指派人");
ok(targetLead.assignedAt === "2026-11-11T08:00:00.000Z", "记录指派时间");
ok(targetLead.assignmentNote === "德国区优先", "备注去除首尾空白");
ok(targetLead.lastActivityAt === "刚刚", "最近活动时间刷新");

const sameOwner = lead({ ownerId: "u_manager", assignedBy: "u_admin", assignmentNote: "旧备注" });
const noop = applyLeadAssignment({
  lead: sameOwner,
  toOwnerId: "u_manager",
  actorId: "u_admin",
  note: "新备注",
  now: "2026-11-11T09:00:00.000Z"
});
ok(noop.changed === false, "重复指派同一人不产生变更");
ok(sameOwner.assignmentNote === "旧备注", "重复指派不覆盖历史备注");
ok(sameOwner.assignedAt === undefined, "重复指派不刷新指派时间");

// ── 6. 一览表：可见范围、时间倒序、账号名兜底 ────────────────────────────
const users = [
  user({ id: "u_admin", name: "Admin", role: "admin" }),
  user({ id: "u_manager", name: "Alex", role: "manager" }),
  user({ id: "u_sales", name: "Mia", role: "sales" })
];
const leads = [
  lead({ id: "lead_old", company: "Old Co", ownerId: "u_sales", assignedBy: "u_manager", assignedAt: "2026-11-01T00:00:00.000Z", assignmentFrom: "u_manager" }),
  lead({ id: "lead_new", company: "New Co", ownerId: "u_sales", assignedBy: "u_manager", assignedAt: "2026-11-10T00:00:00.000Z", assignmentFrom: "u_manager", assignmentNote: "展会" }),
  lead({ id: "lead_mine", company: "Mine Co", ownerId: "u_admin", assignedBy: "u_admin", assignedAt: "2026-11-05T00:00:00.000Z", assignmentFrom: "u_sales" }),
  lead({ id: "lead_never", company: "Never Assigned", ownerId: "u_sales" }),
  lead({ id: "lead_deleted", company: "Deleted", ownerId: "u_sales", assignedBy: "u_manager", assignedAt: "2026-11-09T00:00:00.000Z", deletedAt: "2026-11-09T01:00:00.000Z" }),
  lead({ id: "lead_ghost", company: "Ghost", ownerId: "u_unknown", assignedBy: "u_admin", assignedAt: "2026-11-08T00:00:00.000Z" })
];

const adminRows = leadAssignmentRows(leads, users, sessionUser({ role: "admin" }));
ok(adminRows.length === 4, `管理员看到本轮全部有效指派记录，实际 ${adminRows.length}`);
ok(adminRows[0].leadId === "lead_new", "按指派时间倒序");
ok(adminRows[0].note === "展会", "备注随记录返回");
ok(!adminRows.some((row) => row.leadId === "lead_never"), "从未指派过的线索不进一览表");
ok(!adminRows.some((row) => row.leadId === "lead_deleted"), "垃圾箱线索不进一览表");
ok(adminRows.find((row) => row.leadId === "lead_ghost")?.ownerName === "已删除账号", "账号缺失时名称兜底");

const managerRows = leadAssignmentRows(leads, users, sessionUser({ id: "u_manager", role: "manager" }));
ok(managerRows.length === 2, `主管只看到自己派人 + 自己名下的记录，实际 ${managerRows.length}`);
ok(managerRows.every((row) => row.assignedByName === "Alex"), "主管视角记录全部由自己指派");

const adminAsOwnerRows = leadAssignmentRows(leads, users, sessionUser({ id: "u_admin", role: "admin" }));
ok(adminAsOwnerRows.some((row) => row.leadId === "lead_new"), "管理员可见下属指派记录");

console.log(`lead-assignment-test: ${passed} assertions passed`);
