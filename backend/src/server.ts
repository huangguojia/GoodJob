import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { canSeeOwner, publicUser, requireAuth, signToken } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore, setStore } from "./store.js";
import type { Customer, Deal, SessionUser, Todo } from "./types.js";

export const app = express();
app.use(cors());
app.use(express.json());

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, store: getStore().mode });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

app.post("/api/auth/login", (req, res) => {
  const body = loginSchema.parse(req.body);
  const { users } = getStore();
  const user = users.find((item) => item.email === body.email && item.password === body.password && item.status === "active");
  if (!user) {
    res.status(401).json({ message: "账号或密码错误" });
    return;
  }
  const sessionUser = publicUser(user);
  res.json({ token: signToken(sessionUser), user: sessionUser });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/accounts", requireAuth, (req, res) => {
  if (req.user?.role !== "admin" && req.user?.role !== "manager") {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const { users } = getStore();
  const scoped = req.user.role === "admin" ? users : users.filter((user) => user.teamId === req.user?.teamId);
  res.json({ accounts: scoped.map(publicUser) });
});

app.post("/api/accounts", requireAuth, asyncRoute(async (req, res) => {
  if (req.user?.role !== "admin" && req.user?.role !== "manager") {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    role: z.enum(["sales", "manager", "admin"]).default("sales"),
    teamId: z.string().min(1).optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  if (store.users.some((user) => user.email === body.email)) {
    res.status(409).json({ message: "账号邮箱已存在" });
    return;
  }
  const teamId = req.user.role === "manager" ? req.user.teamId : body.teamId || req.user.teamId;
  const user = {
    id: `u_${Date.now()}`,
    name: body.name,
    email: body.email,
    password: "goodjob123",
    role: body.role,
    teamId,
    avatar: body.name.slice(0, 2).toUpperCase(),
    status: "active" as const
  };
  store.users.unshift(user);
  await store.persist();
  res.json({ account: publicUser(user) });
}));

app.patch("/api/accounts/:id/disable", requireAuth, asyncRoute(async (req, res) => {
  if (req.user?.role !== "admin" && req.user?.role !== "manager") {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const store = getStore();
  const user = store.users.find((item) => item.id === req.params.id);
  if (!user || (req.user.role === "manager" && user.teamId !== req.user.teamId)) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (user.id === req.user.id) {
    res.status(400).json({ message: "不能停用当前登录账号" });
    return;
  }
  user.status = "disabled";
  await store.persist();
  res.json({ account: publicUser(user) });
}));

app.get("/api/customers", requireAuth, (req, res) => {
  const { customers } = getStore();
  const scoped = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  res.json({ customers: scoped });
});

app.post("/api/customers", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1),
    country: z.string().min(1).default("未知"),
    contact: z.string().min(1).default("待维护"),
    stage: z.string().min(1).default("询盘"),
    amount: z.number().int().nonnegative().default(0)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = {
    id: `c_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    health: 72,
    nextReminder: "明天 10:00",
    wecomBound: false,
    ...body
  };
  store.customers.unshift(customer);
  await store.persist();
  res.json({ customer });
}));

app.get("/api/todos", requireAuth, (req, res) => {
  const { todos } = getStore();
  const scoped = todos.filter((todo) => canSeeOwner(req.user!, todo.ownerId, todo.teamId));
  res.json({ todos: scoped });
});

app.post("/api/todos", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    type: z.enum(["customer", "knowledge", "exam", "ocr", "other"]).default("other"),
    priority: z.enum(["high", "medium", "normal"]).default("normal"),
    dueAt: z.string().default(""),
    related: z.string().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const todo = {
    id: `t_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    done: false,
    status: "pending" as const,
    pinState: "" as const,
    sortOrder: nextTodoSortOrder(store.todos, req.user!.id, req.user!.teamId),
    createdAt: new Date().toISOString(),
    ...body
  };
  store.todos.unshift(todo);
  await store.persist();
  res.json({ todo });
}));

app.get("/api/deals", requireAuth, (req, res) => {
  const { deals } = getStore();
  const scoped = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId));
  res.json({ deals: scoped });
});

app.post("/api/deals", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    customerId: z.string().min(1),
    title: z.string().min(1),
    stage: z.enum(["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"]).default("询盘"),
    amount: z.number().int().nonnegative().default(0),
    nextAction: z.string().min(1).default("首次跟进")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = store.customers.find((item) => item.id === body.customerId);
  if (!customer || !canSeeOwner(req.user!, customer.ownerId, customer.teamId)) {
    res.status(404).json({ message: "客户不存在" });
    return;
  }
  const deal = {
    id: `d_${Date.now()}`,
    customerId: customer.id,
    title: body.title,
    stage: body.stage,
    amount: body.amount,
    ownerId: customer.ownerId,
    teamId: customer.teamId,
    nextAction: body.nextAction
  };
  store.deals.unshift(deal);
  await store.persist();
  res.json({ deal });
}));

app.patch("/api/deals/:id/stage", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ stage: z.enum(["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"]) });
  const store = getStore();
  const body = schema.parse(req.body);
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  deal.stage = body.stage;
  await store.persist();
  res.json({ deal });
}));

app.post("/api/todos/:id/complete", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeeOwner(req.user!, todo.ownerId, todo.teamId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  todo.done = true;
  todo.status = "pending";
  await store.persist();
  res.json({ todo });
}));

app.patch("/api/todos/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    type: z.enum(["customer", "knowledge", "exam", "ocr", "other"]).optional(),
    priority: z.enum(["high", "medium", "normal"]).optional(),
    dueAt: z.string().optional(),
    related: z.string().optional(),
    done: z.boolean().optional(),
    status: z.enum(["pending", "in_progress"]).optional(),
    pinState: z.enum(["top", "bottom", ""]).optional(),
    sortOrder: z.number().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeeOwner(req.user!, todo.ownerId, todo.teamId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  if (typeof body.done === "boolean") {
    todo.done = body.done;
    if (body.done) todo.status = "pending";
  }
  if (body.status) {
    todo.status = todo.done ? "pending" : body.status;
  }
  if (body.title) todo.title = body.title;
  if (body.type) todo.type = body.type;
  if (body.priority) todo.priority = body.priority;
  if (body.dueAt !== undefined) todo.dueAt = body.dueAt;
  if (body.related !== undefined) todo.related = body.related;
  if (body.pinState !== undefined) {
    todo.pinState = body.pinState;
  }
  if (typeof body.sortOrder === "number") {
    todo.sortOrder = body.sortOrder;
  }
  await store.persist();
  res.json({ todo });
}));

app.post("/api/todos/reorder", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    ids: z.array(z.string()).min(1),
    mode: z.enum(["manual", "top", "bottom"]).default("manual"),
    targetId: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const visibleTodos = store.todos.filter((todo) => canSeeOwner(req.user!, todo.ownerId, todo.teamId));
  const selected = body.ids.map((id) => visibleTodos.find((todo) => todo.id === id));
  if (selected.some((todo) => !todo)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  selected.forEach((todo, index) => {
    if (!todo) return;
    todo.sortOrder = index + 1;
    if (body.mode === "manual") {
      todo.pinState = "";
    } else if (todo.id === body.targetId) {
      todo.pinState = body.mode;
    }
  });
  await store.persist();
  res.json({ todos: selected.filter(Boolean) });
}));

app.delete("/api/todos/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.todos.findIndex((item) => item.id === req.params.id);
  const todo = index >= 0 ? store.todos[index] : null;
  if (!todo || !canSeeOwner(req.user!, todo.ownerId, todo.teamId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  store.todos.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

app.get("/api/problems", requireAuth, (req, res) => {
  const { problems } = getStore();
  const scoped = problems.filter((problem) => canSeeOwner(req.user!, problem.ownerId, problem.teamId));
  res.json({ problems: scoped });
});

app.post("/api/problems", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1).default("客户问题"),
    severity: z.enum(["high", "medium", "low"]).default("medium"),
    status: z.enum(["open", "solving", "resolved"]).default("open"),
    relatedCustomer: z.string().default(""),
    rootCause: z.string().default(""),
    solution: z.string().default(""),
    nextAction: z.string().default(""),
    dueAt: z.string().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const problem = {
    id: `p_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    createdAt: new Date().toISOString(),
    ...body
  };
  store.problems.unshift(problem);
  await store.persist();
  res.json({ problem });
}));

app.patch("/api/problems/:id/status", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ status: z.enum(["open", "solving", "resolved"]) });
  const body = schema.parse(req.body);
  const store = getStore();
  const problem = store.problems.find((item) => item.id === req.params.id);
  if (!problem || !canSeeOwner(req.user!, problem.ownerId, problem.teamId)) {
    res.status(404).json({ message: "问题不存在" });
    return;
  }
  problem.status = body.status;
  await store.persist();
  res.json({ problem });
}));

app.get("/api/memos", requireAuth, (req, res) => {
  const { memos } = getStore();
  const scoped = memos.filter((memo) => canSeeOwner(req.user!, memo.ownerId, memo.teamId));
  res.json({ memos: scoped });
});

app.post("/api/memos", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    content: z.string().default(""),
    category: z.string().min(1).default("客户备忘"),
    tags: z.string().default(""),
    pinned: z.boolean().default(false)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const memo = {
    id: `m_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    archived: false,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.memos.unshift(memo);
  await store.persist();
  res.json({ memo });
}));

app.patch("/api/memos/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    category: z.string().min(1).optional(),
    tags: z.string().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const memo = store.memos.find((item) => item.id === req.params.id);
  if (!memo || !canSeeOwner(req.user!, memo.ownerId, memo.teamId)) {
    res.status(404).json({ message: "备忘录不存在" });
    return;
  }
  if (typeof body.title === "string") memo.title = body.title;
  if (typeof body.content === "string") memo.content = body.content;
  if (typeof body.category === "string") memo.category = body.category;
  if (typeof body.tags === "string") memo.tags = body.tags;
  if (typeof body.pinned === "boolean") memo.pinned = body.pinned;
  if (typeof body.archived === "boolean") memo.archived = body.archived;
  memo.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ memo });
}));

app.delete("/api/memos/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.memos.findIndex((item) => item.id === req.params.id);
  const memo = index >= 0 ? store.memos[index] : null;
  if (!memo || !canSeeOwner(req.user!, memo.ownerId, memo.teamId)) {
    res.status(404).json({ message: "备忘录不存在" });
    return;
  }
  store.memos.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

app.get("/api/competitors", requireAuth, (req, res) => {
  const { competitors } = getStore();
  const scoped = competitors.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
  res.json({ competitors: scoped });
});

app.post("/api/competitors", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1),
    country: z.string().default(""),
    segment: z.string().default(""),
    threatLevel: z.enum(["high", "medium", "low"]).default("medium"),
    website: z.string().default(""),
    strengths: z.string().default(""),
    weaknesses: z.string().default(""),
    competingProducts: z.string().default(""),
    ourStrategy: z.string().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const competitor = {
    id: `cp_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.competitors.unshift(competitor);
  await store.persist();
  res.json({ competitor });
}));

app.patch("/api/competitors/:id/threat", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ threatLevel: z.enum(["high", "medium", "low"]) });
  const body = schema.parse(req.body);
  const store = getStore();
  const competitor = store.competitors.find((item) => item.id === req.params.id);
  if (!competitor || !canSeeOwner(req.user!, competitor.ownerId, competitor.teamId)) {
    res.status(404).json({ message: "竞争公司不存在" });
    return;
  }
  competitor.threatLevel = body.threatLevel;
  competitor.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ competitor });
}));

app.get("/api/case-studies", requireAuth, (req, res) => {
  const { caseStudies } = getStore();
  const scoped = caseStudies.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
  res.json({ caseStudies: scoped });
});

app.post("/api/case-studies", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    customer: z.string().default(""),
    country: z.string().default(""),
    product: z.string().default(""),
    industry: z.string().default(""),
    result: z.string().default(""),
    story: z.string().default(""),
    reusablePoints: z.string().default(""),
    status: z.enum(["draft", "published"]).default("draft")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const caseStudy = {
    id: `cs_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.caseStudies.unshift(caseStudy);
  await store.persist();
  res.json({ caseStudy });
}));

app.patch("/api/case-studies/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const caseStudy = store.caseStudies.find((item) => item.id === req.params.id);
  if (!caseStudy || !canSeeOwner(req.user!, caseStudy.ownerId, caseStudy.teamId)) {
    res.status(404).json({ message: "成功案例不存在" });
    return;
  }
  caseStudy.status = "published";
  caseStudy.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ caseStudy });
}));

app.get("/api/knowledge/assets", requireAuth, (_req, res) => {
  const { knowledgeAssets } = getStore();
  res.json({ assets: knowledgeAssets });
});

app.post("/api/knowledge/assets", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1).default("产品知识"),
    version: z.string().min(1).default("v1")
  });
  const store = getStore();
  const body = schema.parse(req.body);
  const asset = {
    id: `k_${Date.now()}`,
    status: req.user?.role === "sales" ? "review" as const : "published" as const,
    ownerId: req.user!.id,
    ...body
  };
  store.knowledgeAssets.unshift(asset);
  await store.persist();
  res.json({ asset });
}));

app.patch("/api/knowledge/assets/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  if (req.user?.role === "sales") {
    res.status(403).json({ message: "无发布资料权限" });
    return;
  }
  const store = getStore();
  const asset = store.knowledgeAssets.find((item) => item.id === req.params.id);
  if (!asset) {
    res.status(404).json({ message: "资料不存在" });
    return;
  }
  asset.status = "published";
  await store.persist();
  res.json({ asset });
}));

app.get("/api/exams", requireAuth, (_req, res) => {
  const { exams } = getStore();
  res.json({ exams });
});

app.post("/api/exams", requireAuth, asyncRoute(async (req, res) => {
  if (req.user?.role === "sales") {
    res.status(403).json({ message: "无发布考试权限" });
    return;
  }
  const store = getStore();
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1),
    questionCount: z.number().int().positive().default(20)
  });
  const body = schema.parse(req.body);
  const exam = {
    id: `e_${Date.now()}`,
    status: "scheduled" as const,
    passRate: 0,
    ...body
  };
  store.exams.unshift(exam);
  await store.persist();
  res.json({ exam });
}));

app.patch("/api/exams/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  if (req.user?.role === "sales") {
    res.status(403).json({ message: "无发布考试权限" });
    return;
  }
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  exam.status = "published";
  await store.persist();
  res.json({ exam });
}));

app.post("/api/exams/:id/submit", requireAuth, (req, res) => {
  const exam = getStore().exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const score = Number(req.body?.score ?? 86);
  res.json({ attempt: { id: `attempt_${exam.id}_${req.user!.id}`, examId: exam.id, userId: req.user!.id, score, passed: score >= 80 } });
});

app.get("/api/reminders", requireAuth, (req, res) => {
  const { reminders } = getStore();
  const scoped = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  res.json({ reminders: scoped });
});

app.post("/api/reminders", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    rule: z.string().min(1),
    dueAt: z.string().min(1).default("今天 17:00"),
    channel: z.enum(["站内", "邮件", "企业微信"]).default("企业微信")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const reminder = {
    id: `r_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    status: "pending" as const,
    ...body
  };
  store.reminders.unshift(reminder);
  await store.persist();
  res.json({ reminder });
}));

app.post("/api/reminders/:id/done", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const reminder = store.reminders.find((item) => item.id === req.params.id);
  if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
    res.status(404).json({ message: "提醒不存在" });
    return;
  }
  reminder.status = "done";
  await store.persist();
  res.json({ reminder });
}));

app.get("/api/import-export/jobs", requireAuth, (req, res) => {
  const { importExportJobs } = getStore();
  const scoped = req.user?.role === "sales"
    ? importExportJobs.filter((job) => job.operatorId === req.user?.id)
    : importExportJobs;
  res.json({ jobs: scoped });
});

app.post("/api/import-export/jobs", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ name: z.string().min(1), type: z.enum(["import", "export"]), rows: z.number().int().nonnegative() });
  const store = getStore();
  const body = schema.parse(req.body);
  const job = { id: `io_${Date.now()}`, status: body.type === "export" ? "review" as const : "done" as const, operatorId: req.user!.id, createdAt: "刚刚", ...body };
  store.importExportJobs.unshift(job);
  await store.persist();
  res.json({ job });
}));

app.get("/api/wecom/messages", requireAuth, (req, res) => {
  const { wecomMessages } = getStore();
  const scoped = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
  res.json({ messages: scoped });
});

app.post("/api/wecom/messages/:id/archive", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const message = store.wecomMessages.find((item) => item.id === req.params.id);
  if (!message || !canSeeOwner(req.user!, message.ownerId, message.teamId)) {
    res.status(404).json({ message: "企微摘要不存在" });
    return;
  }
  message.status = "archived";
  await store.persist();
  res.json({ message });
}));

app.get("/api/tools/ocr/jobs/:id", requireAuth, (req, res) => {
  const job = getStore().ocrJobs.find((item) => item.id === req.params.id);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  res.json({ job });
});

app.post("/api/tools/ocr/jobs/:id/recognize", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const job = store.ocrJobs.find((item) => item.id === req.params.id);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  job.status = "recognized";
  job.confidence = Number(req.body?.confidence ?? 96);
  job.fields = {
    ...job.fields,
    company: req.body?.company || job.fields.company || "NorthStar Lighting GmbH",
    contact: req.body?.contact || job.fields.contact || "James Müller",
    email: req.body?.email || job.fields.email || "james.mueller@northstar-light.de",
    whatsapp: req.body?.whatsapp || job.fields.whatsapp || "+49 151 2388 9012",
    wechat: req.body?.wechat || job.fields.wechat || "james_light_de",
    phone: req.body?.phone || job.fields.phone || "+49 30 8842 1290",
    country: req.body?.country || job.fields.country || "德国"
  };
  await store.persist();
  res.json({ job });
}));

app.post("/api/tools/ocr/jobs/:id/sync-lead", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const job = store.ocrJobs.find((item) => item.id === req.params.id);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  job.status = "synced";
  const lead = {
    id: `lead_${job.id}`,
    source: "名片 OCR",
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    ...job.fields
  };
  await store.persist();
  res.json({ lead });
}));

app.get("/api/dashboard/summary", requireAuth, (req, res) => {
  const { customers, todos, deals, reminders, knowledgeAssets, exams, wecomMessages } = getStore();
  const scopedCustomers = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedTodos = todos.filter((todo) => canSeeOwner(req.user!, todo.ownerId, todo.teamId));
  const scopedDeals = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId));
  const scopedReminders = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  const scopedKnowledge = req.user?.role === "sales" ? knowledgeAssets.filter((asset) => asset.ownerId === req.user?.id) : knowledgeAssets;
  const scopedMessages = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
  const activeTodos = scopedTodos.filter((todo) => !isHistoricalDue(todo.dueAt));
  const pendingTodos = activeTodos.filter((todo) => !todo.done);
  const overdueTodos = pendingTodos.filter((todo) => todo.priority === "high");
  const historyTodos = scopedTodos.filter((todo) => isHistoricalDue(todo.dueAt));
  const riskCustomers = scopedCustomers.filter((customer) => customer.nextReminder.includes("逾期") || customer.health < 60);
  const riskAmount = riskCustomers.reduce((sum, customer) => sum + customer.amount, 0);
  const forecastAmount = scopedDeals.reduce((sum, deal) => sum + deal.amount, 0) || scopedCustomers.reduce((sum, customer) => sum + customer.amount, 0);
  const wecomBound = scopedCustomers.filter((customer) => customer.wecomBound).length;
  const pendingKnowledge = scopedKnowledge.filter((asset) => asset.status !== "published");
  const publishedExams = exams.filter((exam) => exam.status === "published");
  const averagePassRate = publishedExams.length ? Math.round(publishedExams.reduce((sum, exam) => sum + exam.passRate, 0) / publishedExams.length) : 0;
  const pendingMessages = scopedMessages.filter((message) => message.status === "pending");
  const readyDeals = scopedDeals.filter((deal) => ["样品", "谈判", "成交"].includes(deal.stage));
  const topTodos = [...pendingTodos].sort((a, b) => (b.impactAmount || 0) - (a.impactAmount || 0) || priorityWeight(b.priority) - priorityWeight(a.priority)).slice(0, 3);
  const priorityTasks = buildPriorityTasks(scopedDeals, scopedCustomers, pendingTodos);
  const topDeals = priorityTasks.map((task) => task.deal);
  const pipelineHealth = buildPipelineHealth(scopedDeals, scopedCustomers);
  const typeRows = ["customer", "knowledge", "exam", "ocr", "other"].map((type) => {
    const items = pendingTodos.filter((todo) => todo.type === type);
    return {
      type,
      label: todoTypeLabel(type),
      count: items.length,
      risk: items.some((todo) => todo.priority === "high") ? "高" : items.some((todo) => todo.priority === "medium") ? "中" : "普通"
    };
  }).filter((row) => row.count > 0);
  const weekLoad = ["一", "二", "三", "四", "五", "六", "日"].map((day, index) => ({
    day,
    count: pendingTodos.filter((_, todoIndex) => todoIndex % 7 === index).length + (index < Math.min(pendingTodos.length, 7) ? 1 : 0)
  }));
  const topRiskNames = riskCustomers.slice(0, 3).map((customer) => customer.company).join("、") || topDeals.slice(0, 2).map((deal) => deal.title).join("、") || "暂无高风险客户";
  res.json({
    scope: req.user?.role === "sales" ? "仅本人数据" : req.user?.role === "manager" ? "团队全部数据" : "全量数据",
    updatedAt: new Date().toISOString(),
    briefing: {
      title: pendingTodos.length
        ? `今天最该处理的是 ${pendingTodos.length} 个待办，其中 ${overdueTodos.length} 个属于高优先级。`
        : "今天暂无未完成待办，可以复盘客户资料和销售知识库。",
      description: riskCustomers.length
        ? `系统根据客户金额、健康度、阶段和提醒状态计算，建议优先处理 ${topRiskNames}。`
        : `当前客户风险较低，建议推进 ${topDeals[0]?.title || "高金额商机"} 并保持企微记录归档。`,
      basis: `依据：${pendingTodos.length} 个未完成待办、${riskCustomers.length} 个风险客户、${readyDeals.length} 个可推进商机、${pendingMessages.length} 条企微待归档。`,
      action: overdueTodos.length
        ? `建议动作：先处理 ${overdueTodos.length} 个高优先级待办，再跟进金额最高的商机。`
        : `建议动作：按今日节奏完成待办，并把可成交商机推进到下一阶段。`,
      impact: riskAmount
        ? `影响范围：${moneyText(riskAmount)} 风险金额，处理后可降低逾期和报价流失。`
        : `影响范围：${moneyText(readyDeals.reduce((sum, deal) => sum + deal.amount, 0))} 可推进金额，适合用于晨会安排。`,
      riskAmount,
      riskLabel: req.user?.role === "sales" ? "本人名下风险" : "团队风险金额",
      closableDeals: readyDeals.length,
      closableAmount: readyDeals.reduce((sum, deal) => sum + deal.amount, 0),
      unreadWecom: pendingMessages.length
    },
    metrics: {
      customers: scopedCustomers.length,
      todos: pendingTodos.length,
      overdueTodos: overdueTodos.length,
      forecastAmount,
      wecomBoundRate: scopedCustomers.length ? Math.round((wecomBound / scopedCustomers.length) * 100) : 0,
      pendingKnowledge: pendingKnowledge.length,
      examPassRate: averagePassRate,
      unfinishedExams: exams.filter((exam) => exam.status !== "published").length,
      customerCompleteness: scopedCustomers.length ? Math.round(scopedCustomers.reduce((sum, customer) => sum + (customer.contact ? 25 : 0) + (customer.country ? 25 : 0) + (customer.stage ? 25 : 0) + (customer.nextReminder ? 25 : 0), 0) / scopedCustomers.length) : 0
    },
    schedule: topTodos.map((todo) => ({
      time: todo.dueAt || "待定",
      title: todo.title,
      subtitle: todo.related || todoTypeLabel(todo.type),
      tone: todo.priority === "high" ? "red" : todo.priority === "medium" ? "amber" : "green"
    })),
    quality: {
      followHealth: scopedCustomers.length ? Math.round(scopedCustomers.reduce((sum, customer) => sum + customer.health, 0) / scopedCustomers.length) : 0,
      overdueRate: pendingTodos.length ? Math.round((overdueTodos.length / pendingTodos.length) * 100) : 0,
      avgResponseHours: Number((Math.max(1, pendingMessages.length + scopedReminders.filter((reminder) => reminder.status === "pending").length) * 1.6).toFixed(1))
    },
    pipelineHealth,
    todoInsights: {
      total: pendingTodos.length,
      overdue: overdueTodos.length,
      completionRate: activeTodos.length ? Math.round((activeTodos.filter((todo) => todo.done).length / activeTodos.length) * 100) : 0,
      impactAmount: pendingTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0),
      typeRows,
      weekLoad,
      historyCount: historyTodos.length,
      historyAmount: historyTodos.reduce((sum, todo) => sum + (todo.impactAmount || 0), 0)
    },
    priorityTasks: priorityTasks.map(({ deal, customer, score, reason, action, tone }) => ({
      id: deal.id,
      customerId: customer?.id || deal.customerId,
      title: deal.title,
      subtitle: `${customer?.country || "未知国家"} · ${deal.stage} · ${moneyText(deal.amount)} · ${deal.nextAction}`,
      score,
      reason,
      action,
      tone,
      badge: customer?.nextReminder.includes("逾期") ? "逾期" : deal.stage
    }))
  });
});

app.post("/api/dashboard/priority-tasks/batch-process", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const scopedCustomers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedDeals = store.deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId));
  const scopedTodos = store.todos.filter((todo) => canSeeOwner(req.user!, todo.ownerId, todo.teamId));
  const pendingTodos = scopedTodos.filter((todo) => !todo.done && !isHistoricalDue(todo.dueAt));
  const priorityTasks = buildPriorityTasks(scopedDeals, scopedCustomers, pendingTodos).slice(0, 3);
  const created: Todo[] = [];
  for (const task of priorityTasks) {
    const exists = store.todos.some((todo) => !todo.done && todo.related === task.deal.title && todo.title.includes("跟进优先级"));
    if (exists) continue;
    const todo: Todo = {
      id: `t_priority_${task.deal.id}_${Date.now()}_${created.length}`,
      title: `跟进优先级：${task.action}`,
      type: "customer",
      priority: task.score >= 80 ? "high" : task.score >= 60 ? "medium" : "normal",
      dueAt: currentMinuteText(),
      ownerId: task.deal.ownerId,
      teamId: task.deal.teamId,
      related: task.deal.title,
      done: false,
      impactAmount: task.deal.amount,
      createdAt: new Date().toISOString()
    };
    store.todos.unshift(todo);
    created.push(todo);
  }
  await store.persist();
  res.json({ created, processed: priorityTasks.length, skipped: priorityTasks.length - created.length });
}));

function isHistoricalDue(value: string) {
  const parsed = parseDueDate(value);
  if (!parsed) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return parsed < today;
}

function parseDueDate(value: string) {
  const text = value.trim();
  const exact = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (exact) return new Date(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (text.includes("昨天")) return new Date(today.getTime() - 86400000);
  if (text.includes("前天")) return new Date(today.getTime() - 86400000 * 2);
  if (text.includes("今天") || /^(\d{1,2}):(\d{2})$/.test(text)) return today;
  if (text.includes("明天")) return new Date(today.getTime() + 86400000);
  return null;
}

function priorityWeight(priority: string) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function nextTodoSortOrder(todos: Todo[], ownerId: string, teamId: string) {
  const scoped = todos.filter((todo) => todo.ownerId === ownerId || todo.teamId === teamId);
  return Math.min(0, ...scoped.map((todo) => typeof todo.sortOrder === "number" ? todo.sortOrder : 0)) - 1;
}

function buildPriorityTasks(deals: Deal[], customers: Customer[], todos: Todo[]) {
  const maxAmount = Math.max(...deals.map((deal) => deal.amount), 1);
  return deals
    .filter((deal) => deal.stage !== "成交" && deal.stage !== "丢单")
    .map((deal) => {
      const customer = customers.find((item) => item.id === deal.customerId);
      const amountScore = Math.round((deal.amount / maxAmount) * 35);
      const stageScore = stagePriorityScore(deal.stage);
      const riskScore = customer?.nextReminder.includes("逾期") ? 25 : (customer?.health ?? 100) < 60 ? 18 : 0;
      const todoScore = todos.some((todo) => todo.related.includes(customer?.company || deal.title) || todo.related.includes(deal.title)) ? 10 : 0;
      const score = Math.min(100, amountScore + stageScore + riskScore + todoScore);
      const reasons = [
        `金额权重 ${amountScore}`,
        `阶段权重 ${stageScore}`,
        riskScore ? `风险权重 ${riskScore}` : "风险权重 0",
        todoScore ? "已有待办推动" : "暂无关联待办"
      ];
      const action = nextPriorityAction(deal, customer);
      const tone = score >= 80 ? "red" : score >= 60 ? "amber" : "brand";
      return { deal, customer, score, reason: reasons.join(" · "), action, tone };
    })
    .sort((left, right) => right.score - left.score || right.deal.amount - left.deal.amount)
    .slice(0, 3);
}

function buildPipelineHealth(deals: Deal[], customers: Customer[]) {
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"];
  const maxCount = Math.max(...stages.map((stage) => deals.filter((deal) => deal.stage === stage).length), 1);
  return stages.map((stage) => {
    const stageDeals = deals.filter((deal) => deal.stage === stage);
    const amount = stageDeals.reduce((sum, deal) => sum + deal.amount, 0);
    const riskCount = stageDeals.filter((deal) => {
      const customer = customers.find((item) => item.id === deal.customerId);
      return Boolean(customer?.nextReminder.includes("逾期")) || (customer?.health ?? 100) < 60;
    }).length;
    return {
      stage: stage === "成交" ? "成交" : stage,
      count: stageDeals.length,
      amount,
      riskCount,
      width: Math.max(8, Math.round((stageDeals.length / maxCount) * 100)),
      tone: riskCount ? "amber" : stage === "成交" ? "green" : stage === "丢单" ? "red" : "aqua"
    };
  }).filter((item) => item.stage !== "丢单" || item.count > 0);
}

function stagePriorityScore(stage: string) {
  const map: Record<string, number> = {
    谈判: 30,
    样品: 24,
    已报价: 20,
    已联系: 12,
    询盘: 8
  };
  return map[stage] || 6;
}

function nextPriorityAction(deal: Deal, customer?: Customer) {
  if (customer?.nextReminder.includes("逾期")) return `二次跟进 ${customer.company} 并确认 ${deal.nextAction}`;
  if ((customer?.health ?? 100) < 60) return `补齐 ${customer?.company || deal.title} 的风险资料并同步主管`;
  if (deal.stage === "谈判") return `确认 ${deal.title} 的价格、账期和成交条件`;
  if (deal.stage === "样品") return `确认 ${deal.title} 的样品反馈和复购时间`;
  if (deal.stage === "已报价") return `发送 ${deal.title} 的报价二次确认`;
  return `推进 ${deal.title} 的下一步：${deal.nextAction}`;
}

function todoTypeLabel(type: string) {
  const map: Record<string, string> = {
    customer: "客户跟进",
    knowledge: "资料维护",
    exam: "在线考试",
    ocr: "OCR 线索",
    other: "其它"
  };
  return map[type] || "其它";
}

function moneyText(value: number) {
  return `$${Math.round(value / 1000)}k`;
}

function currentMinuteText() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

app.get("/api/reports/executive", requireAuth, (req, res) => {
  const { customers } = getStore();
  const scopedCustomers = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  res.json({
    title: "2026 年 6 月外贸销售经营汇报",
    forecastAmount: scopedCustomers.reduce((sum, customer) => sum + customer.amount, 0),
    conversionRate: 18.6,
    riskAmount: scopedCustomers.filter((customer) => customer.nextReminder === "已逾期").reduce((sum, customer) => sum + customer.amount, 0),
    conclusions: [
      "成交预测可达成",
      "报价跟进是短板",
      "欧洲市场质量最高",
      "培训影响转化"
    ]
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: "参数格式错误", issues: error.issues });
    return;
  }
  const message = error instanceof Error ? error.message : "服务器错误";
  res.status(500).json({ message });
});

async function startServer() {
  const port = Number(process.env.PORT || 4188);
  if (process.env.CRM_STORE === "mysql" || process.env.DATABASE_URL || process.env.MYSQL_URL) {
    try {
      const store = await createMysqlStore();
      setStore(store);
      console.log("GoodJob CRM using MySQL persistence");
    } catch (error) {
      console.warn(`GoodJob CRM MySQL unavailable, using memory store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  app.listen(port, () => {
    console.log(`GoodJob CRM API listening on http://127.0.0.1:${port}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
