/**
 * 回归测试：客户资料里的 WhatsApp 号码对所有有权查看该客户的人都可见。
 *
 * 背景（3.5.7 及以前）：customerWithPipeline() 会把 whatsapp / whatsappPhone 从响应里删掉，
 * 只要查看者不是该客户的负责人。带来的后果是业务员登记了号码，管理员打开客户看不到；
 * 更严重的是管理员打开编辑弹窗时输入框为空，随手保存其它字段就会把号码写成空串。
 *
 * 这里锁的就是「谁看都能看到客户自己的号码」这一条：
 * 负责人、管理员、同团队同事拿到的 whatsapp 必须一致且非空。
 */
import assert from "node:assert/strict";
import { customerWithPipeline } from "./server-core.js";
import { memoryStore } from "./store.js";
import type { Customer, SessionUser } from "./types.js";

const CUSTOMER_WHATSAPP = "+4915112345678";

function makeUser(patch: Partial<SessionUser> & Pick<SessionUser, "id" | "role">): SessionUser {
  return {
    name: patch.id,
    email: `${patch.id}@visibility-test.local`,
    teamId: "team-visibility",
    avatar: "",
    authVersion: 1,
    ...patch
  } as SessionUser;
}

function makeCustomer(ownerId: string): Customer {
  // 用种子客户做底板，避免漏字段；id / ownerId / whatsapp 全部重置成本用例自己的。
  const seed = memoryStore.customers[0];
  assert.ok(seed, "种子数据里至少要有一个客户，否则本用例无法构造底板");
  return {
    ...structuredClone(seed),
    id: "c_contact_visibility",
    ownerId,
    teamId: "team-visibility",
    whatsapp: CUSTOMER_WHATSAPP,
    whatsappPhone: ""
  } as Customer;
}

function main() {
  const owner = makeUser({ id: "u_vis_owner", role: "sales" });
  const admin = makeUser({ id: "u_vis_admin", role: "admin" });
  const teammate = makeUser({ id: "u_vis_teammate", role: "sales" });
  memoryStore.users.push(owner, admin, teammate);

  const customer = makeCustomer(owner.id);
  memoryStore.customers.unshift(customer);

  const asOwner = customerWithPipeline(customer, owner);
  const asAdmin = customerWithPipeline(customer, admin);
  const asTeammate = customerWithPipeline(customer, teammate);

  assert.equal(asOwner.whatsapp, CUSTOMER_WHATSAPP, "负责人自己应当看到客户的 WhatsApp 号码");
  assert.equal(
    asAdmin.whatsapp,
    CUSTOMER_WHATSAPP,
    "管理员必须能读到业务员登记的 WhatsApp 号码（3.5.7 回归点：以前这里被 delete 成 undefined）"
  );
  assert.equal(
    asTeammate.whatsapp,
    CUSTOMER_WHATSAPP,
    "同团队同事在有权查看该客户时也应看到同一个号码，不能再按 viewer 裁剪"
  );
  assert.equal(asAdmin.whatsappPhone, CUSTOMER_WHATSAPP, "whatsappPhone 兜底字段同样不能被裁掉");
  assert.equal(asTeammate.whatsappPhone, CUSTOMER_WHATSAPP, "whatsappPhone 兜底字段对同事同样可见");

  // 号码本身没有被改写：其它字段的读取路径不能顺手把空串写回去。
  const stored = memoryStore.customers.find((item) => item.id === customer.id)!;
  assert.equal(stored.whatsapp, CUSTOMER_WHATSAPP, "读取不应改动库里的原值");

  console.log("customer-contact-visibility-test: ok");
}

main();
