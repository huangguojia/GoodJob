import type { CrmStore } from "./store.js";
import type {
  Customer,
  CustomerOwnershipEvent,
  CustomerOwnershipMutationInput,
  CustomerOwnershipMutationResult
} from "./types.js";

export class CustomerOwnershipError extends Error {
  constructor(
    public readonly code:
      | "CUSTOMER_NOT_FOUND"
      | "CUSTOMER_POOL_FORBIDDEN"
      | "CUSTOMER_POOL_ACTIVE_DEAL"
      | "CUSTOMER_POOL_ALREADY_PUBLIC"
      | "CUSTOMER_POOL_ALREADY_CLAIMED"
      | "CUSTOMER_POOL_VERSION_CONFLICT",
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "CustomerOwnershipError";
  }
}

function fail(
  code: CustomerOwnershipError["code"],
  message: string,
  status: number
): never {
  throw new CustomerOwnershipError(code, message, status);
}

export function isPublicCustomer(customer: Customer) {
  return customer.poolStatus === "public";
}

export function isOwnedCustomer(customer: Customer) {
  return !isPublicCustomer(customer);
}

export function canReleaseCustomer(
  customer: Customer,
  input: CustomerOwnershipMutationInput
) {
  if (input.actorRole === "sales") {
    return customer.ownerId === input.actorId
      && customer.teamId === input.actorTeamId;
  }
  if (input.actorRole === "manager" || input.actorRole === "admin") {
    return customer.teamId === input.actorTeamId;
  }
  return false;
}

export function assertCustomerOwnershipMutation(
  store: Pick<CrmStore, "customers" | "deals">,
  input: CustomerOwnershipMutationInput
) {
  const customer = store.customers.find((item) => item.id === input.customerId);
  if (!customer) {
    fail("CUSTOMER_NOT_FOUND", "客户不存在", 404);
  }
  if (typeof input.expectedVersion === "number"
    && (customer.ownershipVersion || 0) !== input.expectedVersion) {
    fail("CUSTOMER_POOL_VERSION_CONFLICT", "客户归属状态已变化，请刷新后重试", 409);
  }
  if (input.action === "release") {
    if (isPublicCustomer(customer)) {
      fail("CUSTOMER_POOL_ALREADY_PUBLIC", "该客户已在团队公池中", 409);
    }
    if (!canReleaseCustomer(customer, input)) {
      fail("CUSTOMER_POOL_FORBIDDEN", "只能释放本人或本团队负责的客户", 403);
    }
    const hasActiveDeal = store.deals.some((deal) =>
      deal.customerId === customer.id
      && !deal.archivedAt
      && deal.stage !== "成交"
      && deal.stage !== "丢单"
    );
    if (hasActiveDeal) {
      fail(
        "CUSTOMER_POOL_ACTIVE_DEAL",
        "该客户仍有活跃商机，请先完成、关闭或移交商机后再释放",
        409
      );
    }
    if (!String(input.reason || "").trim()) {
      fail("CUSTOMER_POOL_FORBIDDEN", "请填写释放原因", 400);
    }
    return customer;
  }
  if (customer.teamId !== input.actorTeamId) {
    fail("CUSTOMER_POOL_FORBIDDEN", "不能领取其他团队的公池客户", 403);
  }
  if (!["sales", "manager", "admin"].includes(input.actorRole)) {
    fail("CUSTOMER_POOL_FORBIDDEN", "当前账号不能领取公池客户", 403);
  }
  if (!isPublicCustomer(customer)) {
    fail("CUSTOMER_POOL_ALREADY_CLAIMED", "该客户已被其他同事领取", 409);
  }
  return customer;
}

export function mutateCustomerOwnershipMemory(
  store: CrmStore,
  input: CustomerOwnershipMutationInput
): CustomerOwnershipMutationResult {
  const customer = assertCustomerOwnershipMutation(store, input);
  const now = new Date(input.occurredAt).toISOString();
  const formerOwnerId = customer.ownerId;
  const event: CustomerOwnershipEvent = {
    id: `coe_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    customerId: customer.id,
    teamId: customer.teamId,
    fromOwnerId: formerOwnerId,
    toOwnerId: input.action === "claim" ? input.actorId : "",
    action: input.action === "release" ? "released" : "claimed",
    reason: input.action === "release"
      ? String(input.reason || "").trim()
      : "从团队公池领取",
    operatorId: input.actorId,
    createdAt: now
  };
  const cancelledTodoIds: string[] = [];

  if (input.action === "release") {
    customer.ownerId = "";
    customer.poolStatus = "public";
    customer.previousOwnerId = formerOwnerId;
    customer.releasedBy = input.actorId;
    customer.releasedAt = now;
    customer.releaseReason = event.reason;
    customer.claimedAt = "";
    for (const todo of store.todos) {
      if (todo.customerId !== customer.id || todo.done || todo.cancelledAt) continue;
      todo.done = true;
      todo.status = "pending";
      todo.historyAt = now;
      todo.cancelledAt = now;
      todo.cancellationReason = `客户已释放到团队公池：${event.reason}`;
      cancelledTodoIds.push(todo.id);
    }
  } else {
    customer.ownerId = input.actorId;
    customer.poolStatus = "owned";
    customer.claimedAt = now;
  }
  customer.ownershipVersion = (customer.ownershipVersion || 0) + 1;
  store.customerOwnershipEvents.unshift(event);
  return {
    customer: structuredClone(customer),
    event: structuredClone(event),
    cancelledTodoIds
  };
}
