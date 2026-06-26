import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { canSeeOwner, publicUser, requireAuth, signToken } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore, setStore } from "./store.js";

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
    type: z.enum(["customer", "knowledge", "exam", "ocr"]).default("customer"),
    priority: z.enum(["high", "medium", "normal"]).default("normal"),
    dueAt: z.string().min(1).default("今天"),
    related: z.string().min(1).default("未关联")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const todo = {
    id: `t_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    done: false,
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
  await store.persist();
  res.json({ todo });
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
  const { customers, todos } = getStore();
  const scopedCustomers = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedTodos = todos.filter((todo) => canSeeOwner(req.user!, todo.ownerId, todo.teamId));
  res.json({
    scope: req.user?.role === "sales" ? "仅本人数据" : req.user?.role === "manager" ? "团队全部数据" : "全量数据",
    metrics: {
      customers: scopedCustomers.length,
      todos: scopedTodos.length,
      overdueTodos: scopedTodos.filter((todo) => todo.priority === "high" && !todo.done).length,
      forecastAmount: scopedCustomers.reduce((sum, customer) => sum + customer.amount, 0)
    }
  });
});

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
