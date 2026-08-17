import assert from "node:assert/strict";
import { buildAccessControlOverview } from "./access-control-overview.js";
import type { SessionUser, User } from "./types.js";

const users: User[] = [
  { id: "admin_a", name: "Admin A", email: "admin-a@example.test", password: "x", role: "admin", teamId: "tenant_a", avatar: "AA", status: "active" },
  { id: "manager_a", name: "Manager A", email: "manager-a@example.test", password: "x", role: "manager", teamId: "tenant_a", avatar: "MA", status: "active" },
  { id: "sales_a", name: "Sales A", email: "sales-a@example.test", password: "x", role: "sales", teamId: "tenant_a", avatar: "SA", status: "disabled" },
  { id: "admin_b", name: "Admin B", email: "admin-b@example.test", password: "x", role: "admin", teamId: "tenant_b", avatar: "AB", status: "active" },
  { id: "root", name: "Root", email: "root@example.test", password: "x", role: "super_admin", teamId: "all", avatar: "RT", status: "active" }
];
const actor = (id: string) => users.find((user) => user.id === id) as SessionUser;
const profiles = [{ teamId: "tenant_a", companyName: "A Company", website: "", productSummary: "", address: "", phone: "", email: "", updatedBy: "", updatedAt: "" }];

const overview = buildAccessControlOverview({ actor: actor("admin_a"), users, companyProfiles: profiles });
assert.equal(overview.company?.id, "tenant_a");
assert.equal(overview.members.length, 3);
assert.equal(overview.metrics?.activeMemberCount, 2);
assert.equal(overview.roles.find((role) => role.code === "sales")?.memberCount, 1);
assert.equal(overview.permissions.find((permission) => permission.code === "lead.read")?.grants.legacy_sales, "self");
assert.equal(overview.members.some((member) => member.id === "admin_b"), false);

assert.throws(
  () => buildAccessControlOverview({ actor: actor("admin_a"), users, companyProfiles: profiles, requestedTeamId: "tenant_b" }),
  /公司不存在/u
);
const platform = buildAccessControlOverview({ actor: actor("root"), users, companyProfiles: profiles });
assert.equal(platform.company, null);
assert.equal(platform.companies.length, 2);
const selected = buildAccessControlOverview({ actor: actor("root"), users, companyProfiles: profiles, requestedTeamId: "tenant_b" });
assert.equal(selected.company?.id, "tenant_b");
assert.equal(selected.members.length, 1);
assert.throws(
  () => buildAccessControlOverview({ actor: actor("manager_a"), users, companyProfiles: profiles }),
  /没有组织与权限查看权限/u
);

console.log(JSON.stringify({
  ok: true,
  tenantIsolation: true,
  explicitPlatformTenantContext: true,
  realMemberProjection: true,
  legacyPermissionPreview: true
}, null, 2));
