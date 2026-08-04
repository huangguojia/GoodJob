import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { getStore } from "./store.js";
import type { Customer, SessionUser } from "./types.js";

type Store = ReturnType<typeof getStore>;

export interface CustomerRouteDeps {
  getStore: () => Store;
  requireAuth: RequestHandler;
  asyncRoute: (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) => RequestHandler;
  canSeeOwner: (user: SessionUser, ownerId: string, teamId: string) => boolean;
  canSeePersonalData: (user: SessionUser, ownerId: string) => boolean;
  isPublicCustomer: (customer: Customer) => boolean;
  publicPoolCustomersFor: (user: SessionUser) => Customer[];
  ownedCustomersFor: (user: SessionUser, scope?: "mine" | "team") => Customer[];
  customerWithPipeline: (customer: Customer, viewer?: SessionUser) => any;
  customerPoolCounts: (user: SessionUser) => { mineCount: number; publicCount: number };
  findWritableCustomer: (user: SessionUser, customerId: string, res: Response) => Customer | null;
  sendCustomerOwnershipError: (res: Response, error: unknown) => boolean;
}

export function registerCustomersRoutes(app: Express, deps: CustomerRouteDeps) {
  const {
    getStore,
    requireAuth,
    asyncRoute,
    canSeeOwner,
    canSeePersonalData,
    isPublicCustomer,
    publicPoolCustomersFor,
    ownedCustomersFor,
    customerWithPipeline,
    customerPoolCounts,
    findWritableCustomer,
    sendCustomerOwnershipError,
  } = deps;

app.get("/api/customers", requireAuth, (req, res) => {
  const parsedScope = z.enum(["mine", "public", "team"]).safeParse(req.query.scope || "mine");
  if (!parsedScope.success) {
    res.status(400).json({ message: "客户范围参数无效" });
    return;
  }
  const scoped = parsedScope.data === "public"
    ? publicPoolCustomersFor(req.user!)
    : ownedCustomersFor(req.user!, parsedScope.data);
  res.json({
    customers: scoped.map((customer) => customerWithPipeline(customer, req.user!)),
    ...customerPoolCounts(req.user!)
  });
});

app.post("/api/customers", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1),
    country: z.string().min(1).default("未知"),
    contact: z.string().min(1).default("待维护"),
    whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional().default(""),
    stage: z.string().min(1).default("询盘"),
    amount: z.number().int().nonnegative().default(0),
    health: z.number().int().min(0).max(100).optional().default(72),
    grade: z.enum(["A", "B", "C", "D"]).optional().default("C"),
    billingName: z.string().optional().default(""),
    billingAddress: z.string().optional().default(""),
    documentContact: z.string().optional().default(""),
    phone: z.string().optional().default(""),
    email: z.string().optional().default(""),
    website: z.string().optional().default(""),
    defaultPortDischarge: z.string().optional().default(""),
    defaultIncoterm: z.string().optional().default(""),
    defaultPaymentTerm: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = {
    id: `c_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    nextReminder: "明天 10:00",
    wecomBound: false,
    ...body
  };
  store.customers.unshift(customer);
  await store.persist();
  res.json({ customer: customerWithPipeline(customer, req.user!) });
}));

app.patch("/api/customers/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "WhatsApp 号码须包含国家码").or(z.literal("")).optional(),
    stage: z.string().min(1).optional(),
    amount: z.number().int().nonnegative().optional(),
    health: z.number().int().min(0).max(100).optional(),
    grade: z.enum(["A", "B", "C", "D"]).optional(),
    nextReminder: z.string().min(1).optional(),
    wecomBound: z.boolean().optional(),
    billingName: z.string().optional(),
    billingAddress: z.string().optional(),
    documentContact: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    website: z.string().optional(),
    defaultPortDischarge: z.string().optional(),
    defaultIncoterm: z.string().optional(),
    defaultPaymentTerm: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = findWritableCustomer(req.user!, req.params.id, res);
  if (!customer) return;
  Object.assign(customer, body);
  await store.persist();
  res.json({ customer: customerWithPipeline(customer, req.user!) });
}));

app.post("/api/customers/:id/release", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    reason: z.string().trim().min(2).max(500),
    expectedVersion: z.number().int().nonnegative().optional()
  }).parse(req.body);
  const store = getStore();
  if (!store.mutateCustomerOwnership) {
    res.status(503).json({ message: "客户公池服务暂不可用" });
    return;
  }
  try {
    const result = await store.mutateCustomerOwnership({
      action: "release",
      customerId: req.params.id,
      actorId: req.user!.id,
      actorRole: req.user!.role,
      actorTeamId: req.user!.teamId,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      occurredAt: new Date().toISOString()
    });
    res.json({
      customer: customerWithPipeline(result.customer, req.user!),
      event: result.event,
      cancelledTodoCount: result.cancelledTodoIds.length,
      ...customerPoolCounts(req.user!)
    });
  } catch (error) {
    if (!sendCustomerOwnershipError(res, error)) throw error;
  }
}));

app.post("/api/customers/:id/claim", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    expectedVersion: z.number().int().nonnegative().optional()
  }).parse(req.body || {});
  const store = getStore();
  if (!store.mutateCustomerOwnership) {
    res.status(503).json({ message: "客户公池服务暂不可用" });
    return;
  }
  try {
    const result = await store.mutateCustomerOwnership({
      action: "claim",
      customerId: req.params.id,
      actorId: req.user!.id,
      actorRole: req.user!.role,
      actorTeamId: req.user!.teamId,
      expectedVersion: body.expectedVersion,
      occurredAt: new Date().toISOString()
    });
    res.json({
      customer: customerWithPipeline(result.customer, req.user!),
      event: result.event,
      ...customerPoolCounts(req.user!)
    });
  } catch (error) {
    if (!sendCustomerOwnershipError(res, error)) throw error;
  }
}));

app.post("/api/customers/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
  const body = schema.parse(req.body);
  const store = getStore();
  const ids = [...new Set(body.ids)];
  const deleted = store.customers.filter((customer) =>
    ids.includes(customer.id)
    && !isPublicCustomer(customer)
    && canSeeOwner(req.user!, customer.ownerId, customer.teamId)
  );
  if (!deleted.length) {
    res.status(404).json({ message: "未找到可删除的客户" });
    return;
  }
  const deletedIds = new Set(deleted.map((customer) => customer.id));
  const deletedNames = deleted.map((customer) => customer.company);
  store.customers = store.customers.filter((customer) => !deletedIds.has(customer.id));
  store.customerActivities = store.customerActivities.filter((activity) => !deletedIds.has(activity.customerId));
  store.customerIntelligenceSuggestions =
    store.customerIntelligenceSuggestions.filter(
      (suggestion) => !deletedIds.has(suggestion.customerId)
    );
  const deletedDealIds = new Set(store.deals.filter((deal) => deletedIds.has(deal.customerId)).map((deal) => deal.id));
  store.deals = store.deals.filter((deal) => !deletedIds.has(deal.customerId));
  store.dealEvents = store.dealEvents.filter((event) => !deletedDealIds.has(event.dealId));
  store.todos = store.todos.filter((todo) => {
    const currentUserTodo = canSeePersonalData(req.user!, todo.ownerId);
    const relatedToDeletedCustomer = deletedNames.some((name) => todo.related.includes(name) || todo.title.includes(name));
    return !currentUserTodo || !relatedToDeletedCustomer;
  });
  await store.persist();
  const customers = ownedCustomersFor(req.user!);
  res.json({ deleted, customers });
}));
}
