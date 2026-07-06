import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { canManageAccounts, canManageRole, canSeeOwner, canSeePersonalData, publicUser, requireAuth, signToken } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore, setStore } from "./store.js";
import type { AiModelConfig, Customer, Deal, Exam, ExamAttempt, ExamQuestion, SessionUser, Todo, WebsiteOpportunity } from "./types.js";

export const app = express();
app.use(cors());
app.use(express.json());

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function accountUser(user: ReturnType<typeof getStore>["users"][number]) {
  return { ...publicUser(user), status: user.status };
}

function examQuestionsFor(examId: string) {
  const store = getStore();
  const linkedIds = store.examQuestionLinks
    .filter((link) => link.examId === examId)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((link) => link.questionId);
  const linked = linkedIds
    .map((questionId) => store.examQuestions.find((question) => question.id === questionId))
    .filter(Boolean) as ExamQuestion[];
  if (linked.length) return linked;
  return store.examQuestions.filter((question) => question.examId === examId);
}

function bankQuestions() {
  const store = getStore();
  return store.examQuestions
    .filter((question) => question.examId === "bank" || !question.examId || !store.exams.some((exam) => exam.id === question.examId))
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

function examWithRuntimeStats(exam: Exam) {
  const store = getStore();
  const questions = examQuestionsFor(exam.id);
  const attempts = store.examAttempts.filter((attempt) => attempt.examId === exam.id);
  const passRate = attempts.length
    ? Math.round((attempts.filter((attempt) => attempt.passed).length / attempts.length) * 100)
    : exam.passRate;
  return {
    ...exam,
    questionCount: questions.length || exam.questionCount,
    passRate
  };
}

function examReport() {
  const store = getStore();
  const attempts = store.examAttempts;
  const totalAttempts = attempts.length;
  const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
  const averageScore = totalAttempts ? Math.round(attempts.reduce((sum, attempt) => sum + attempt.score, 0) / totalAttempts) : 0;
  const retakeAttempts = attempts.filter((attempt) => !attempt.passed).length;
  const questionCount = bankQuestions().length;
  const difficultyRows = ["easy", "medium", "hard"].map((difficulty) => {
    const count = bankQuestions().filter((question) => question.difficulty === difficulty).length;
    return {
      difficulty,
      label: difficulty === "easy" ? "基础题" : difficulty === "hard" ? "高阶题" : "应用题",
      count,
      ratio: questionCount ? Math.round((count / questionCount) * 100) : 0
    };
  });
  const categoryRows = store.exams.map((exam) => {
    const examAttempts = attempts.filter((attempt) => attempt.examId === exam.id);
    const participants = new Set(examAttempts.map((attempt) => attempt.userId)).size;
    const passRate = examAttempts.length ? Math.round((examAttempts.filter((attempt) => attempt.passed).length / examAttempts.length) * 100) : exam.passRate;
    const avgScore = examAttempts.length ? Math.round(examAttempts.reduce((sum, attempt) => sum + attempt.score, 0) / examAttempts.length) : 0;
    return { examId: exam.id, title: exam.title, category: exam.category, participants, passRate, avgScore };
  });
  const latestAttempts = attempts.slice(0, 6).map((attempt) => {
    const exam = store.exams.find((item) => item.id === attempt.examId);
    const user = store.users.find((item) => item.id === attempt.userId);
    return {
      ...attempt,
      examTitle: exam?.title || "未知考试",
      category: exam?.category || "未分类",
      userName: user?.name || "未知用户"
    };
  });
  return {
    totalAttempts,
    passedAttempts,
    retakeAttempts,
    averageScore,
    questionCount,
    categoryRows,
    difficultyRows,
    latestAttempts
  };
}

function refreshExamStats(exam: Exam) {
  const store = getStore();
  const attempts = store.examAttempts.filter((attempt) => attempt.examId === exam.id);
  const questionCount = examQuestionsFor(exam.id).length;
  exam.questionCount = questionCount || exam.questionCount;
  exam.passRate = attempts.length ? Math.round((attempts.filter((attempt) => attempt.passed).length / attempts.length) * 100) : exam.passRate;
  exam.updatedAt = new Date().toISOString();
}

const examQuestionSchema = z.object({
  stem: z.string().min(1),
  category: z.string().min(1).default("产品知识"),
  options: z.array(z.string().min(1)).min(2).max(6),
  answerIndex: z.number().int().nonnegative().optional(),
  answerIndexes: z.array(z.number().int().nonnegative()).optional(),
  questionType: z.enum(["single", "multiple"]).optional(),
  tags: z.array(z.string()).optional().default([]),
  explanation: z.string().min(1).default("请在题库维护中补充解析。"),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium")
});

function uniqueSortedIndexes(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function correctIndexesFor(question: ExamQuestion) {
  return uniqueSortedIndexes(question.answerIndexes?.length ? question.answerIndexes : [question.answerIndex]);
}

function indexesEqual(left: number[], right: number[]) {
  const a = uniqueSortedIndexes(left);
  const b = uniqueSortedIndexes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildExamQuestion(body: z.infer<typeof examQuestionSchema>, index = 0): ExamQuestion {
  const answerIndexes = uniqueSortedIndexes(body.answerIndexes?.length ? body.answerIndexes : [body.answerIndex ?? 0]);
  if (answerIndexes.some((answerIndex) => answerIndex >= body.options.length)) {
    throw new Error("正确答案序号超出选项数量");
  }
  return {
    id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    examId: "bank",
    category: body.category,
    stem: body.stem,
    options: body.options,
    answerIndex: answerIndexes[0],
    answerIndexes,
    questionType: body.questionType || (answerIndexes.length > 1 ? "multiple" : "single"),
    tags: body.tags || [],
    explanation: body.explanation,
    difficulty: body.difficulty,
    updatedAt: new Date().toISOString()
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
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const { users } = getStore();
  res.json({ accounts: users.map(accountUser) });
});

app.post("/api/accounts", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6),
    role: z.enum(["sales", "manager", "admin", "super_admin"]).default("sales"),
    teamId: z.string().min(1).optional()
  });
  const body = schema.parse(req.body);
  if (!canManageRole(req.user!, body.role)) {
    res.status(403).json({ message: "无权创建该角色账号" });
    return;
  }
  const store = getStore();
  if (store.users.some((user) => user.email === body.email)) {
    res.status(409).json({ message: "账号邮箱已存在" });
    return;
  }
  const teamId = body.role === "super_admin" || body.role === "admin" ? "all" : body.teamId || req.user!.teamId;
  const user = {
    id: `u_${Date.now()}`,
    name: body.name,
    email: body.email,
    password: body.password,
    role: body.role,
    teamId,
    avatar: body.name.slice(0, 2).toUpperCase(),
    status: "active" as const
  };
  store.users.unshift(user);
  await store.persist();
  res.json({ account: accountUser(user) });
}));

app.patch("/api/accounts/:id/password", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const schema = z.object({ password: z.string().min(6) });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (!canManageRole(req.user!, user.role)) {
    res.status(403).json({ message: "无权设置该账号密码" });
    return;
  }
  user.password = body.password;
  await store.persist();
  res.json({ account: accountUser(user) });
}));

app.patch("/api/accounts/:id/disable", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const store = getStore();
  const user = store.users.find((item) => item.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (user.id === req.user!.id) {
    res.status(400).json({ message: "不能停用当前登录账号" });
    return;
  }
  if (!canManageRole(req.user!, user.role)) {
    res.status(403).json({ message: "无权停用该角色账号" });
    return;
  }
  user.status = "disabled";
  await store.persist();
  res.json({ account: accountUser(user) });
}));

app.delete("/api/accounts/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageAccounts(req.user)) {
    res.status(403).json({ message: "无账号管理权限" });
    return;
  }
  const store = getStore();
  const index = store.users.findIndex((item) => item.id === req.params.id);
  const user = index >= 0 ? store.users[index] : null;
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (user.id === req.user!.id) {
    res.status(400).json({ message: "不能删除当前登录账号" });
    return;
  }
  if (!canManageRole(req.user!, user.role)) {
    res.status(403).json({ message: "无权删除该角色账号" });
    return;
  }
  store.users.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
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

app.patch("/api/customers/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    amount: z.number().int().nonnegative().optional(),
    nextReminder: z.string().min(1).optional(),
    wecomBound: z.boolean().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const customer = store.customers.find((item) => item.id === req.params.id);
  if (!customer || !canSeeOwner(req.user!, customer.ownerId, customer.teamId)) {
    res.status(404).json({ message: "客户不存在" });
    return;
  }
  Object.assign(customer, body);
  await store.persist();
  res.json({ customer });
}));

app.post("/api/customers/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ ids: z.array(z.string()).min(1).max(200) });
  const body = schema.parse(req.body);
  const store = getStore();
  const ids = [...new Set(body.ids)];
  const deleted = store.customers.filter((customer) => ids.includes(customer.id) && canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  if (!deleted.length) {
    res.status(404).json({ message: "未找到可删除的客户" });
    return;
  }
  const deletedIds = new Set(deleted.map((customer) => customer.id));
  const deletedNames = deleted.map((customer) => customer.company);
  store.customers = store.customers.filter((customer) => !deletedIds.has(customer.id));
  store.deals = store.deals.filter((deal) => !deletedIds.has(deal.customerId));
  store.todos = store.todos.filter((todo) => !deletedNames.some((name) => todo.related.includes(name) || todo.title.includes(name)));
  await store.persist();
  const customers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  res.json({ deleted, customers });
}));

app.get("/api/todos", requireAuth, (req, res) => {
  const store = getStore();
  const archived = archiveExpiredTodos(store.todos, new Date());
  if (archived.length) void store.persist();
  const { todos } = store;
  const scoped = todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
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
    sortOrder: nextTodoSortOrder(store.todos, req.user!.id),
    createdAt: new Date().toISOString(),
    historyAt: "",
    ...body
  };
  if (shouldArchiveTodo(todo)) {
    todo.historyAt = new Date().toISOString();
    todo.status = "pending" as const;
  }
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
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  todo.done = true;
  todo.status = "pending";
  await store.persist();
  res.json({ todo });
}));

app.post("/api/todos/archive-due", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const scoped = store.todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const archived = archiveExpiredTodos(scoped, new Date());
  if (archived.length) await store.persist();
  res.json({ archived });
}));

app.post("/api/todos/:id/restore", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
    res.status(404).json({ message: "待办不存在" });
    return;
  }
  todo.historyAt = "";
  todo.dueAt = currentMinuteText();
  todo.sortOrder = nextTodoSortOrder(store.todos, todo.ownerId);
  todo.pinState = "";
  if (todo.status === "in_progress" && todo.done) todo.status = "pending";
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
    sortOrder: z.number().optional(),
    historyAt: z.string().optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const todo = store.todos.find((item) => item.id === req.params.id);
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
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
  if (body.historyAt !== undefined) {
    todo.historyAt = body.historyAt;
  }
  if (body.historyAt === undefined && shouldArchiveTodo(todo)) {
    todo.historyAt = new Date().toISOString();
    todo.status = "pending";
    todo.pinState = "";
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
  const visibleTodos = store.todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
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
  if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
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
  const scoped = memos.filter((memo) => canSeePersonalData(req.user!, memo.ownerId));
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
  if (!memo || !canSeePersonalData(req.user!, memo.ownerId)) {
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
  if (!memo || !canSeePersonalData(req.user!, memo.ownerId)) {
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

app.get("/api/exam-questions", requireAuth, (req, res) => {
  const category = String(req.query.category || "").trim();
  const tag = String(req.query.tag || "").trim();
  const type = String(req.query.type || "").trim();
  let questions = bankQuestions();
  if (category) questions = questions.filter((question) => question.category === category);
  if (tag) questions = questions.filter((question) => (question.tags || []).includes(tag));
  if (type) questions = questions.filter((question) => (question.questionType || (correctIndexesFor(question).length > 1 ? "multiple" : "single")) === type);
  res.json({ questions, report: examReport() });
});

app.get("/api/exam-questions/export", requireAuth, (_req, res) => {
  res.json({ questions: bankQuestions() });
});

app.post("/api/exam-questions", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const body = examQuestionSchema.parse(req.body);
  let question: ExamQuestion;
  try {
    question = buildExamQuestion(body);
  } catch (error) {
    res.status(400).json({ message: "正确答案序号超出选项数量" });
    return;
  }
  store.examQuestions.unshift(question);
  await store.persist();
  res.json({ question, report: examReport() });
}));

app.post("/api/exam-questions/import", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const schema = z.object({ questions: z.array(examQuestionSchema).min(1).max(500) });
  const body = schema.parse(req.body);
  const imported: ExamQuestion[] = [];
  for (const [index, item] of body.questions.entries()) {
    try {
      imported.push(buildExamQuestion(item, index));
    } catch (error) {
      res.status(400).json({ message: `第 ${index + 1} 行正确答案序号超出选项数量` });
      return;
    }
  }
  store.examQuestions.unshift(...imported);
  await store.persist();
  res.json({ importedCount: imported.length, questions: imported, report: examReport() });
}));

app.patch("/api/exam-questions/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.examQuestions.findIndex((question) => question.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ message: "题目不存在" });
    return;
  }
  const body = examQuestionSchema.parse(req.body);
  let question: ExamQuestion;
  try {
    question = { ...buildExamQuestion(body), id: store.examQuestions[index].id, examId: store.examQuestions[index].examId || "bank" };
  } catch (error) {
    res.status(400).json({ message: "正确答案序号超出选项数量" });
    return;
  }
  store.examQuestions[index] = question;
  store.exams.forEach(refreshExamStats);
  await store.persist();
  res.json({ question, report: examReport() });
}));

app.delete("/api/exam-questions/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.examQuestions.findIndex((question) => question.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ message: "题目不存在" });
    return;
  }
  const [question] = store.examQuestions.splice(index, 1);
  store.examQuestionLinks = store.examQuestionLinks.filter((link) => link.questionId !== question.id);
  store.exams.forEach(refreshExamStats);
  await store.persist();
  res.json({ question, report: examReport() });
}));

app.get("/api/exams", requireAuth, (_req, res) => {
  const { exams } = getStore();
  res.json({ exams: exams.map(examWithRuntimeStats), report: examReport() });
});

app.get("/api/exams/:id/detail", requireAuth, (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const questions = examQuestionsFor(exam.id);
  const attempts = store.examAttempts.filter((item) => item.examId === exam.id);
  const latestAttempt = attempts.find((item) => item.userId === req.user!.id) || null;
  res.json({ exam: examWithRuntimeStats(exam), questions, latestAttempt, report: examReport() });
});

app.post("/api/exams", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const schema = z.object({
    title: z.string().min(1),
    category: z.string().min(1),
    questionIds: z.array(z.string()).min(1, "请至少选择 1 道题目"),
    durationMinutes: z.number().int().positive().default(20),
    passScore: z.number().int().min(1).max(100).default(80),
    targetRole: z.enum(["all", "sales", "manager"]).default("sales")
  });
  const body = schema.parse(req.body);
  const uniqueQuestionIds = [...new Set(body.questionIds)];
  const selectedQuestions = uniqueQuestionIds.map((id) => store.examQuestions.find((question) => question.id === id));
  if (selectedQuestions.some((question) => !question)) {
    res.status(400).json({ message: "包含不存在的题目，请刷新题库后重试" });
    return;
  }
  const now = new Date().toISOString();
  const exam: Exam = {
    id: `e_${Date.now()}`,
    title: body.title,
    category: body.category,
    status: "scheduled",
    passRate: 0,
    questionCount: uniqueQuestionIds.length,
    durationMinutes: body.durationMinutes,
    passScore: body.passScore,
    targetRole: body.targetRole,
    updatedAt: now
  };
  store.exams.unshift(exam);
  store.examQuestionLinks.unshift(...uniqueQuestionIds.map((questionId, index) => ({ examId: exam.id, questionId, sortOrder: index + 1 })));
  refreshExamStats(exam);
  await store.persist();
  res.json({ exam: examWithRuntimeStats(exam), questions: examQuestionsFor(exam.id), report: examReport() });
}));

app.post("/api/exams/:id/questions", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const body = examQuestionSchema.parse({ ...req.body, category: req.body?.category || exam.category });
  let question: ExamQuestion;
  try {
    question = buildExamQuestion(body);
  } catch (error) {
    res.status(400).json({ message: "正确答案序号超出选项数量" });
    return;
  }
  store.examQuestions.unshift(question);
  store.examQuestionLinks.push({ examId: exam.id, questionId: question.id, sortOrder: examQuestionsFor(exam.id).length + 1 });
  refreshExamStats(exam);
  await store.persist();
  res.json({ question, exam: examWithRuntimeStats(exam), report: examReport() });
}));

app.post("/api/exams/:id/questions/import", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const schema = z.object({ questions: z.array(examQuestionSchema).min(1).max(300) });
  const body = schema.parse(req.body);
  const imported: ExamQuestion[] = [];
  for (const [index, item] of body.questions.entries()) {
    try {
      imported.push(buildExamQuestion({ ...item, category: item.category || exam.category }, index));
    } catch (error) {
      res.status(400).json({ message: `第 ${index + 1} 行正确答案序号超出选项数量` });
      return;
    }
  }
  store.examQuestions.unshift(...imported);
  store.examQuestionLinks.push(...imported.map((question, index) => ({ examId: exam.id, questionId: question.id, sortOrder: examQuestionsFor(exam.id).length + index + 1 })));
  refreshExamStats(exam);
  await store.persist();
  res.json({ importedCount: imported.length, questions: imported, exam: examWithRuntimeStats(exam), report: examReport() });
}));

app.patch("/api/exams/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  if (!examQuestionsFor(exam.id).length) {
    res.status(400).json({ message: "请先勾选至少 1 道题目组卷" });
    return;
  }
  exam.status = "published";
  refreshExamStats(exam);
  await store.persist();
  res.json({ exam: examWithRuntimeStats(exam), report: examReport() });
}));

app.post("/api/exams/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const schema = z.object({ ids: z.array(z.string()).min(1).max(100) });
  const body = schema.parse(req.body);
  const ids = [...new Set(body.ids)];
  const deleted = store.exams.filter((exam) => ids.includes(exam.id));
  if (!deleted.length) {
    res.status(404).json({ message: "未找到可删除的考试" });
    return;
  }
  const deletedIds = new Set(deleted.map((exam) => exam.id));
  store.exams = store.exams.filter((exam) => !deletedIds.has(exam.id));
  store.examQuestionLinks = store.examQuestionLinks.filter((link) => !deletedIds.has(link.examId));
  store.examAttempts = store.examAttempts.filter((attempt) => !deletedIds.has(attempt.examId));
  store.exams.forEach(refreshExamStats);
  await store.persist();
  res.json({ deleted, exams: store.exams.map(examWithRuntimeStats), report: examReport() });
}));

app.delete("/api/exams/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.exams.findIndex((item) => item.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const [exam] = store.exams.splice(index, 1);
  store.examQuestionLinks = store.examQuestionLinks.filter((link) => link.examId !== exam.id);
  store.examAttempts = store.examAttempts.filter((attempt) => attempt.examId !== exam.id);
  store.exams.forEach(refreshExamStats);
  await store.persist();
  res.json({ exam, exams: store.exams.map(examWithRuntimeStats), report: examReport() });
}));

app.post("/api/exams/:id/submit", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const schema = z.object({
    answers: z.record(z.string(), z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])).optional(),
    score: z.number().min(0).max(100).optional()
  });
  const body = schema.parse(req.body);
  const questions = examQuestionsFor(exam.id);
  if (!questions.length) {
    res.status(400).json({ message: "当前考试暂无题目" });
    return;
  }
  const answers = body.answers || {};
  const correctCount = questions.filter((question) => {
    const rawAnswer = answers[question.id];
    const selectedIndexes = Array.isArray(rawAnswer) ? rawAnswer : rawAnswer == null ? [] : [rawAnswer];
    return indexesEqual(selectedIndexes, correctIndexesFor(question));
  }).length;
  const score = body.score == null ? Math.round((correctCount / questions.length) * 100) : Math.round(body.score);
  const attempt: ExamAttempt = {
    id: `attempt_${exam.id}_${req.user!.id}_${Date.now()}`,
    examId: exam.id,
    userId: req.user!.id,
    score,
    passed: score >= (exam.passScore || 80),
    answers,
    correctCount: body.score == null ? correctCount : Math.round((score / 100) * questions.length),
    totalQuestions: questions.length,
    submittedAt: new Date().toISOString()
  };
  store.examAttempts.unshift(attempt);
  refreshExamStats(exam);
  await store.persist();
  res.json({ attempt, exam: examWithRuntimeStats(exam), questions, report: examReport() });
}));

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

app.get("/api/tools/website-opportunities", requireAuth, (req, res) => {
  const { websiteOpportunities } = getStore();
  const scoped = websiteOpportunities.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
  res.json({ opportunities: scoped });
});

app.get("/api/tools/ai-config", requireAuth, (req, res) => {
  const config = getAiConfig(req.user!);
  res.json({ config: config ? publicAiConfig(config) : null });
});

app.post("/api/tools/ai-config", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).default("官网商机解析模型"),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKey: z.string().optional().default(""),
    enabled: z.boolean().default(false)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const existing = getAiConfig(req.user!);
  const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : existing?.apiKey || "";
  const config: AiModelConfig = {
    id: existing?.id || `ai_${req.user!.id}`,
    provider: "openai-compatible",
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/+$/, ""),
    model: body.model,
    apiKey,
    enabled: body.enabled,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, config);
  else store.aiModelConfigs.unshift(config);
  await store.persist();
  res.json({ config: publicAiConfig(config) });
}));

app.post("/api/tools/ai-config/test", requireAuth, asyncRoute(async (_req, res) => {
  const config = getAiConfig(_req.user!);
  if (!config || !config.baseUrl || !config.model) {
    res.status(400).json({ message: "请先保存模型地址和模型名称" });
    return;
  }
  if (!config.apiKey) {
    res.status(400).json({ message: "请先填写 API Key；系统不会在页面明文回显密钥" });
    return;
  }
  const ok = await testAiConfig(config);
  res.json({ ok, message: ok ? "AI 连接测试通过" : "AI 连接失败，请检查 Base URL / Key / Model" });
}));

app.post("/api/tools/website-scrape/preview", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ urls: z.array(z.string().min(3)).min(1).max(12), useAi: z.boolean().default(false) });
  const body = schema.parse(req.body);
  const store = getStore();
  const aiConfig = body.useAi ? getAiConfig(req.user!) : null;
  const parsed = await Promise.all(body.urls.map((url, index) => parseWebsiteOpportunity(url, index, req.user!, aiConfig)));
  for (const item of parsed) {
    const existing = store.websiteOpportunities.find((row) => row.ownerId === req.user!.id && row.website === item.website);
    if (existing) Object.assign(existing, item, { id: existing.id, status: existing.status, customerId: existing.customerId, dealId: existing.dealId });
    else store.websiteOpportunities.unshift(item);
  }
  await store.persist();
  res.json({ opportunities: parsed });
}));

app.post("/api/tools/website-scrape/sync-opportunities", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    opportunities: z.array(z.object({
      id: z.string().optional(),
      company: z.string().min(1),
      business: z.string().default("待维护"),
      country: z.string().default("未知"),
      website: z.string().min(3),
      contact: z.string().default("待维护"),
      contactInfo: z.string().default(""),
      description: z.string().default("")
    })).min(1)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const created: Array<{ customer: Customer; deal: Deal; opportunity: WebsiteOpportunity }> = [];
  for (const source of body.opportunities) {
    const contact = source.contact || source.contactInfo || "待维护";
    let customer = store.customers.find((item) => canSeeOwner(req.user!, item.ownerId, item.teamId) && item.company.toLowerCase() === source.company.toLowerCase());
    if (!customer) {
      customer = {
        id: `c_web_${Date.now()}_${created.length}`,
        company: source.company,
        country: source.country || "未知",
        contact,
        ownerId: req.user!.id,
        teamId: req.user!.teamId,
        stage: "询盘",
        amount: 0,
        health: 68,
        nextReminder: "官网商机待核实",
        wecomBound: false
      };
      store.customers.unshift(customer);
    }
    const deal: Deal = {
      id: `d_web_${Date.now()}_${created.length}`,
      customerId: customer.id,
      title: `${source.company} 官网产品机会`,
      stage: "询盘",
      amount: 0,
      ownerId: customer.ownerId,
      teamId: customer.teamId,
      nextAction: source.description || `核实官网产品：${source.business || "待维护"}，补充联系人并发起首次触达`
    };
    store.deals.unshift(deal);
    const opportunity: WebsiteOpportunity = {
      id: source.id || `web_${Date.now()}_${created.length}`,
      company: source.company,
      business: source.business || "待维护",
      country: source.country || "未知",
      website: normalizeWebsite(source.website),
      contact,
      contactInfo: source.contactInfo || "",
      description: source.description || "已同步为客户与商机，下一步核实采购负责人和产品需求。",
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      status: "synced",
      createdAt: new Date().toISOString(),
      customerId: customer.id,
      dealId: deal.id,
      parseMode: "rule"
    };
    const existing = store.websiteOpportunities.find((item) => item.id === opportunity.id || (item.ownerId === req.user!.id && item.website === opportunity.website));
    if (existing) Object.assign(existing, opportunity, { id: existing.id });
    else store.websiteOpportunities.unshift(opportunity);
    created.push({ customer, deal, opportunity: existing || opportunity });
  }
  await store.persist();
  res.json({ created });
}));

app.get("/api/dashboard/summary", requireAuth, (req, res) => {
  const store = getStore();
  const archived = archiveExpiredTodos(store.todos, new Date());
  if (archived.length) void store.persist();
  const { customers, todos, deals, reminders, knowledgeAssets, exams, wecomMessages } = store;
  const scopedCustomers = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  const scopedTodos = todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const scopedDeals = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId));
  const scopedReminders = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  const scopedKnowledge = req.user?.role === "sales" ? knowledgeAssets.filter((asset) => asset.ownerId === req.user?.id) : knowledgeAssets;
  const scopedMessages = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
  const activeTodos = scopedTodos.filter((todo) => !isHistoricalTodo(todo));
  const pendingTodos = activeTodos.filter((todo) => !todo.done);
  const overdueTodos = pendingTodos.filter((todo) => todo.priority === "high");
  const historyTodos = scopedTodos.filter(isHistoricalTodo);
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
    scope: req.user?.role === "sales" ? "仅本人业务与本人待办" : req.user?.role === "manager" ? "团队业务数据，本人待办" : "全局业务数据，本人待办",
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
      riskLabel: req.user?.role === "sales" ? "本人名下风险" : req.user?.role === "manager" ? "团队风险金额" : "全局风险金额",
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
  const scopedTodos = store.todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
  const pendingTodos = scopedTodos.filter((todo) => !todo.done && !isHistoricalTodo(todo));
  const priorityTasks = buildPriorityTasks(scopedDeals, scopedCustomers, pendingTodos).slice(0, 3);
  const created: Todo[] = [];
  for (const task of priorityTasks) {
    const exists = store.todos.some((todo) => todo.ownerId === req.user!.id && !todo.done && todo.related === task.deal.title && todo.title.includes("跟进优先级"));
    if (exists) continue;
    const todo: Todo = {
      id: `t_priority_${task.deal.id}_${Date.now()}_${created.length}`,
      title: `跟进优先级：${task.action}`,
      type: "customer",
      priority: task.score >= 80 ? "high" : task.score >= 60 ? "medium" : "normal",
      dueAt: currentMinuteText(),
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
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

function isHistoricalTodo(todo: Todo) {
  return Boolean(todo.historyAt);
}

function shouldArchiveTodo(todo: Todo, now = new Date()) {
  if (todo.historyAt) return false;
  const parsed = parseDueDate(todo.dueAt, todo.createdAt);
  if (!parsed) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return parsed < today;
}

function archiveExpiredTodos(todos: Todo[], now = new Date()) {
  const archiveTime = now.toISOString();
  const archived = todos.filter((todo) => shouldArchiveTodo(todo, now));
  archived.forEach((todo) => {
    todo.historyAt = archiveTime;
    todo.status = "pending";
    todo.pinState = "";
  });
  return archived;
}

function parseDueDate(value: string, fallbackCreatedAt?: string) {
  const text = value.trim();
  const exact = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (exact) return new Date(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]));
  const now = fallbackCreatedAt ? new Date(fallbackCreatedAt) : new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (text.includes("昨天")) return new Date(today.getTime() - 86400000);
  if (text.includes("前天")) return new Date(today.getTime() - 86400000 * 2);
  if (!text) return today;
  if (text.includes("今天") || /^(\d{1,2}):(\d{2})$/.test(text)) return today;
  if (text.includes("明天")) return new Date(today.getTime() + 86400000);
  return fallbackCreatedAt ? today : null;
}

function scheduleMidnightTodoArchive() {
  const run = async () => {
    const store = getStore();
    const archived = archiveExpiredTodos(store.todos, new Date());
    if (archived.length) {
      await store.persist();
      console.log(`GoodJob CRM archived ${archived.length} todos into history`);
    }
    schedule();
  };
  const schedule = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 3);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    windowlessSetTimeout(() => void run(), delay);
  };
  schedule();
}

function windowlessSetTimeout(callback: () => void, delay: number) {
  setTimeout(callback, delay);
}

function priorityWeight(priority: string) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function nextTodoSortOrder(todos: Todo[], ownerId: string) {
  const scoped = todos.filter((todo) => todo.ownerId === ownerId);
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

function getAiConfig(user: SessionUser) {
  return getStore().aiModelConfigs.find((item) => item.ownerId === user.id) || null;
}

function publicAiConfig(config: AiModelConfig) {
  return {
    id: config.id,
    provider: config.provider,
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(config.apiKey),
    enabled: config.enabled,
    ownerId: config.ownerId,
    teamId: config.teamId,
    updatedAt: config.updatedAt
  };
}

async function testAiConfig(config: AiModelConfig) {
  try {
    const content = await callAiModel(config, "只返回 JSON：{\"ok\":true}", 1200);
    return /ok/i.test(content);
  } catch {
    return false;
  }
}

function normalizeWebsite(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function parseWebsiteOpportunity(rawUrl: string, index: number, user: SessionUser, aiConfig?: AiModelConfig | null): Promise<WebsiteOpportunity> {
  const website = normalizeWebsite(rawUrl);
  let html = "";
  let finalUrl = website;
  let fetchNote = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    const response = await fetch(website, {
      signal: controller.signal,
      headers: { "user-agent": "GoodJobCRM/1.0 opportunity research" }
    });
    clearTimeout(timeout);
    finalUrl = response.url || website;
    html = response.ok ? await response.text() : "";
    if (!response.ok) fetchNote = `官网返回 ${response.status}，已使用域名与可公开信息生成待核实商机。`;
  } catch {
    fetchNote = "官网暂时无法直接读取，已使用域名生成待核实商机。";
  }
  const text = cleanHtml(html).slice(0, 8000);
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || "";
  const description = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) || "";
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].slice(0, 4).map((item) => cleanHtml(item[1])).filter(Boolean);
  const emails = [...new Set((html + " " + text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].slice(0, 3);
  const phones = [...new Set((text.match(/(?:\+|00)?\d[\d\s().-]{7,}\d/g) || []).map((item) => item.trim()))].slice(0, 2);
  const wechat = firstMatch(text, /(?:WeChat|微信)[:：\s]*([A-Za-z0-9_-]{5,})/i);
  const whatsapp = firstMatch(text, /(?:WhatsApp|Whatsapp|WA)[:：\s]*([+\d\s().-]{7,})/i);
  const contactInfo = [emails[0], whatsapp ? `WhatsApp ${whatsapp}` : "", wechat ? `微信 ${wechat}` : "", phones[0]].filter(Boolean).join(" / ");
  const url = new URL(finalUrl);
  const company = companyFromTitle(title, url.hostname);
  const business = inferBusiness([title, description, ...headings, text].join(" "));
  const country = inferCountry(finalUrl, text);
  const contact = inferContact(text);
  const detail = [description || headings.join("；") || `${company} 官网产品信息待复核`, fetchNote].filter(Boolean).join(" ");
  const ruleResult: WebsiteOpportunity = {
    id: `web_${Date.now()}_${index}`,
    company,
    business,
    country,
    website: finalUrl,
    contact,
    contactInfo: contactInfo || "待维护",
    description: detail.slice(0, 260),
    ownerId: user.id,
    teamId: user.teamId,
    status: "preview",
    createdAt: new Date().toISOString(),
    parseMode: "rule"
  };
  if (!aiConfig?.enabled || !aiConfig.apiKey) return ruleResult;
  try {
    const ai = await parseWebsiteWithAi(aiConfig, {
      website: finalUrl,
      title,
      description,
      headings,
      text,
      ruleResult
    });
    return {
      ...ruleResult,
      company: ai.company || ruleResult.company,
      business: ai.business || ruleResult.business,
      country: ai.country || ruleResult.country,
      contact: ai.contact || ruleResult.contact,
      contactInfo: ai.contactInfo || ruleResult.contactInfo,
      description: `${ai.description || ruleResult.description}（AI解析）`.slice(0, 320),
      parseMode: "ai"
    };
  } catch {
    return {
      ...ruleResult,
      description: `${ruleResult.description} AI解析失败，已自动回退规则解析。`.slice(0, 320),
      parseMode: "fallback"
    };
  }
}

async function parseWebsiteWithAi(config: AiModelConfig, context: {
  website: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  ruleResult: WebsiteOpportunity;
}) {
  const prompt = [
    "你是外贸CRM商机研究助手。请从官网文本中提取真实商机字段。",
    "只返回严格 JSON，不要 Markdown，不要解释。",
    "JSON字段：company,business,country,website,contact,contactInfo,description。",
    "业务字段要聚焦产品/服务；联系人和联系方式没有就写“待维护”；不要编造不存在的邮箱电话。",
    `官网：${context.website}`,
    `标题：${context.title}`,
    `Meta：${context.description}`,
    `标题组：${context.headings.join("；")}`,
    `规则初稿：${JSON.stringify(context.ruleResult)}`,
    `正文：${context.text.slice(0, 10000)}`
  ].join("\n");
  const content = await callAiModel(config, prompt, 12000);
  const parsed = extractJsonObject(content);
  return {
    company: String(parsed.company || "").trim(),
    business: String(parsed.business || "").trim(),
    country: String(parsed.country || "").trim(),
    website: String(parsed.website || context.website).trim(),
    contact: String(parsed.contact || "").trim(),
    contactInfo: String(parsed.contactInfo || parsed.contact_info || "").trim(),
    description: String(parsed.description || "").trim()
  };
}

async function callAiModel(config: AiModelConfig, prompt: string, maxInputChars = 12000) {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "你擅长把官网公开信息整理成外贸CRM商机。输出必须可被 JSON.parse 解析。" },
          { role: "user", content: prompt.slice(0, maxInputChars) }
        ],
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error(`AI request failed ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("AI empty response");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(content: string) {
  const source = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI JSON missing");
  return JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
}

function cleanHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(value: string, pattern: RegExp) {
  return cleanHtml(value.match(pattern)?.[1] || "");
}

function companyFromTitle(title: string, hostname: string) {
  const host = hostname.replace(/^www\./, "").split(".")[0];
  const fromTitle = title.split(/[-|–—]/)[0]?.trim();
  const raw = fromTitle && fromTitle.length >= 3 ? fromTitle : host;
  return raw.replace(/\b(home|official|website|products?)\b/gi, "").replace(/\s+/g, " ").trim() || host;
}

function inferBusiness(text: string) {
  const lower = text.toLowerCase();
  const dictionary = [
    ["pressure", "压力仪表 / Pressure transmitter"],
    ["flow", "流量仪表 / Flow meter"],
    ["temperature", "温度仪表 / Temperature sensor"],
    ["level", "液位仪表 / Level meter"],
    ["sensor", "工业传感器 / Industrial sensor"],
    ["instrument", "工业仪表 / Instrumentation"],
    ["meter", "仪表计量 / Metering products"],
    ["valve", "阀门与过程控制 / Valve control"]
  ];
  const matched = dictionary.filter(([keyword]) => lower.includes(keyword)).map(([, label]) => label);
  return [...new Set(matched)].slice(0, 3).join("；") || "官网产品待核实";
}

function inferCountry(url: string, text: string) {
  const lower = `${url} ${text}`.toLowerCase();
  const rules: Array<[string, string]> = [
    [".de", "德国"], [".co.uk", "英国"], [".uk", "英国"], [".fr", "法国"], [".it", "意大利"], [".es", "西班牙"],
    [".us", "美国"], [".com.au", "澳大利亚"], [".ca", "加拿大"], [".jp", "日本"], [".kr", "韩国"], [".in", "印度"],
    ["germany", "德国"], ["united kingdom", "英国"], ["usa", "美国"], ["japan", "日本"], ["india", "印度"], ["china", "中国"]
  ];
  return rules.find(([key]) => lower.includes(key))?.[1] || "未知";
}

function inferContact(text: string) {
  const match = text.match(/(?:Contact|Sales|Manager|Director)[:：\s]+([A-Z][A-Za-z\s.-]{2,40})/);
  return cleanHtml(match?.[1] || "") || "待维护";
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
  scheduleMidnightTodoArchive();
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
