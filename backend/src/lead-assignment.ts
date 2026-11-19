/**
 * 线索指派（上级 → 员工）。
 *
 * 规则（2026-11-11 与用户确认的口径）：
 * - 只有持有 `lead.assign` 权限的账号能指派：legacy 里是 admin / manager，IAM 里看角色授权。
 * - 上级（admin / manager / 授权到部门及以上范围）可以指派本团队任意线索；
 *   业务员只能指派「进入自己账号」的线索，或改派「自己指派出去」的线索。
 * - 接收人必须是同团队、在职、非平台身份的账号；指派给自己等价于收回。
 * - 只保留最近一次指派信息用于一览表，完整改派历史写 leadActivities。
 */
import { hasIamPermission, hasIamScope } from "./auth.js";
import type { Lead, SessionUser, User } from "./types.js";

export interface AssignableMember {
  id: string;
  name: string;
  role: string;
  avatar: string;
}

export interface LeadAssignmentRow {
  leadId: string;
  company: string;
  country: string;
  stage: string;
  status: string;
  ownerId: string;
  ownerName: string;
  fromOwnerId: string;
  fromOwnerName: string;
  assignedBy: string;
  assignedByName: string;
  assignedAt: string;
  note: string;
}

/** 是否具备指派能力（不含具体线索的归属校验） */
export function canAssignLeads(user?: SessionUser) {
  if (!user) return false;
  return hasIamPermission(user, "lead.assign");
}

/** 租户级管理员（legacy admin 或 IAM 授权了 tenant 范围）可以管理全团队线索 */
function isTenantWideAssigner(user: SessionUser) {
  if (user.role === "admin") return true;
  return Boolean(user.iamPermissions?.["lead.assign"]?.includes("tenant"));
}

/**
 * 「上级」视角：legacy manager，或 IAM 把 `lead.assign` 授到了部门/子树/租户范围。
 *
 * 为什么需要这一条：线索通常是先落到主管账号（导入 / 平台询盘 / 展会名单），再由主管派给下属；
 * 但主管也要能把下属手上跟错人的线索重新分配。只允许「自己名下 / 自己派出去的」会把后者堵死，
 * 与「上级能对下级指派」的产品语义不符。范围仍由 `lead.teamId === user.teamId` 收口。
 */
function isSupervisorAssigner(user: SessionUser) {
  if (user.role === "admin" || user.role === "manager") return true;
  return hasIamScope(user, "lead.assign", ["org_unit", "org_subtree", "tenant"]);
}

/** 这条线索是否轮得到当前账号指派 / 改派 */
export function canAssignLead(user: SessionUser, lead: Lead) {
  if (!canAssignLeads(user)) return false;
  if (lead.teamId !== user.teamId) return false;
  if (isSupervisorAssigner(user)) return true;
  // 业务员：只能指派进自己账号的线索，或把之前由自己派出去的线索改派 / 收回
  return lead.ownerId === user.id || lead.assignedBy === user.id;
}

/** 可被指派的员工：同团队、在职、非平台身份 */
export function assignableMembersFor(users: User[], user: SessionUser): AssignableMember[] {
  return users
    .filter((item) =>
      item.teamId === user.teamId
      && item.status === "active"
      && item.id !== user.id
      && item.role !== "super_admin"
    )
    .map((item) => ({ id: item.id, name: item.name, role: item.role, avatar: item.avatar || "" }));
}

export interface ApplyAssignmentInput {
  lead: Lead;
  toOwnerId: string;
  actorId: string;
  note?: string;
  now: string;
}

/**
 * 把一条线索的负责人改成目标员工，并记录最近一次指派信息。
 * 返回 `changed=false` 表示目标与当前负责人相同（重复指派，静默成功）。
 */
export function applyLeadAssignment(input: ApplyAssignmentInput) {
  const fromOwnerId = input.lead.ownerId;
  if (fromOwnerId === input.toOwnerId) {
    return { changed: false, fromOwnerId };
  }
  input.lead.assignmentFrom = fromOwnerId;
  input.lead.assignedBy = input.actorId;
  input.lead.assignedAt = input.now;
  input.lead.assignmentNote = (input.note || "").trim();
  input.lead.ownerId = input.toOwnerId;
  input.lead.lastActivityAt = "刚刚";
  return { changed: true, fromOwnerId };
}

/**
 * 一览表数据：只看指派人，不按团队全量暴露。
 * - 租户级管理员：本团队所有指派记录
 * - 其他：自己指派出去的 + 自己当前名下的（后者只用于展示，未被指派过的不进表）
 */
export function leadAssignmentRows(
  leads: Lead[],
  users: User[],
  user: SessionUser
): LeadAssignmentRow[] {
  const nameOf = (id: string) => users.find((item) => item.id === id)?.name || "已删除账号";
  const tenantWide = isTenantWideAssigner(user);
  return leads
    .filter((lead) => {
      if (!lead.assignedBy || lead.deletedAt) return false;
      if (lead.teamId !== user.teamId) return false;
      return tenantWide || lead.assignedBy === user.id || lead.ownerId === user.id;
    })
    .sort((a, b) => (a.assignedAt || "") < (b.assignedAt || "") ? 1 : -1)
    .map((lead) => ({
      leadId: lead.id,
      company: lead.company,
      country: lead.country || "",
      stage: lead.stage || "",
      status: lead.status,
      ownerId: lead.ownerId,
      ownerName: nameOf(lead.ownerId),
      fromOwnerId: lead.assignmentFrom || "",
      fromOwnerName: lead.assignmentFrom ? nameOf(lead.assignmentFrom) : "",
      assignedBy: lead.assignedBy || "",
      assignedByName: lead.assignedBy ? nameOf(lead.assignedBy) : "",
      assignedAt: lead.assignedAt || "",
      note: lead.assignmentNote || ""
    }));
}
