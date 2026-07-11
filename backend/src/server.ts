import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { z } from "zod";
import { canManageAccounts, canManageRole, canSeeOwner, canSeePersonalData, publicUser, requireAuth, signToken } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore, setStore } from "./store.js";
import { LEAD_PROVIDERS, getProvider, providerMeta, type LeadProvider, type LeadQuery, type RawLead } from "./lead-providers.js";
import type { AiModelConfig, CommissionCalculation, CommissionItem, CommissionProduct, CommissionRule, Customer, Deal, Exam, ExamAttempt, ExamQuestion, Lead, LeadSourceConfig, LeadSourceEvent, LeadSourceType, MonthlySalesRecord, OcrJob, PlanTask, PlanTemplate, SalesRecordAudit, SessionUser, Todo, TradeDocument, WebsiteOpportunity } from "./types.js";

function loadLocalEnv() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../.env"),
    resolve(process.cwd(), ".env")
  ];
  const envPath = candidates.find((path) => existsSync(path));
  if (!envPath) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

loadLocalEnv();

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

function canManageTraining(user?: SessionUser) {
  return user?.role === "manager" || user?.role === "admin" || user?.role === "super_admin";
}

function canAccessExam(user: SessionUser, exam: Exam) {
  if (canManageTraining(user)) return true;
  if (exam.status !== "published") return false;
  return exam.targetRole === "all" || exam.targetRole === user.role;
}

function requireTrainingManager(req: Request, res: Response) {
  if (canManageTraining(req.user)) return true;
  res.status(403).json({ message: "只有主管、管理员和超级管理员可以维护题库和考试" });
  return false;
}

function userCurrentOcrId(user: SessionUser) {
  return `ocr_${user.id}`;
}

function defaultOcrFields() {
  return {
    company: "NorthStar Lighting GmbH",
    contact: "James Müller",
    title: "Purchasing Manager",
    email: "james.mueller@northstar-light.de",
    whatsapp: "+49 151 2388 9012",
    wechat: "james_light_de",
    phone: "+49 30 8842 1290",
    country: "德国",
    city: "Berlin"
  };
}

function resolveOcrJob(user: SessionUser, requestedId: string, createIfMissing = false): OcrJob | null {
  const store = getStore();
  const personalId = userCurrentOcrId(user);
  const direct = store.ocrJobs.find((job) => job.id === requestedId && canSeePersonalData(user, job.ownerId));
  if (direct) return direct;
  if (!["ocr1", "current", personalId].includes(requestedId)) return null;
  const existingPersonal = store.ocrJobs.find((job) => job.id === personalId && canSeePersonalData(user, job.ownerId));
  if (existingPersonal) return existingPersonal;
  if (!createIfMissing) return null;
  const template = store.ocrJobs.find((job) => job.id === "ocr1");
  const job: OcrJob = {
    id: personalId,
    status: template?.status || "recognized",
    confidence: template?.confidence || 94,
    fields: { ...defaultOcrFields(), ...(template?.fields || {}) },
    ownerId: user.id,
    teamId: user.teamId
  };
  store.ocrJobs.unshift(job);
  return job;
}

async function sendOutboundEmail(user: ReturnType<typeof getStore>["users"][number], payload: { to: string; subject: string; body: string }) {
  if (!user.outboundEmail || !user.smtpHost || !user.smtpUser || !user.smtpPassword) {
    throw new Error("请先在个人信息页完整配置发件邮箱、SMTP服务器、账号和授权码");
  }
  const smtpPort = Number(user.smtpPort || 465);
  const smtpSecure = user.smtpSecure ?? true;
  if (smtpPort === 587 && smtpSecure) {
    throw new Error("SMTP配置不匹配：端口 587 通常应选择 STARTTLS/普通；如果要使用 SSL/TLS，请把端口改为 465。");
  }
  if (smtpPort === 465 && !smtpSecure) {
    throw new Error("SMTP配置不匹配：端口 465 通常应选择 SSL/TLS；如果要使用 STARTTLS/普通，请把端口改为 587。");
  }
  const transport = process.env.NODE_ENV === "test"
    ? nodemailer.createTransport({ streamTransport: true, newline: "unix", buffer: true })
    : nodemailer.createTransport({
      host: user.smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: user.smtpUser,
        pass: user.smtpPassword
      }
    });
  return transport.sendMail({
    from: `"${user.emailSenderName || user.name}" <${user.outboundEmail}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.body
  });
}

function outboundEmailError(error: unknown, user: ReturnType<typeof getStore>["users"][number]) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.startsWith("请先") || message.startsWith("SMTP配置不匹配")) return message;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const response = typeof error === "object" && error && "response" in error ? String((error as { response?: unknown }).response || "") : "";
  const raw = `${message} ${response}`.trim();
  const lower = raw.toLowerCase();
  if (code === "EAUTH" || raw.includes("535") || lower.includes("invalid login") || lower.includes("authentication")) {
    return "SMTP认证失败：请确认 SMTP账号 是完整邮箱，授权码不是网页登录密码，并且邮箱后台已开启 SMTP 服务。QQ邮箱请使用“授权码/客户端专用密码”。";
  }
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "ETIMEDOUT" || lower.includes("wrong version number") || lower.includes("ssl")) {
    return `SMTP连接失败：请检查服务器、端口和加密方式。当前配置为 ${user.smtpHost}:${user.smtpPort || 465}，${user.smtpSecure ?? true ? "SSL/TLS" : "STARTTLS/普通"}。`;
  }
  if (raw.includes("550") || lower.includes("sender")) {
    return "SMTP发件人被拒绝：请确认发件邮箱、SMTP账号属于同一个邮箱账号，且服务商允许该账号外发。";
  }
  return `邮件发送失败：${message || "SMTP服务未返回明确原因"}`;
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

function examWithRuntimeStats(exam: Exam, user?: SessionUser) {
  const store = getStore();
  const questions = examQuestionsFor(exam.id);
  const attempts = store.examAttempts.filter((attempt) => attempt.examId === exam.id && (!user || canManageTraining(user) || attempt.userId === user.id));
  const passRate = attempts.length
    ? Math.round((attempts.filter((attempt) => attempt.passed).length / attempts.length) * 100)
    : canManageTraining(user) || !user ? exam.passRate : 0;
  return {
    ...exam,
    questionCount: questions.length || exam.questionCount,
    passRate
  };
}

function examReport(user?: SessionUser) {
  const store = getStore();
  const visibleExams = user ? store.exams.filter((exam) => canAccessExam(user, exam)) : store.exams;
  const visibleExamIds = new Set(visibleExams.map((exam) => exam.id));
  const attempts = store.examAttempts.filter((attempt) => visibleExamIds.has(attempt.examId) && (!user || canManageTraining(user) || attempt.userId === user.id));
  const totalAttempts = attempts.length;
  const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
  const averageScore = totalAttempts ? Math.round(attempts.reduce((sum, attempt) => sum + attempt.score, 0) / totalAttempts) : 0;
  const retakeAttempts = attempts.filter((attempt) => !attempt.passed).length;
  const questionCount = canManageTraining(user) || !user ? bankQuestions().length : visibleExams.reduce((sum, exam) => sum + examQuestionsFor(exam.id).length, 0);
  const difficultyRows = ["easy", "medium", "hard"].map((difficulty) => {
    const questions = canManageTraining(user) || !user ? bankQuestions() : visibleExams.flatMap((exam) => examQuestionsFor(exam.id));
    const count = questions.filter((question) => question.difficulty === difficulty).length;
    return {
      difficulty,
      label: difficulty === "easy" ? "基础题" : difficulty === "hard" ? "高阶题" : "应用题",
      count,
      ratio: questionCount ? Math.round((count / questionCount) * 100) : 0
    };
  });
  const categoryRows = visibleExams.map((exam) => {
    const examAttempts = attempts.filter((attempt) => attempt.examId === exam.id);
    const participants = new Set(examAttempts.map((attempt) => attempt.userId)).size;
    const passRate = examAttempts.length ? Math.round((examAttempts.filter((attempt) => attempt.passed).length / examAttempts.length) * 100) : canManageTraining(user) || !user ? exam.passRate : 0;
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

app.get("/api/profile", requireAuth, (req, res) => {
  const user = getStore().users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  res.json({ user: accountUser(user) });
});

app.patch("/api/profile/email-binding", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    outboundEmail: z.string().max(180).default(""),
    emailSenderName: z.string().max(80).default(""),
    emailSignature: z.string().max(800).default(""),
    smtpHost: z.string().max(180).default(""),
    smtpPort: z.number().int().min(1).max(65535).default(465),
    smtpSecure: z.boolean().default(true),
    smtpUser: z.string().max(180).default(""),
    smtpPassword: z.string().max(300).optional().default(""),
    clearSmtpPassword: z.boolean().optional().default(false)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  user.outboundEmail = body.outboundEmail;
  user.emailSenderName = body.emailSenderName;
  user.emailSignature = body.emailSignature;
  user.smtpHost = body.smtpHost;
  user.smtpPort = body.smtpPort;
  user.smtpSecure = body.smtpSecure;
  user.smtpUser = body.smtpUser;
  if (body.clearSmtpPassword) {
    user.smtpPassword = "";
  } else if (body.smtpPassword) {
    user.smtpPassword = body.smtpPassword;
  }
  await store.persist();
  const sessionUser = publicUser(user);
  res.json({ user: accountUser(user), token: signToken(sessionUser) });
}));

app.post("/api/profile/test-email", requireAuth, asyncRoute(async (_req, res) => {
  const schema = z.object({
    to: z.string().email().optional().or(z.literal(""))
  });
  const body = schema.parse(_req.body || {});
  const store = getStore();
  const user = store.users.find((item) => item.id === _req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (!user.outboundEmail) {
    res.status(400).json({ message: "请先保存发件邮箱" });
    return;
  }
  const testTo = body.to?.trim() || user.outboundEmail;
  try {
    const info = await sendOutboundEmail(user, {
      to: testTo,
      subject: "GoodJob CRM SMTP 测试邮件",
      body: `这是一封来自 GoodJob CRM 的 SMTP 测试邮件。\n\n账号：${user.email}\n时间：${new Date().toISOString()}`
    });
    res.json({ ok: true, to: testTo, messageId: info.messageId, simulated: process.env.NODE_ENV === "test" });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
  }
}));

app.post("/api/profile/send-development-email", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    to: z.string().email(),
    company: z.string().min(1).max(120),
    subject: z.string().min(1).max(160),
    body: z.string().min(10).max(3000)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, { to: body.to, subject: body.subject, body: body.body });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = body.to;
  user.lastDevelopmentEmailSubject = body.subject;
  await store.persist();
  res.json({
    sent: {
      id: `mail_${Date.now()}`,
      status: "sent",
      simulated: process.env.NODE_ENV === "test",
      messageId: mailInfo.messageId,
      from: user.outboundEmail,
      senderName: user.emailSenderName || user.name,
      to: body.to,
      company: body.company,
      subject: body.subject,
      body: body.body,
      sentAt
    },
    user: accountUser(user)
  });
}));

app.post("/api/prospect-list/:id/send-development-email", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(160),
    body: z.string().min(10).max(3000)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  const opportunity = store.websiteOpportunities.find((item) => item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId));
  if (!opportunity) {
    res.status(404).json({ message: "搜客线索不存在或无权访问" });
    return;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, { to: body.to, subject: body.subject, body: body.body });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = body.to;
  user.lastDevelopmentEmailSubject = body.subject;
  opportunity.lastDevelopmentEmailAt = sentAt;
  opportunity.lastDevelopmentEmailTo = body.to;
  opportunity.lastDevelopmentEmailSubject = body.subject;
  await store.persist();
  res.json({
    sent: {
      id: `mail_${Date.now()}`,
      status: "sent",
      simulated: process.env.NODE_ENV === "test",
      messageId: mailInfo.messageId,
      from: user.outboundEmail,
      senderName: user.emailSenderName || user.name,
      to: body.to,
      company: opportunity.company,
      subject: body.subject,
      body: body.body,
      sentAt
    },
    opportunity,
    user: accountUser(user)
  });
}));

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
  res.json({ customers: scoped.map(customerWithPipeline) });
});

app.post("/api/customers", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1),
    country: z.string().min(1).default("未知"),
    contact: z.string().min(1).default("待维护"),
    stage: z.string().min(1).default("询盘"),
    amount: z.number().int().nonnegative().default(0),
    billingName: z.string().optional().default(""),
    billingAddress: z.string().optional().default(""),
    documentContact: z.string().optional().default(""),
    defaultPortDischarge: z.string().optional().default(""),
    defaultIncoterm: z.string().optional().default("FOB Tianjin"),
    defaultPaymentTerm: z.string().optional().default("30% T/T deposit, 70% before shipment")
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
  res.json({ customer: customerWithPipeline(customer) });
}));

app.patch("/api/customers/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    company: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    contact: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    amount: z.number().int().nonnegative().optional(),
    nextReminder: z.string().min(1).optional(),
    wecomBound: z.boolean().optional(),
    billingName: z.string().optional(),
    billingAddress: z.string().optional(),
    documentContact: z.string().optional(),
    defaultPortDischarge: z.string().optional(),
    defaultIncoterm: z.string().optional(),
    defaultPaymentTerm: z.string().optional()
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
  res.json({ customer: customerWithPipeline(customer) });
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
  store.todos = store.todos.filter((todo) => {
    const currentUserTodo = canSeePersonalData(req.user!, todo.ownerId);
    const relatedToDeletedCustomer = deletedNames.some((name) => todo.related.includes(name) || todo.title.includes(name));
    return !currentUserTodo || !relatedToDeletedCustomer;
  });
  await store.persist();
  const customers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  res.json({ deleted, customers });
}));

// ---------------------------------------------------------------------------
// Leads (线索管理) — unified intake, follow-up and qualified conversion
// ---------------------------------------------------------------------------
const leadSourceTypes = ["outbound", "inbound", "offline", "referral", "import"] as const;
const leadWritableSchema = z.object({
  company: z.string().min(1),
  contact: z.string().optional().default(""),
  country: z.string().optional().default(""),
  email: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  wechat: z.string().optional().default(""),
  source: z.string().optional().default("手动录入"),
  intent: z.enum(["高", "中", "低"]).optional().default("中"),
  stage: z.string().optional().default("新线索"),
  estimatedAmount: z.number().nonnegative().optional().default(0),
  nextFollowAt: z.string().optional().default(""),
  remark: z.string().optional().default(""),
  sourceType: z.enum(leadSourceTypes).optional().default("outbound"),
  sourceChannel: z.string().max(80).optional().default("manual"),
  sourceCampaign: z.string().max(120).optional().default(""),
  externalId: z.string().max(180).optional().default(""),
  sourceUrl: z.string().max(500).optional().default("")
});

type LeadIntake = z.infer<typeof leadWritableSchema> & {
  occurredAt?: string;
  rawPayload?: unknown;
};

function createLeadFromSource(user: SessionUser, input: LeadIntake) {
  const store = getStore();
  const sourceChannel = input.sourceChannel.trim() || "manual";
  const externalId = input.externalId.trim();
  if (externalId) {
    const priorEvent = store.leadSourceEvents.find((event) =>
      event.teamId === user.teamId && event.channel === sourceChannel && event.externalId === externalId
    );
    const priorLead = priorEvent ? store.leads.find((lead) => lead.id === priorEvent.leadId) : undefined;
    if (priorEvent && priorLead) return { lead: priorLead, sourceEvent: priorEvent, duplicate: true };
  }

  const receivedAt = new Date().toISOString();
  const uniquePart = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lead: Lead = {
    id: `lead_${uniquePart}`,
    company: input.company,
    contact: input.contact,
    country: input.country,
    email: input.email,
    phone: input.phone,
    wechat: input.wechat,
    source: input.source,
    sourceType: input.sourceType,
    sourceChannel,
    sourceCampaign: input.sourceCampaign,
    externalId,
    sourceUrl: input.sourceUrl,
    intent: input.intent,
    stage: input.stage,
    status: "new",
    ownerId: user.id,
    teamId: user.teamId,
    estimatedAmount: input.estimatedAmount,
    nextFollowAt: input.nextFollowAt,
    lastActivityAt: "刚刚",
    remark: input.remark,
    convertedCustomerId: "",
    convertedDealId: "",
    createdAt: receivedAt
  };
  const sourceEvent: LeadSourceEvent = {
    id: `lse_${uniquePart}`,
    leadId: lead.id,
    sourceType: input.sourceType,
    channel: sourceChannel,
    campaign: input.sourceCampaign,
    externalId: externalId || lead.id,
    sourceUrl: input.sourceUrl,
    occurredAt: input.occurredAt || receivedAt,
    receivedAt,
    rawPayload: JSON.stringify(input.rawPayload ?? input),
    ownerId: user.id,
    teamId: user.teamId
  };
  store.leads.unshift(lead);
  store.leadSourceEvents.unshift(sourceEvent);
  store.leadActivities.unshift({
    id: `la_${uniquePart}`,
    leadId: lead.id,
    type: "system",
    content: `线索创建（来源：${lead.source} / ${sourceChannel}）`,
    operatorId: user.id,
    nextFollowAt: lead.nextFollowAt,
    createdAt: receivedAt
  });
  return { lead, sourceEvent, duplicate: false };
}

function normalizedMatchText(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function emailDomain(value: string) {
  return value.trim().toLowerCase().split("@")[1] || "";
}

function findCustomerMatches(user: SessionUser, lead: Lead) {
  const store = getStore();
  const leadCompany = normalizedMatchText(lead.company);
  const leadEmail = lead.email.trim().toLowerCase();
  const leadDomain = emailDomain(leadEmail);
  return store.customers
    .filter((customer) => canSeeOwner(user, customer.ownerId, customer.teamId))
    .map((customer) => {
      let score = 0;
      const reasons: string[] = [];
      const documentContact = customer.documentContact.toLowerCase();
      if (leadCompany && normalizedMatchText(customer.company) === leadCompany) {
        score += 80;
        reasons.push("公司名称一致");
      }
      if (leadEmail && documentContact.includes(leadEmail)) {
        score += 100;
        reasons.push("联系邮箱一致");
      } else if (leadDomain && documentContact.includes(`@${leadDomain}`)) {
        score += 50;
        reasons.push("邮箱域名一致");
      }
      const activeDeals = store.deals.filter((deal) => deal.customerId === customer.id && !deal.archivedAt && deal.stage !== "丢单");
      return { customer, score, reasons, activeDealCount: activeDeals.length };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score);
}

const pipelineStageRank: Record<string, number> = { "询盘": 1, "已联系": 2, "已报价": 3, "样品": 4, "谈判": 5, "成交": 6 };

function customerWithPipeline(customer: Customer) {
  const activeDeals = getStore().deals.filter((deal) => deal.customerId === customer.id && !deal.archivedAt && deal.stage !== "丢单");
  const pipelineStage = activeDeals.reduce((best, deal) =>
    (pipelineStageRank[deal.stage] || 0) > (pipelineStageRank[best] || 0) ? deal.stage : best, ""
  );
  return {
    ...customer,
    pipelineStage: pipelineStage || "暂无活跃商机",
    pipelineAmount: activeDeals.reduce((sum, deal) => sum + deal.amount, 0),
    activeDealCount: activeDeals.length
  };
}

app.get("/api/leads", requireAuth, (req, res) => {
  const { leads } = getStore();
  const trash = req.query.trash === "true";
  const scoped = leads.filter((lead) => canSeeOwner(req.user!, lead.ownerId, lead.teamId) && (trash ? Boolean(lead.deletedAt) : !lead.deletedAt));
  res.json({ leads: scoped });
});

app.get("/api/leads/:id", requireAuth, (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const activities = store.leadActivities
    .filter((activity) => activity.leadId === lead.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ lead, activities });
});

app.post("/api/leads", requireAuth, asyncRoute(async (req, res) => {
  const body = leadWritableSchema.parse(req.body);
  const store = getStore();
  const { lead, sourceEvent, duplicate } = createLeadFromSource(req.user!, body);
  await store.persist();
  res.json({ lead, sourceEvent, duplicate });
}));

app.post("/api/leads/ingest", requireAuth, asyncRoute(async (req, res) => {
  const schema = leadWritableSchema.extend({
    occurredAt: z.string().datetime().optional(),
    rawPayload: z.unknown().optional()
  });
  const body = schema.parse(req.body);
  const result = createLeadFromSource(req.user!, body);
  await getStore().persist();
  res.status(result.duplicate ? 200 : 201).json(result);
}));

app.patch("/api/leads/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = leadWritableSchema.partial().extend({
    status: z.enum(["new", "following", "converted", "invalid"]).optional()
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const previousStage = lead.stage;
  Object.assign(lead, body);
  lead.lastActivityAt = "刚刚";
  if (body.stage && body.stage !== previousStage) {
    store.leadActivities.unshift({
      id: `la_${Date.now()}`,
      leadId: lead.id,
      type: "stage",
      content: `阶段变更：${previousStage} → ${body.stage}`,
      operatorId: req.user!.id,
      nextFollowAt: "",
      createdAt: new Date().toISOString()
    });
  }
  await store.persist();
  res.json({ lead });
}));

app.delete("/api/leads/:id", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ reason: z.string().optional().default("") });
  const body = schema.parse(req.body || {});
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const now = new Date().toISOString();
  lead.deletedAt = now;
  lead.deletedReason = body.reason || "暂时无效或不适合继续跟进";
  lead.status = "invalid";
  lead.lastActivityAt = "刚刚";
  store.leadActivities.unshift({
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "system",
    content: `移入垃圾箱：${lead.deletedReason}`,
    operatorId: req.user!.id,
    nextFollowAt: "",
    createdAt: now
  });
  await store.persist();
  res.json({ lead });
}));

app.post("/api/leads/:id/restore", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const now = new Date().toISOString();
  lead.deletedAt = "";
  lead.deletedReason = "";
  lead.status = lead.convertedCustomerId ? "converted" : "following";
  lead.lastActivityAt = "刚刚";
  store.leadActivities.unshift({
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "system",
    content: "从垃圾箱恢复线索",
    operatorId: req.user!.id,
    nextFollowAt: "",
    createdAt: now
  });
  await store.persist();
  res.json({ lead });
}));

app.delete("/api/leads/:id/permanent", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  store.leads = store.leads.filter((item) => item.id !== lead.id);
  store.leadActivities = store.leadActivities.filter((item) => item.leadId !== lead.id);
  await store.persist();
  res.json({ ok: true, id: lead.id });
}));

app.post("/api/leads/:id/activities", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    type: z.enum(["call", "wechat", "whatsapp", "linkedin", "email", "meeting", "note"]).default("note"),
    content: z.string().min(1),
    nextFollowAt: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId)) {
    res.status(404).json({ message: "线索不存在或无权访问" });
    return;
  }
  const now = new Date().toISOString();
  const activity = {
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: body.type,
    content: body.content,
    operatorId: req.user!.id,
    nextFollowAt: body.nextFollowAt,
    createdAt: now
  };
  store.leadActivities.unshift(activity);
  lead.lastActivityAt = "刚刚";
  if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
  if (lead.status === "new") lead.status = "following";
  await store.persist();
  res.json({ activity, lead });
}));

app.post("/api/leads/:id/social-touch", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    channel: z.enum(["call", "wechat", "whatsapp", "linkedin"]),
    message: z.string().min(1).max(1200),
    nextFollowAt: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  const channelText: Record<typeof body.channel, string> = { call: "电话", wechat: "微信", whatsapp: "WhatsApp", linkedin: "LinkedIn" };
  const now = new Date().toISOString();
  const activity = {
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: body.channel,
    content: `${channelText[body.channel]}触达：${body.message}`,
    operatorId: req.user!.id,
    nextFollowAt: body.nextFollowAt,
    createdAt: now
  };
  store.leadActivities.unshift(activity);
  lead.lastActivityAt = "刚刚";
  if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
  if (lead.status === "new") lead.status = "following";
  await store.persist();
  res.json({ activity, lead });
}));

app.post("/api/leads/:id/send-email", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(160),
    body: z.string().min(10).max(3000),
    nextFollowAt: z.string().optional().default("")
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const user = store.users.find((item) => item.id === req.user!.id);
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!user) {
    res.status(404).json({ message: "账号不存在" });
    return;
  }
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  let mailInfo: Awaited<ReturnType<typeof sendOutboundEmail>>;
  try {
    mailInfo = await sendOutboundEmail(user, { to: body.to, subject: body.subject, body: body.body });
  } catch (error) {
    res.status(400).json({ message: outboundEmailError(error, user) });
    return;
  }
  const sentAt = new Date().toISOString();
  user.lastDevelopmentEmailAt = sentAt;
  user.lastDevelopmentEmailTo = body.to;
  user.lastDevelopmentEmailSubject = body.subject;
  const activity = {
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "email" as const,
    content: `邮件发送：${body.subject}`,
    operatorId: req.user!.id,
    nextFollowAt: body.nextFollowAt,
    createdAt: sentAt
  };
  store.leadActivities.unshift(activity);
  lead.lastActivityAt = "刚刚";
  if (body.nextFollowAt) lead.nextFollowAt = body.nextFollowAt;
  if (lead.status === "new") lead.status = "following";
  await store.persist();
  res.json({
    sent: {
      id: `mail_${Date.now()}`,
      status: "sent",
      simulated: process.env.NODE_ENV === "test",
      messageId: mailInfo.messageId,
      from: user.outboundEmail,
      senderName: user.emailSenderName || user.name,
      to: body.to,
      company: lead.company,
      subject: body.subject,
      sentAt
    },
    activity,
    lead,
    user: accountUser(user)
  });
}));

app.get("/api/leads/:id/conversion-preview", requireAuth, (req, res) => {
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  res.json({ lead, customerMatches: findCustomerMatches(req.user!, lead) });
});

app.post("/api/leads/:id/convert", requireAuth, asyncRoute(async (req, res) => {
  const conversionSchema = z.object({
    customerMode: z.enum(["create", "existing"]).optional().default("create"),
    customerId: z.string().optional().default(""),
    createDeal: z.boolean().optional().default(false),
    deal: z.object({
      title: z.string().max(200).optional().default(""),
      product: z.string().max(200).optional().default(""),
      amount: z.coerce.number().nonnegative().optional(),
      quantity: z.coerce.number().int().nonnegative().optional().default(0),
      unitPrice: z.coerce.number().nonnegative().optional().default(0),
      nextAction: z.string().max(200).optional().default("")
    }).optional().default({})
  });
  const body = conversionSchema.parse(req.body || {});
  const store = getStore();
  const lead = store.leads.find((item) => item.id === req.params.id);
  if (!lead || !canSeeOwner(req.user!, lead.ownerId, lead.teamId) || lead.deletedAt) {
    res.status(404).json({ message: "线索不存在、已删除或无权访问" });
    return;
  }
  if (lead.convertedCustomerId) {
    const customer = store.customers.find((item) => item.id === lead.convertedCustomerId);
    const deal = lead.convertedDealId ? store.deals.find((item) => item.id === lead.convertedDealId) : undefined;
    res.json({ lead, customer: customer ? customerWithPipeline(customer) : null, deal, duplicate: true });
    return;
  }
  const now = new Date().toISOString();
  let customer: Customer | undefined;
  if (body.customerMode === "existing") {
    customer = store.customers.find((item) => item.id === body.customerId);
    if (!customer || !canSeeOwner(req.user!, customer.ownerId, customer.teamId)) {
      res.status(404).json({ message: "要关联的客户不存在或无权访问" });
      return;
    }
  } else {
    customer = {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      company: lead.company,
      country: lead.country || "未知",
      contact: lead.contact || "待维护",
      ownerId: lead.ownerId,
      teamId: lead.teamId,
      stage: "询盘",
      amount: 0,
      health: 72,
      nextReminder: lead.nextFollowAt || "明天 10:00",
      wecomBound: false,
      billingName: lead.company,
      billingAddress: "",
      documentContact: lead.email ? `${lead.contact || "待维护"} / ${lead.email}` : lead.contact || "",
      defaultPortDischarge: "",
      defaultIncoterm: "FOB Tianjin",
      defaultPaymentTerm: "30% T/T deposit, 70% before shipment"
    };
    store.customers.unshift(customer);
  }

  let deal: Deal | undefined;
  if (body.createDeal) {
    deal = {
      id: `d_lead_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      customerId: customer.id,
      title: body.deal.title.trim() || `${lead.company} 采购需求`,
      stage: "询盘",
      product: body.deal.product.trim(),
      quantity: body.deal.quantity,
      unitPrice: body.deal.unitPrice,
      amount: typeof body.deal.amount === "number" ? body.deal.amount : (lead.estimatedAmount || body.deal.quantity * body.deal.unitPrice),
      ownerId: customer.ownerId,
      teamId: customer.teamId,
      nextAction: body.deal.nextAction.trim() || lead.nextFollowAt || "确认产品、数量与报价要求"
    };
    store.deals.unshift(deal);
  }
  lead.status = "converted";
  lead.stage = "已转化";
  lead.convertedCustomerId = customer.id;
  lead.convertedDealId = deal?.id || "";
  lead.lastActivityAt = "刚刚";
  store.leadActivities.unshift({
    id: `la_${Date.now()}`,
    leadId: lead.id,
    type: "system",
    content: deal ? `确认并入库：关联客户 ${customer.company}，创建商机 ${deal.title}` : `确认并入库：关联客户 ${customer.company}`,
    operatorId: req.user!.id,
    nextFollowAt: "",
    createdAt: now
  });
  await store.persist();
  res.json({ lead, customer: customerWithPipeline(customer), deal, duplicate: false });
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

const planTaskSchema = z.object({
  title: z.string().min(1),
  phase: z.string().min(1).default("计划任务"),
  category: z.string().min(1).default("客户开发"),
  priority: z.enum(["high", "medium", "normal"]).default("normal"),
  status: z.enum(["planned", "active", "done"]).default("planned"),
  dueAt: z.string().default(""),
  target: z.string().default(""),
  description: z.string().default("")
});

function sortPlanTasks(tasks: PlanTask[]) {
  const statusWeight: Record<PlanTask["status"], number> = { active: 0, planned: 1, done: 2 };
  const priorityWeight: Record<PlanTask["priority"], number> = { high: 0, medium: 1, normal: 2 };
  return [...tasks].sort((left, right) => {
    return statusWeight[left.status] - statusWeight[right.status]
      || priorityWeight[left.priority] - priorityWeight[right.priority]
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
}

const defaultPlanTemplateDrafts: Array<Omit<PlanTemplate, "id" | "ownerId" | "teamId" | "updatedAt">> = [
  { section: "knowledge", title: "产品分类地图", summary: "压力、温度、流量、液位、分析仪表、记录仪；每类写 3 个典型型号和应用场景。", output: "输出物：1页分类卡", badge: "必会", badgeTone: "green", phase: "前置知识", category: "产品知识", priority: "high", target: "完成6类仪表的分类卡和典型应用说明", description: "整理压力、温度、流量、液位、分析仪表、记录仪的型号、应用行业、常见客户问题。", sortOrder: 10 },
  { section: "knowledge", title: "关键参数追问表", summary: "量程、精度、介质、温压、连接、输出信号、供电、防护、材质；必须能向客户追问。", output: "输出物：参数确认模板", badge: "必会", badgeTone: "green", phase: "前置知识", category: "参数训练", priority: "high", target: "形成可复制的英文参数确认表", description: "把量程、精度、介质、温度压力、接口、输出信号、供电和材质整理成询盘追问模板。", sortOrder: 20 },
  { section: "knowledge", title: "证书与资料包", summary: "CE、RoHS、EMC、ATEX/IECEx、防爆、SIL、校准证书、ISO、材质报告，按产品归档。", output: "输出物：资料索引", badge: "资料化", badgeTone: "amber", phase: "前置知识", category: "资料维护", priority: "medium", target: "完成认证资料索引并标注适用产品", description: "按产品类型整理证书、测试报告、校准文件和对外解释口径，避免客户索要资料时临时翻找。", sortOrder: 30 },
  { section: "knowledge", title: "行业应用场景", summary: "水处理、油气、化工、食品制药、HVAC、电力、船舶、环保设备、OEM 机械。", output: "输出物：行业话术", badge: "场景", badgeTone: "", phase: "前置知识", category: "场景训练", priority: "medium", target: "每个行业写出1条切入话术和1个典型应用", description: "围绕水处理、油气、化工、食品制药、HVAC、电力、船舶和OEM机械整理客户痛点。", sortOrder: 40 },
  { section: "knowledge", title: "竞品替代口径", summary: "WIKA、Endress+Hauser、Yokogawa、Emerson、KROHNE、Ashcroft、Dwyer 的替代切入点。", output: "输出物：竞品对照表", badge: "谈判", badgeTone: "red", phase: "前置知识", category: "竞品研究", priority: "medium", target: "完成至少5个竞品品牌的替代切入点", description: "整理竞品主打产品、客户关注点、我方可替代卖点和风险边界。", sortOrder: 50 },
  { section: "persona", title: "工业自动化经销商", summary: "要稳定供货、利润空间、资料齐全和快速响应。", output: "关键词：instrument distributor / automation supplier / country\n首触达：目录、代理优势、证书包、热销型号", badge: "高匹配", badgeTone: "green", phase: "客户画像", category: "客户开发", priority: "high", target: "筛选30家高匹配经销商并完成首触达", description: "使用instrument distributor、automation supplier等关键词，按国家筛选官网、联系人、产品线和代理品牌。", sortOrder: 110 },
  { section: "persona", title: "系统集成商", summary: "关注项目参数匹配、交期、现场适配和技术支持。", output: "关键词：process automation integrator / control system integrator\n首触达：问应用场景、项目清单、参数范围", badge: "项目型", badgeTone: "aqua", phase: "客户画像", category: "客户开发", priority: "high", target: "筛选20家系统集成商并确认项目应用场景", description: "围绕process automation integrator等关键词查找项目型客户，首封邮件重点询问介质、量程、接口和证书需求。", sortOrder: 120 },
  { section: "persona", title: "OEM 设备厂", summary: "关注批量一致性、定制接口、长期价格和替代型号。", output: "关键词：machine manufacturer sensor / OEM instrument supplier\n首触达：发参数确认表、询问年用量和安装空间", badge: "批量型", badgeTone: "amber", phase: "客户画像", category: "客户开发", priority: "medium", target: "建立20家OEM设备厂名单并完成参数确认", description: "按设备类型筛选OEM客户，重点记录年用量、现用型号、接口、输出信号和目标价。", sortOrder: 130 },
  { section: "persona", title: "EPC / 工程承包商", summary: "关注认证、项目清单、交付风险、技术文件和投标资料。", output: "关键词：EPC water treatment instruments / project procurement\n首触达：索要 RFQ、项目清单、证书要求", badge: "高价值", badgeTone: "red", phase: "客户画像", category: "客户开发", priority: "medium", target: "筛选15家EPC客户并记录项目机会", description: "优先查水处理、化工、环保、电力工程客户，邮件重点强调证书、交付和项目配合能力。", sortOrder: 140 },
  { section: "execution", title: "第 1 天", summary: "整理仪表产品分类与参数卡；建立客户搜索关键词库 10 组。", output: "整理仪表产品分类与参数卡。\n建立客户搜索关键词库 10 组。", badge: "启动", badgeTone: "green", phase: "首周执行", category: "产品知识", priority: "high", target: "完成分类卡和10组关键词库", description: "先把产品分类、参数卡和客户搜索关键词准备好，避免盲目找客户。", sortOrder: 210 },
  { section: "execution", title: "第 2 天", summary: "整理证书、报价资料和应用案例；新增 30 家目标客户到 CRM。", output: "整理证书、报价资料和应用案例。\n新增 30 家目标客户到 CRM。", badge: "资料", badgeTone: "aqua", phase: "首周执行", category: "资料维护", priority: "high", target: "完成资料包并新增30家客户", description: "把资料准备和客户池新增绑定，新增客户必须带国家、官网、产品匹配点和下一步动作。", sortOrder: 220 },
  { section: "execution", title: "第 3 天", summary: "完成角色-痛点-话术表；首触达 20 家高匹配客户。", output: "完成角色-痛点-话术表。\n首触达 20 家高匹配客户。", badge: "触达", badgeTone: "amber", phase: "首周执行", category: "客户开发", priority: "high", target: "完成20家首触达并记录结果", description: "按客户角色使用不同邮件标题、开场和参数追问，不要所有客户发同一套内容。", sortOrder: 230 },
  { section: "execution", title: "第 4 天", summary: "整理竞品替代切入点 5 条；跟进昨日未回复客户 10 家。", output: "整理竞品替代切入点 5 条。\n跟进昨日未回复客户 10 家。", badge: "跟进", badgeTone: "amber", phase: "首周执行", category: "竞品研究", priority: "medium", target: "完成10家二次跟进和5条竞品切入点", description: "二次跟进要补充资料或新问题，不能只是重复问客户是否收到邮件。", sortOrder: 240 },
  { section: "execution", title: "第 5 天", summary: "制作参数确认表模板；深挖 3 家 A 类客户并写入 CRM。", output: "制作参数确认表模板。\n深挖 3 家 A 类客户并写入 CRM。", badge: "深挖", badgeTone: "red", phase: "首周执行", category: "客户开发", priority: "medium", target: "完成3家A类客户深挖", description: "深挖官网、联系人、产品线、可能项目、竞品品牌和下一步触达理由。", sortOrder: 250 },
  { section: "execution", title: "第 6-7 天", summary: "完成第一周开发周报；复盘并优化 ICP 与话术。", output: "完成第一周开发周报。\n复盘并优化 ICP 与话术。", badge: "复盘", badgeTone: "green", phase: "首周执行", category: "周报复盘", priority: "normal", target: "输出可汇报的首周复盘", description: "复盘新增客户、有效触达、有效回复、问题、资料缺口和下周优化动作。", sortOrder: 260 }
];

function sortPlanTemplates(templates: PlanTemplate[]) {
  return [...templates].sort((left, right) => left.sortOrder - right.sortOrder || String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")));
}

async function ensurePlanTemplatesForUser(user: SessionUser) {
  const store = getStore();
  const existing = store.planTemplates.filter((template) => canSeePersonalData(user, template.ownerId));
  if (existing.length && existing.some((template) => template.section === "execution")) return sortPlanTemplates(existing);
  const now = new Date().toISOString();
  const drafts = existing.length ? defaultPlanTemplateDrafts.filter((template) => template.section === "execution") : defaultPlanTemplateDrafts;
  const created = drafts.map((template, index) => ({
    id: `ptpl_${user.id}_${Date.now()}_${index}`,
    ownerId: user.id,
    teamId: user.teamId,
    updatedAt: now,
    ...template
  }));
  store.planTemplates.push(...created);
  await store.persist();
  return sortPlanTemplates([...existing, ...created]);
}

app.get("/api/plan-tasks", requireAuth, (req, res) => {
  const { planTasks } = getStore();
  const scoped = planTasks.filter((task) => canSeePersonalData(req.user!, task.ownerId));
  res.json({ tasks: sortPlanTasks(scoped) });
});

app.post("/api/plan-tasks", requireAuth, asyncRoute(async (req, res) => {
  const body = planTaskSchema.parse(req.body);
  const now = new Date().toISOString();
  const store = getStore();
  const task: PlanTask = {
    id: `pt_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    createdAt: now,
    updatedAt: now,
    ...body
  };
  store.planTasks.unshift(task);
  await store.persist();
  res.json({ task });
}));

app.patch("/api/plan-tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = planTaskSchema.partial().parse(req.body);
  const store = getStore();
  const task = store.planTasks.find((item) => item.id === req.params.id);
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  Object.assign(task, body, { updatedAt: new Date().toISOString() });
  await store.persist();
  res.json({ task });
}));

app.delete("/api/plan-tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.planTasks.findIndex((item) => item.id === req.params.id);
  const task = index >= 0 ? store.planTasks[index] : null;
  if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
    res.status(404).json({ message: "计划任务不存在" });
    return;
  }
  store.planTasks.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

const planTemplateSchema = z.object({
  section: z.enum(["knowledge", "persona", "execution"]).default("knowledge"),
  title: z.string().min(1),
  summary: z.string().default(""),
  output: z.string().default(""),
  badge: z.string().default(""),
  badgeTone: z.string().default(""),
  phase: z.string().min(1).default("计划任务"),
  category: z.string().min(1).default("客户开发"),
  priority: z.enum(["high", "medium", "normal"]).default("normal"),
  target: z.string().default(""),
  description: z.string().default(""),
  sortOrder: z.coerce.number().int().default(0)
});

app.get("/api/plan-templates", requireAuth, asyncRoute(async (req, res) => {
  const templates = await ensurePlanTemplatesForUser(req.user!);
  res.json({ templates });
}));

app.post("/api/plan-templates", requireAuth, asyncRoute(async (req, res) => {
  const body = planTemplateSchema.parse(req.body);
  const store = getStore();
  const template: PlanTemplate = {
    id: `ptpl_${Date.now()}`,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString(),
    ...body
  };
  store.planTemplates.push(template);
  await store.persist();
  res.json({ template });
}));

app.patch("/api/plan-templates/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = planTemplateSchema.partial().parse(req.body);
  const store = getStore();
  const template = store.planTemplates.find((item) => item.id === req.params.id);
  if (!template || !canSeePersonalData(req.user!, template.ownerId)) {
    res.status(404).json({ message: "模板不存在" });
    return;
  }
  Object.assign(template, body, { updatedAt: new Date().toISOString() });
  await store.persist();
  res.json({ template });
}));

app.delete("/api/plan-templates/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.planTemplates.findIndex((item) => item.id === req.params.id);
  const template = index >= 0 ? store.planTemplates[index] : null;
  if (!template || !canSeePersonalData(req.user!, template.ownerId)) {
    res.status(404).json({ message: "模板不存在" });
    return;
  }
  store.planTemplates.splice(index, 1);
  await store.persist();
  res.json({ ok: true, id: req.params.id });
}));

app.get("/api/deals", requireAuth, (req, res) => {
  const { deals } = getStore();
  const scoped = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId));
  res.json({ deals: scoped });
});

const dealStages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交", "丢单"] as const;
const dealBodySchema = z.object({
  customerId: z.string().optional().default(""),
  title: z.string().min(1),
  stage: z.enum(dealStages).default("询盘"),
  product: z.string().max(200).optional().default(""),
  quantity: z.coerce.number().int().nonnegative().default(0),
  unitPrice: z.coerce.number().nonnegative().default(0),
  amount: z.coerce.number().nonnegative().optional(),
  nextAction: z.string().min(1).default("首次跟进")
});

function calculatedDealAmount(body: { amount?: number; quantity: number; unitPrice: number }) {
  if (typeof body.amount === "number") return Math.round(body.amount * 100) / 100;
  return Math.round(body.quantity * body.unitPrice * 100) / 100;
}

app.post("/api/deals", requireAuth, asyncRoute(async (req, res) => {
  const body = dealBodySchema.parse(req.body);
  const store = getStore();
  const customerId = body.customerId.trim();
  const customer = customerId ? store.customers.find((item) => item.id === customerId) : undefined;
  if (customerId && (!customer || !canSeeOwner(req.user!, customer.ownerId, customer.teamId))) {
    res.status(404).json({ message: "客户不存在" });
    return;
  }
  const deal = {
    id: `d_${Date.now()}`,
    customerId: customer?.id || "",
    title: body.title,
    stage: body.stage,
    product: body.product.trim(),
    quantity: body.quantity,
    unitPrice: body.unitPrice,
    amount: calculatedDealAmount(body),
    ownerId: customer?.ownerId || req.user!.id,
    teamId: customer?.teamId || req.user!.teamId,
    nextAction: body.nextAction,
    archivedAt: undefined
  };
  store.deals.unshift(deal);
  await store.persist();
  res.json({ deal });
}));

app.patch("/api/deals/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = dealBodySchema.parse(req.body);
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能编辑" });
    return;
  }
  const customerId = body.customerId.trim();
  const customer = customerId ? store.customers.find((item) => item.id === customerId) : undefined;
  if (customerId && (!customer || !canSeeOwner(req.user!, customer.ownerId, customer.teamId))) {
    res.status(404).json({ message: "客户不存在" });
    return;
  }
  if (deal.stage === "成交" && body.stage === "丢单") {
    res.status(400).json({ message: "成交商机请归档，不能编辑为丢单" });
    return;
  }
  deal.customerId = customer?.id || "";
  deal.title = body.title;
  deal.stage = body.stage;
  deal.product = body.product.trim();
  deal.quantity = body.quantity;
  deal.unitPrice = body.unitPrice;
  deal.amount = calculatedDealAmount(body);
  deal.ownerId = customer?.ownerId || deal.ownerId;
  deal.teamId = customer?.teamId || deal.teamId;
  deal.nextAction = body.nextAction;
  await store.persist();
  res.json({ deal });
}));

app.patch("/api/deals/:id/stage", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ stage: z.enum(dealStages) });
  const store = getStore();
  const body = schema.parse(req.body);
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能推进阶段" });
    return;
  }
  if (deal.stage === "成交" && body.stage === "丢单") {
    res.status(400).json({ message: "成交商机请归档，不再推进为丢单" });
    return;
  }
  deal.stage = body.stage;
  await store.persist();
  res.json({ deal });
}));

app.post("/api/deals/:id/archive", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.stage !== "成交") {
    res.status(400).json({ message: "只有成交商机可以归档" });
    return;
  }
  deal.archivedAt = new Date().toISOString();
  deal.nextAction = "已成交归档，可在商机归档区查询";
  await store.persist();
  res.json({ deal });
}));

app.post("/api/deals/:id/lost", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const deal = store.deals.find((item) => item.id === req.params.id);
  if (!deal || !canSeeOwner(req.user!, deal.ownerId, deal.teamId)) {
    res.status(404).json({ message: "商机不存在" });
    return;
  }
  if (deal.archivedAt) {
    res.status(400).json({ message: "已归档商机不能重复丢单" });
    return;
  }
  if (deal.stage === "成交") {
    res.status(400).json({ message: "成交商机请归档，不能标记丢单" });
    return;
  }
  deal.stage = "丢单";
  deal.archivedAt = new Date().toISOString();
  deal.nextAction = "已标记丢单，可在归档/丢单商机中复盘";
  await store.persist();
  res.json({ deal });
}));

function canManageCommissionRules(user?: SessionUser) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function canReviewCommission(user?: SessionUser) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function currentMonthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function roundMoneyValue(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function commissionOwnersFor(user: SessionUser) {
  const store = getStore();
  if (canReviewCommission(user)) {
    return store.users
      .filter((item) => item.status === "active" && (item.role === "sales" || item.role === "manager"))
      .map((item) => ({ id: item.id, name: item.name, email: item.email, role: item.role, teamId: item.teamId }));
  }
  return [{ id: user.id, name: user.name, email: user.email, role: user.role, teamId: user.teamId }];
}

function resolveCommissionOwnerId(user: SessionUser, requestedOwnerId?: string) {
  const requested = requestedOwnerId?.trim();
  if (canReviewCommission(user)) {
    if (!requested || requested === "all") return "";
    return commissionOwnersFor(user).some((item) => item.id === requested) ? requested : null;
  }
  if (!requested || requested === user.id) return user.id;
  return null;
}

function canAccessCommissionOwner(user: SessionUser, ownerId: string) {
  if (canReviewCommission(user)) return true;
  return ownerId === user.id;
}

function visibleSalesRecords(user: SessionUser, month?: string, ownerId?: string) {
  const scopedOwnerId = resolveCommissionOwnerId(user, ownerId);
  if (scopedOwnerId === null) return null;
  const allowedOwners = new Set(commissionOwnersFor(user).map((item) => item.id));
  return getStore().monthlySalesRecords.filter((record) => {
    if (month && record.month !== month) return false;
    if (scopedOwnerId && record.ownerId !== scopedOwnerId) return false;
    if (!scopedOwnerId && canReviewCommission(user) && !allowedOwners.has(record.ownerId)) return false;
    return canAccessCommissionOwner(user, record.ownerId);
  });
}

function findCommissionProduct(productName = "") {
  const normalized = productName.trim().toLowerCase();
  if (!normalized) return undefined;
  return getStore().commissionProducts.find((product) => product.status === "active" && (
    product.name.toLowerCase() === normalized ||
    product.model.toLowerCase() === normalized ||
    normalized.includes(product.name.toLowerCase()) ||
    (product.model && normalized.includes(product.model.toLowerCase()))
  ));
}

function activeCommissionRule(productId: string, month: string) {
  return getStore().commissionRules
    .filter((rule) => rule.productId === productId && rule.enabled)
    .filter((rule) => (!rule.effectiveFrom || rule.effectiveFrom <= month) && (!rule.effectiveTo || rule.effectiveTo >= month))
    .sort((left, right) => (right.effectiveFrom || "").localeCompare(left.effectiveFrom || "") || right.createdAt.localeCompare(left.createdAt))[0];
}

function calculateCommissionAmount(record: MonthlySalesRecord, product?: CommissionProduct, rule?: CommissionRule) {
  const sales = Number(record.settlementAmount || record.salesAmount || 0);
  if (!rule || rule.ruleType === "none") return { amount: 0, snapshot: { reason: "无启用规则" } };
  if (rule.ruleType === "rate") return { amount: roundMoneyValue(sales * Number(rule.rate || 0)), snapshot: rule };
  if (rule.ruleType === "fixed") return { amount: roundMoneyValue(Number(rule.fixedAmount || 0) * Number(record.quantity || 1)), snapshot: rule };
  if (rule.ruleType === "gross_profit") {
    const cost = Number(product?.costPrice || 0) * Number(record.quantity || 0);
    return { amount: roundMoneyValue(Math.max(0, sales - cost) * Number(rule.grossProfitRate || 0)), snapshot: { ...rule, cost } };
  }
  if (rule.ruleType === "tier") {
    let rate = 0;
    try {
      const tiers = JSON.parse(rule.tierJson || "[]") as Array<{ from?: number; to?: number; rate?: number }>;
      const matched = tiers.find((tier) => sales >= Number(tier.from || 0) && sales < Number(tier.to || Number.MAX_SAFE_INTEGER));
      rate = Number(matched?.rate || 0);
    } catch {
      rate = 0;
    }
    return { amount: roundMoneyValue(sales * rate), snapshot: { ...rule, appliedRate: rate } };
  }
  return { amount: 0, snapshot: rule };
}

function rebuildCalculationTotals(calculation: CommissionCalculation) {
  const store = getStore();
  const items = store.commissionItems.filter((item) => item.calculationId === calculation.id);
  calculation.salesAmount = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.salesAmount || 0), 0));
  calculation.autoCommission = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.autoAmount || 0), 0));
  calculation.manualAdjustment = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.manualAmount || 0), 0));
  calculation.finalCommission = roundMoneyValue(items.reduce((sum, item) => sum + Number(item.finalAmount || 0), 0));
  calculation.calculatedAt = new Date().toISOString();
  calculation.status = calculation.status === "locked" || calculation.status === "reviewed" ? calculation.status : "calculated";
}

function ensureCalculation(month: string, ownerId: string, teamId: string) {
  const store = getStore();
  let calculation = store.commissionCalculations.find((item) => item.month === month && item.ownerId === ownerId);
  if (!calculation) {
    calculation = {
      id: `cc_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
      month,
      ownerId,
      teamId,
      salesAmount: 0,
      autoCommission: 0,
      manualAdjustment: 0,
      finalCommission: 0,
      status: "pending",
      calculatedAt: "",
      reviewedBy: "",
      reviewedAt: "",
      lockedBy: "",
      lockedAt: "",
      unlockReason: ""
    };
    store.commissionCalculations.unshift(calculation);
  }
  return calculation;
}

const commissionProductSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional().default(""),
  model: z.string().optional().default(""),
  currency: z.string().optional().default("USD"),
  defaultPrice: z.coerce.number().nonnegative().default(0),
  costPrice: z.coerce.number().nonnegative().default(0),
  status: z.enum(["active", "disabled"]).default("active"),
  remark: z.string().optional().default("")
});

const commissionRuleSchema = z.object({
  ruleType: z.enum(["rate", "fixed", "tier", "gross_profit", "none"]),
  rate: z.coerce.number().nonnegative().default(0),
  fixedAmount: z.coerce.number().nonnegative().default(0),
  tierJson: z.string().optional().default(""),
  grossProfitRate: z.coerce.number().nonnegative().default(0),
  effectiveFrom: z.string().optional().default(currentMonthValue()),
  effectiveTo: z.string().optional().default(""),
  enabled: z.coerce.boolean().default(true),
  remark: z.string().optional().default("")
});

const salesRecordSchema = z.object({
  ownerId: z.string().optional().default(""),
  month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()),
  customerId: z.string().optional().default(""),
  customerName: z.string().min(1),
  productId: z.string().optional().default(""),
  productName: z.string().min(1),
  quantity: z.coerce.number().nonnegative().default(1),
  unitPrice: z.coerce.number().nonnegative().default(0),
  salesAmount: z.coerce.number().nonnegative().optional(),
  currency: z.string().optional().default("USD"),
  exchangeRate: z.coerce.number().positive().default(1),
  status: z.enum(["draft", "confirmed", "reviewed", "locked"]).default("draft"),
  editNote: z.string().optional().default("")
});

app.get("/api/commission/products", requireAuth, (req, res) => {
  const store = getStore();
  res.json({
    products: store.commissionProducts,
    rules: store.commissionRules,
    canManage: canManageCommissionRules(req.user),
    canSelectOwner: canReviewCommission(req.user),
    owners: commissionOwnersFor(req.user!)
  });
});

app.post("/api/commission/products", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成产品" });
    return;
  }
  const body = commissionProductSchema.parse(req.body);
  const store = getStore();
  const product: CommissionProduct = {
    id: `cp_${Date.now()}`,
    ...body,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString()
  };
  store.commissionProducts.unshift(product);
  await store.persist();
  res.json({ product });
}));

app.patch("/api/commission/products/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成产品" });
    return;
  }
  const body = commissionProductSchema.partial().parse(req.body);
  const store = getStore();
  const product = store.commissionProducts.find((item) => item.id === req.params.id);
  if (!product) {
    res.status(404).json({ message: "产品不存在" });
    return;
  }
  Object.assign(product, body, { updatedAt: new Date().toISOString() });
  await store.persist();
  res.json({ product });
}));

app.post("/api/commission/products/:id/rules", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成规则" });
    return;
  }
  const store = getStore();
  const product = store.commissionProducts.find((item) => item.id === req.params.id);
  if (!product) {
    res.status(404).json({ message: "产品不存在" });
    return;
  }
  const body = commissionRuleSchema.parse(req.body);
  const rule: CommissionRule = {
    id: `cr_${Date.now()}`,
    productId: product.id,
    ...body,
    createdBy: req.user!.id,
    createdAt: new Date().toISOString()
  };
  store.commissionRules.unshift(rule);
  await store.persist();
  res.json({ rule });
}));

app.patch("/api/commission/rules/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!canManageCommissionRules(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以维护提成规则" });
    return;
  }
  const body = commissionRuleSchema.partial().parse(req.body);
  const store = getStore();
  const rule = store.commissionRules.find((item) => item.id === req.params.id);
  if (!rule) {
    res.status(404).json({ message: "提成规则不存在" });
    return;
  }
  Object.assign(rule, body);
  await store.persist();
  res.json({ rule });
}));

app.get("/api/commission/sales-records", requireAuth, (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : currentMonthValue();
  const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const records = visibleSalesRecords(req.user!, month, ownerId);
  if (!records) {
    res.status(403).json({ message: "无权查看该人员的提成数据" });
    return;
  }
  res.json({ records, owners: commissionOwnersFor(req.user!), canSelectOwner: canReviewCommission(req.user), selectedOwnerId: resolveCommissionOwnerId(req.user!, ownerId) || "all" });
});

app.post("/api/commission/sales-records/sync-from-deals", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()), ownerId: z.string().optional().default("") }).parse(req.body);
  const ownerId = resolveCommissionOwnerId(req.user!, body.ownerId);
  if (ownerId === null) {
    res.status(403).json({ message: "无权同步该人员的提成数据" });
    return;
  }
  const month = body.month;
  const store = getStore();
  const archivedWonDeals = store.deals.filter((deal) => {
    if (deal.stage !== "成交" || !deal.archivedAt) return false;
    if (ownerId && deal.ownerId !== ownerId) return false;
    if (!canAccessCommissionOwner(req.user!, deal.ownerId)) return false;
    return deal.archivedAt.slice(0, 7) === month;
  });
  const created: MonthlySalesRecord[] = [];
  for (const deal of archivedWonDeals) {
    if (store.monthlySalesRecords.some((record) => record.dealId === deal.id)) continue;
    const customer = store.customers.find((item) => item.id === deal.customerId);
    const product = findCommissionProduct(deal.product);
    const salesAmount = roundMoneyValue(Number(deal.amount || deal.quantity * deal.unitPrice || 0));
    const record: MonthlySalesRecord = {
      id: `msr_${Date.now()}_${created.length}`,
      month,
      ownerId: deal.ownerId,
      teamId: deal.teamId,
      customerId: customer?.id || "",
      customerName: customer?.company || "未关联客户",
      dealId: deal.id,
      productId: product?.id || "",
      productName: product?.name || deal.product || deal.title,
      quantity: Number(deal.quantity || 0),
      unitPrice: Number(deal.unitPrice || 0),
      salesAmount,
      currency: product?.currency || "USD",
      exchangeRate: 1,
      settlementAmount: salesAmount,
      dealArchivedAt: deal.archivedAt || "",
      sourceType: "deal",
      status: "draft",
      edited: false,
      editNote: "",
      lastEditedBy: "",
      lastEditedAt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.monthlySalesRecords.unshift(record);
    created.push(record);
  }
  await store.persist();
  res.json({ created, records: visibleSalesRecords(req.user!, month, body.ownerId) || [] });
}));

app.post("/api/commission/sales-records", requireAuth, asyncRoute(async (req, res) => {
  const body = salesRecordSchema.parse(req.body);
  const targetOwnerId = resolveCommissionOwnerId(req.user!, body.ownerId);
  if (targetOwnerId === null || targetOwnerId === "") {
    res.status(403).json({ message: "请先选择一个具体人员，再新增销售记录" });
    return;
  }
  const targetUser = getStore().users.find((user) => user.id === targetOwnerId);
  if (!targetUser) {
    res.status(404).json({ message: "人员不存在" });
    return;
  }
  const salesAmount = roundMoneyValue(body.salesAmount ?? body.quantity * body.unitPrice);
  const record: MonthlySalesRecord = {
    id: `msr_${Date.now()}`,
    month: body.month,
    ownerId: targetUser.id,
    teamId: targetUser.teamId,
    customerId: body.customerId,
    customerName: body.customerName,
    dealId: "",
    productId: body.productId,
    productName: body.productName,
    quantity: body.quantity,
    unitPrice: body.unitPrice,
    salesAmount,
    currency: body.currency,
    exchangeRate: body.exchangeRate,
    settlementAmount: roundMoneyValue(salesAmount * body.exchangeRate),
    dealArchivedAt: "",
    sourceType: "manual",
    status: body.status,
    edited: false,
    editNote: body.editNote,
    lastEditedBy: "",
    lastEditedAt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const store = getStore();
  store.monthlySalesRecords.unshift(record);
  await store.persist();
  res.json({ record });
}));

app.patch("/api/commission/sales-records/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = salesRecordSchema.partial().extend({ editNote: z.string().min(2) }).parse(req.body);
  const store = getStore();
  const record = store.monthlySalesRecords.find((item) => item.id === req.params.id);
  if (!record || !canAccessCommissionOwner(req.user!, record.ownerId)) {
    res.status(404).json({ message: "销售记录不存在" });
    return;
  }
  if (record.status === "locked" || store.commissionCalculations.some((item) => item.month === record.month && item.ownerId === record.ownerId && item.status === "locked")) {
    res.status(400).json({ message: "已锁定记录不能编辑" });
    return;
  }
  const updates: Partial<MonthlySalesRecord> = {};
  const auditFields: Array<keyof MonthlySalesRecord> = ["customerName", "productName", "quantity", "unitPrice", "salesAmount", "currency", "exchangeRate", "status", "productId", "customerId"];
  for (const field of auditFields) {
    if (body[field as keyof typeof body] !== undefined) {
      const nextValue = body[field as keyof typeof body] as never;
      if (String(record[field] ?? "") !== String(nextValue ?? "")) {
        (updates as Record<string, unknown>)[field] = nextValue;
        const audit: SalesRecordAudit = {
          id: `sra_${Date.now()}_${field}`,
          recordId: record.id,
          fieldName: String(field),
          oldValue: String(record[field] ?? ""),
          newValue: String(nextValue ?? ""),
          reason: body.editNote,
          operatorId: req.user!.id,
          operatorName: req.user!.name,
          createdAt: new Date().toISOString()
        };
        store.salesRecordAudits.unshift(audit);
      }
    }
  }
  Object.assign(record, updates);
  if (body.quantity !== undefined || body.unitPrice !== undefined || body.salesAmount !== undefined || body.exchangeRate !== undefined) {
    record.salesAmount = roundMoneyValue(record.salesAmount || record.quantity * record.unitPrice);
    record.settlementAmount = roundMoneyValue(record.salesAmount * record.exchangeRate);
  }
  record.edited = true;
  record.sourceType = record.sourceType === "manual" ? "manual" : "adjusted";
  record.editNote = body.editNote;
  record.lastEditedBy = req.user!.id;
  record.lastEditedAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ record, audits: store.salesRecordAudits.filter((audit) => audit.recordId === record.id) });
}));

app.post("/api/commission/sales-records/:id/confirm", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const record = store.monthlySalesRecords.find((item) => item.id === req.params.id);
  if (!record || !canAccessCommissionOwner(req.user!, record.ownerId)) {
    res.status(404).json({ message: "销售记录不存在" });
    return;
  }
  if (record.status === "locked") {
    res.status(400).json({ message: "已锁定记录不能重复确认" });
    return;
  }
  record.status = "confirmed";
  record.updatedAt = new Date().toISOString();
  await store.persist();
  res.json({ record });
}));

app.get("/api/commission/sales-records/:id/audits", requireAuth, (req, res) => {
  const store = getStore();
  const record = store.monthlySalesRecords.find((item) => item.id === req.params.id);
  if (!record || !canAccessCommissionOwner(req.user!, record.ownerId)) {
    res.status(404).json({ message: "销售记录不存在" });
    return;
  }
  res.json({ audits: store.salesRecordAudits.filter((audit) => audit.recordId === record.id) });
});

app.get("/api/commission/calculations", requireAuth, (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : currentMonthValue();
  const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const scopedOwnerId = resolveCommissionOwnerId(req.user!, ownerId);
  if (scopedOwnerId === null) {
    res.status(403).json({ message: "无权查看该人员的提成计算单" });
    return;
  }
  const allowedOwners = new Set(commissionOwnersFor(req.user!).map((item) => item.id));
  const calculations = getStore().commissionCalculations.filter((calculation) => {
    if (calculation.month !== month) return false;
    if (scopedOwnerId && calculation.ownerId !== scopedOwnerId) return false;
    if (!scopedOwnerId && canReviewCommission(req.user) && !allowedOwners.has(calculation.ownerId)) return false;
    return canAccessCommissionOwner(req.user!, calculation.ownerId);
  });
  const ids = new Set(calculations.map((item) => item.id));
  res.json({
    calculations,
    items: getStore().commissionItems.filter((item) => ids.has(item.calculationId)),
    canReview: canReviewCommission(req.user),
    canSelectOwner: canReviewCommission(req.user),
    owners: commissionOwnersFor(req.user!),
    selectedOwnerId: scopedOwnerId || "all"
  });
});

app.post("/api/commission/calculations/recalculate", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()), ownerId: z.string().optional().default("") }).parse(req.body);
  const ownerId = resolveCommissionOwnerId(req.user!, body.ownerId);
  if (ownerId === null) {
    res.status(403).json({ message: "无权计算该人员的提成数据" });
    return;
  }
  const month = body.month;
  const store = getStore();
  const visibleRecords = visibleSalesRecords(req.user!, month, body.ownerId);
  if (!visibleRecords) {
    res.status(403).json({ message: "无权计算该人员的提成数据" });
    return;
  }
  const records = visibleRecords.filter((record) => record.status === "confirmed" || record.status === "reviewed" || record.status === "locked");
  const byOwner = new Map<string, MonthlySalesRecord[]>();
  records.forEach((record) => byOwner.set(record.ownerId, [...(byOwner.get(record.ownerId) || []), record]));
  const changedCalculations: CommissionCalculation[] = [];
  for (const [ownerId, ownerRecords] of byOwner.entries()) {
    const calculation = ensureCalculation(month, ownerId, ownerRecords[0].teamId);
    if (calculation.status === "locked") continue;
    store.commissionItems = store.commissionItems.filter((item) => item.calculationId !== calculation.id || item.sourceType !== "auto");
    ownerRecords.forEach((record, index) => {
      const product = store.commissionProducts.find((item) => item.id === record.productId) || findCommissionProduct(record.productName);
      const rule = product ? activeCommissionRule(product.id, month) : undefined;
      const computed = calculateCommissionAmount(record, product, rule);
      const item: CommissionItem = {
        id: `ci_${Date.now()}_${index}_${Math.random().toString(16).slice(2, 6)}`,
        calculationId: calculation.id,
        recordId: record.id,
        productId: product?.id || record.productId || "",
        itemType: "auto",
        sourceType: "auto",
        ruleSnapshotJson: JSON.stringify(computed.snapshot),
        salesAmount: record.settlementAmount,
        autoAmount: computed.amount,
        manualAmount: 0,
        finalAmount: computed.amount,
        remark: rule ? rule.remark || "自动按规则计算" : "未匹配启用规则，金额为0",
        createdBy: req.user!.id,
        createdAt: new Date().toISOString()
      };
      store.commissionItems.unshift(item);
    });
    rebuildCalculationTotals(calculation);
    changedCalculations.push(calculation);
  }
  await store.persist();
  const allowedOwners = new Set(commissionOwnersFor(req.user!).map((item) => item.id));
  const calculations = store.commissionCalculations.filter((calculation) => {
    if (calculation.month !== month) return false;
    if (ownerId && calculation.ownerId !== ownerId) return false;
    if (!ownerId && canReviewCommission(req.user) && !allowedOwners.has(calculation.ownerId)) return false;
    return canAccessCommissionOwner(req.user!, calculation.ownerId);
  });
  const ids = new Set(calculations.map((item) => item.id));
  res.json({ calculations, items: store.commissionItems.filter((item) => ids.has(item.calculationId)), changedCalculations });
}));

app.post("/api/commission/calculations/:id/manual-item", requireAuth, asyncRoute(async (req, res) => {
  if (!canReviewCommission(req.user)) {
    res.status(403).json({ message: "只有管理员和超级管理员可以调整提成金额" });
    return;
  }
  const body = z.object({
    itemType: z.enum(["bonus", "deduction", "subsidy", "refund", "special", "other"]).default("other"),
    manualAmount: z.coerce.number().default(0),
    remark: z.string().min(1)
  }).parse(req.body);
  const store = getStore();
  const calculation = store.commissionCalculations.find((item) => item.id === req.params.id);
  if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
    res.status(404).json({ message: "提成计算单不存在" });
    return;
  }
  if (calculation.status === "locked") {
    res.status(400).json({ message: "已锁定计算单不能调整" });
    return;
  }
  if (body.itemType === "deduction" || body.itemType === "refund") {
    body.manualAmount = -Math.abs(body.manualAmount);
  }
  const item: CommissionItem = {
    id: `ci_manual_${Date.now()}`,
    calculationId: calculation.id,
    recordId: "",
    productId: "",
    itemType: body.itemType,
    sourceType: "manual",
    ruleSnapshotJson: "",
    salesAmount: 0,
    autoAmount: 0,
    manualAmount: roundMoneyValue(body.manualAmount),
    finalAmount: roundMoneyValue(body.manualAmount),
    remark: body.remark,
    createdBy: req.user!.id,
    createdAt: new Date().toISOString()
  };
  store.commissionItems.unshift(item);
  rebuildCalculationTotals(calculation);
  await store.persist();
  res.json({ calculation, item });
}));

app.post("/api/commission/export", requireAuth, asyncRoute(async (req, res) => {
  const body = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthValue()),
    scopeType: z.enum(["self", "team", "all"]).default("self"),
    ownerId: z.string().optional().default(""),
    fileType: z.enum(["xlsx", "csv"]).default("xlsx")
  }).parse(req.body);
  const store = getStore();
  const ownerId = body.scopeType === "all" && canReviewCommission(req.user) ? "" : body.ownerId;
  const records = visibleSalesRecords(req.user!, body.month, ownerId);
  if (!records) {
    res.status(403).json({ message: "无权导出该人员的提成数据" });
    return;
  }
  const calculationByOwner = new Map(store.commissionCalculations.filter((item) => item.month === body.month).map((item) => [item.ownerId, item]));
  const rows = records.map((record) => {
    const calculation = calculationByOwner.get(record.ownerId);
    const owner = store.users.find((item) => item.id === record.ownerId);
    return {
      month: record.month,
      ownerName: owner?.name || record.ownerId,
      customerName: record.customerName,
      productName: record.productName,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
      salesAmount: record.salesAmount,
      settlementAmount: record.settlementAmount,
      status: record.status,
      edited: record.edited,
      finalCommission: calculation?.finalCommission || 0,
      editNote: record.editNote
    };
  });
  const exportJob = {
    id: `ce_${Date.now()}`,
    month: body.month,
    scopeType: canReviewCommission(req.user) ? body.scopeType : "self",
    scopeOwnerId: ownerId || (canReviewCommission(req.user) ? "all" : req.user!.id),
    fileType: body.fileType,
    rows: rows.length,
    exportedBy: req.user!.id,
    createdAt: new Date().toISOString()
  };
  store.commissionExports.unshift(exportJob);
  await store.persist();
  res.json({ exportJob, rows });
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
  if (!requireTrainingManager(req, res)) return;
  const category = String(req.query.category || "").trim();
  const tag = String(req.query.tag || "").trim();
  const type = String(req.query.type || "").trim();
  let questions = bankQuestions();
  if (category) questions = questions.filter((question) => question.category === category);
  if (tag) questions = questions.filter((question) => (question.tags || []).includes(tag));
  if (type) questions = questions.filter((question) => (question.questionType || (correctIndexesFor(question).length > 1 ? "multiple" : "single")) === type);
  res.json({ questions, report: examReport(req.user!) });
});

app.get("/api/exam-questions/export", requireAuth, (_req, res) => {
  if (!requireTrainingManager(_req, res)) return;
  res.json({ questions: bankQuestions() });
});

app.post("/api/exam-questions", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ question, report: examReport(req.user!) });
}));

app.post("/api/exam-questions/import", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ importedCount: imported.length, questions: imported, report: examReport(req.user!) });
}));

app.patch("/api/exam-questions/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ question, report: examReport(req.user!) });
}));

app.delete("/api/exam-questions/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ question, report: examReport(req.user!) });
}));

app.get("/api/exams", requireAuth, (_req, res) => {
  const { exams } = getStore();
  const scoped = exams.filter((exam) => canAccessExam(_req.user!, exam));
  res.json({ exams: scoped.map((exam) => examWithRuntimeStats(exam, _req.user!)), report: examReport(_req.user!) });
});

app.get("/api/exams/:id/detail", requireAuth, (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam || !canAccessExam(req.user!, exam)) {
    res.status(404).json({ message: "考试不存在" });
    return;
  }
  const questions = examQuestionsFor(exam.id);
  const attempts = store.examAttempts.filter((item) => item.examId === exam.id);
  const latestAttempt = attempts.find((item) => item.userId === req.user!.id) || null;
  res.json({ exam: examWithRuntimeStats(exam, req.user!), questions, latestAttempt, report: examReport(req.user!) });
});

app.post("/api/exams", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ exam: examWithRuntimeStats(exam, req.user!), questions: examQuestionsFor(exam.id), report: examReport(req.user!) });
}));

app.post("/api/exams/:id/questions", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ question, exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
}));

app.post("/api/exams/:id/questions/import", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ importedCount: imported.length, questions: imported, exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
}));

app.patch("/api/exams/:id/publish", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  res.json({ exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
}));

app.post("/api/exams/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  const scoped = store.exams.filter((exam) => canAccessExam(req.user!, exam));
  res.json({ deleted, exams: scoped.map((exam) => examWithRuntimeStats(exam, req.user!)), report: examReport(req.user!) });
}));

app.delete("/api/exams/:id", requireAuth, asyncRoute(async (req, res) => {
  if (!requireTrainingManager(req, res)) return;
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
  const scoped = store.exams.filter((item) => canAccessExam(req.user!, item));
  res.json({ exam, exams: scoped.map((item) => examWithRuntimeStats(item, req.user!)), report: examReport(req.user!) });
}));

app.post("/api/exams/:id/submit", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const exam = store.exams.find((item) => item.id === req.params.id);
  if (!exam || !canAccessExam(req.user!, exam)) {
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
  res.json({ attempt, exam: examWithRuntimeStats(exam, req.user!), questions, report: examReport(req.user!) });
}));

app.get("/api/reminders", requireAuth, (req, res) => {
  const { reminders } = getStore();
  const scoped = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  res.json({ reminders: scoped });
});

app.post("/api/reminders", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    title: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    dueAt: z.string().min(1).default("今天 17:00"),
    channel: z.enum(["站内", "邮件", "企业微信"]).default("企业微信"),
    ruleType: z.enum(["quote_no_reply", "sample_feedback", "inactive_customer", "high_value_revisit", "custom_due"]).default("quote_no_reply"),
    targetStage: z.string().default("已报价"),
    days: z.number().int().min(0).max(90).default(3),
    priority: z.enum(["high", "medium", "normal"]).default("medium"),
    enabled: z.boolean().default(true)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const generatedCount = matchReminderRule(req.user!, body).length;
  const reminder = {
    id: `r_${Date.now()}`,
    title: body.title || reminderRuleTitle(body.ruleType),
    rule: body.rule || reminderRuleText(body),
    dueAt: body.dueAt,
    channel: body.channel,
    ruleType: body.ruleType,
    targetStage: body.targetStage,
    days: body.days,
    priority: body.priority,
    enabled: body.enabled,
    generatedCount,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    status: "pending" as const
  };
  store.reminders.unshift(reminder);
  await store.persist();
  res.json({ reminder });
}));

app.post("/api/reminders/:id/run", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const reminder = store.reminders.find((item) => item.id === req.params.id);
  if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
    res.status(404).json({ message: "提醒规则不存在" });
    return;
  }
  if (reminder.enabled === false) {
    res.status(400).json({ message: "提醒规则已停用" });
    return;
  }
  const matched = matchReminderRule(req.user!, reminder);
  const created: Todo[] = [];
  for (const customer of matched) {
    const exists = store.todos.some((todo) => todo.ownerId === req.user!.id && !todo.done && todo.related === customer.company && todo.title.includes(reminder.title));
    if (exists) continue;
    created.push({
      id: `t_reminder_${reminder.id}_${customer.id}_${Date.now()}`,
      title: `${reminder.title}：${customer.company}`,
      type: "customer",
      priority: reminder.priority || "medium",
      status: "pending",
      pinState: "",
      sortOrder: nextTodoSortOrder(store.todos, req.user!.id),
      dueAt: reminder.dueAt || currentMinuteText(),
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      related: customer.company,
      done: false,
      impactAmount: customer.amount,
      createdAt: new Date().toISOString()
    });
  }
  store.todos.unshift(...created);
  reminder.generatedCount = matched.length;
  if (created.length) reminder.status = "sent";
  await store.persist();
  res.json({ reminder, createdCount: created.length, matchedCount: matched.length, todos: created });
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

app.post("/api/import-export/customers/import", requireAuth, asyncRoute(async (req, res) => {
  const rowSchema = z.object({
    company: z.string().trim().min(1),
    country: z.string().trim().optional().default("未知"),
    contact: z.string().trim().optional().default("待维护"),
    stage: z.string().trim().optional().default("询盘"),
    amount: z.number().nonnegative().optional().default(0),
    health: z.number().int().min(0).max(100).optional().default(70),
    nextReminder: z.string().trim().optional().default("待跟进"),
    wecomBound: z.boolean().optional().default(false),
    billingName: z.string().trim().optional().default(""),
    billingAddress: z.string().trim().optional().default(""),
    documentContact: z.string().trim().optional().default(""),
    defaultPortDischarge: z.string().trim().optional().default(""),
    defaultIncoterm: z.string().trim().optional().default("FOB Tianjin"),
    defaultPaymentTerm: z.string().trim().optional().default("30% T/T deposit, 70% before shipment")
  });
  const schema = z.object({ rows: z.array(rowSchema).min(1).max(2000), fileName: z.string().optional().default("客户导入") });
  const body = schema.parse(req.body);
  const store = getStore();
  const scopedCustomers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  let created = 0;
  let updated = 0;
  const imported: Customer[] = [];
  for (const row of body.rows) {
    const existing = scopedCustomers.find((customer) => customer.company.trim().toLowerCase() === row.company.trim().toLowerCase());
    if (existing) {
      Object.assign(existing, {
        country: row.country || existing.country,
        contact: row.contact || existing.contact,
        stage: row.stage || existing.stage,
        amount: row.amount,
        health: row.health,
        nextReminder: row.nextReminder || existing.nextReminder,
        wecomBound: row.wecomBound,
        billingName: row.billingName || existing.billingName || row.company,
        billingAddress: row.billingAddress || existing.billingAddress || "",
        documentContact: row.documentContact || existing.documentContact || row.contact,
        defaultPortDischarge: row.defaultPortDischarge || existing.defaultPortDischarge || "",
        defaultIncoterm: row.defaultIncoterm || existing.defaultIncoterm || "FOB Tianjin",
        defaultPaymentTerm: row.defaultPaymentTerm || existing.defaultPaymentTerm || "30% T/T deposit, 70% before shipment"
      });
      imported.push(existing);
      updated += 1;
    } else {
      const customer: Customer = {
        id: `c_import_${Date.now()}_${created}_${Math.random().toString(16).slice(2, 8)}`,
        company: row.company,
        country: row.country || "未知",
        contact: row.contact || "待维护",
        ownerId: req.user!.id,
        teamId: req.user!.teamId,
        stage: row.stage || "询盘",
        amount: row.amount,
        health: row.health,
        nextReminder: row.nextReminder || "待跟进",
        wecomBound: row.wecomBound,
        billingName: row.billingName || row.company,
        billingAddress: row.billingAddress || "",
        documentContact: row.documentContact || row.contact || "待维护",
        defaultPortDischarge: row.defaultPortDischarge || "",
        defaultIncoterm: row.defaultIncoterm || "FOB Tianjin",
        defaultPaymentTerm: row.defaultPaymentTerm || "30% T/T deposit, 70% before shipment"
      };
      store.customers.unshift(customer);
      scopedCustomers.push(customer);
      imported.push(customer);
      created += 1;
    }
  }
  const job = {
    id: `io_customer_import_${Date.now()}`,
    name: `客户导入：${body.fileName}`,
    type: "import" as const,
    rows: body.rows.length,
    status: "done" as const,
    operatorId: req.user!.id,
    createdAt: currentMinuteText()
  };
  store.importExportJobs.unshift(job);
  await store.persist();
  const customers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
  res.json({ result: { created, updated, skipped: 0, total: body.rows.length }, job, customers, imported });
}));

app.post("/api/import-export/customers/export", requireAuth, asyncRoute(async (_req, res) => {
  const store = getStore();
  const customers = store.customers.filter((customer) => canSeeOwner(_req.user!, customer.ownerId, customer.teamId));
  const job = {
    id: `io_customer_export_${Date.now()}`,
    name: "客户清单导出",
    type: "export" as const,
    rows: customers.length,
    status: "done" as const,
    operatorId: _req.user!.id,
    createdAt: currentMinuteText()
  };
  store.importExportJobs.unshift(job);
  await store.persist();
  res.json({ customers, job });
}));

const documentItemSchema = z.object({
  id: z.string().optional().default(""),
  product: z.string().min(1),
  model: z.string().optional().default(""),
  hsCode: z.string().optional().default(""),
  quantity: z.number().nonnegative().default(1),
  unit: z.string().optional().default("PCS"),
  unitPrice: z.number().nonnegative().default(0),
  originCountry: z.string().optional().default("China"),
  weightKg: z.number().nonnegative().default(0),
  packageCount: z.number().int().nonnegative().default(0)
});

const documentBodySchema = z.object({
  type: z.enum(["PI", "CI"]).default("PI"),
  title: z.string().min(1),
  number: z.string().min(1),
  issueDate: z.string().min(1),
  buyer: z.string().min(1),
  buyerAddress: z.string().optional().default(""),
  buyerContact: z.string().optional().default(""),
  seller: z.string().min(1),
  sellerAddress: z.string().optional().default(""),
  currency: z.string().min(1).default("USD"),
  incoterm: z.string().min(1).default("FOB"),
  paymentTerm: z.string().optional().default("30% T/T deposit, 70% before shipment"),
  shippingMethod: z.string().optional().default("Sea freight"),
  portLoading: z.string().optional().default("Tianjin, China"),
  portDischarge: z.string().optional().default(""),
  validityDate: z.string().optional().default(""),
  bankInfo: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  templateStyle: z.enum(["executive", "classic", "compact"]).default("executive"),
  status: z.enum(["draft", "ready", "exported"]).optional().default("draft"),
  items: z.array(documentItemSchema).min(1).max(80)
});

function normalizeDocument(body: z.infer<typeof documentBodySchema>, user: SessionUser, existing?: TradeDocument): TradeDocument {
  return {
    id: existing?.id || `td_${Date.now()}`,
    ownerId: existing?.ownerId || user.id,
    teamId: existing?.teamId || user.teamId,
    updatedAt: new Date().toISOString(),
    ...body,
    items: body.items.map((item, index) => ({ ...item, id: item.id || `tdi_${Date.now()}_${index}` }))
  };
}

app.get("/api/trade-documents", requireAuth, (req, res) => {
  const { tradeDocuments } = getStore();
  const documents = tradeDocuments.filter((document) => canSeeOwner(req.user!, document.ownerId, document.teamId));
  res.json({ documents });
});

app.post("/api/trade-documents", requireAuth, asyncRoute(async (req, res) => {
  const body = documentBodySchema.parse(req.body);
  const store = getStore();
  const document = normalizeDocument(body, req.user!);
  store.tradeDocuments.unshift(document);
  await store.persist();
  res.json({ document });
}));

app.patch("/api/trade-documents/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = documentBodySchema.parse(req.body);
  const store = getStore();
  const index = store.tradeDocuments.findIndex((document) => document.id === req.params.id);
  const existing = index >= 0 ? store.tradeDocuments[index] : undefined;
  if (!existing || !canSeeOwner(req.user!, existing.ownerId, existing.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  const document = normalizeDocument(body, req.user!, existing);
  store.tradeDocuments[index] = document;
  await store.persist();
  res.json({ document });
}));

app.post("/api/trade-documents/:id/export", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const document = store.tradeDocuments.find((item) => item.id === req.params.id);
  if (!document || !canSeeOwner(req.user!, document.ownerId, document.teamId)) {
    res.status(404).json({ message: "单据不存在" });
    return;
  }
  document.status = "exported";
  document.updatedAt = new Date().toISOString();
  const job = {
    id: `io_document_export_${Date.now()}`,
    name: `${document.type} 单据 PDF 导出：${document.number}`,
    type: "export" as const,
    rows: document.items.length,
    status: "done" as const,
    operatorId: req.user!.id,
    createdAt: currentMinuteText()
  };
  store.importExportJobs.unshift(job);
  await store.persist();
  res.json({ document, job, fileName: `${document.number}-${document.type}.pdf` });
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
  const job = resolveOcrJob(req.user!, req.params.id, true);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  res.json({ job });
});

app.post("/api/tools/ocr/jobs/:id/recognize", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const job = resolveOcrJob(req.user!, req.params.id, true);
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
  const job = resolveOcrJob(req.user!, req.params.id, false);
  if (!job) {
    res.status(404).json({ message: "OCR 任务不存在" });
    return;
  }
  const result = createLeadFromSource(req.user!, {
    company: job.fields.company || "待维护公司",
    contact: job.fields.contact || "",
    country: job.fields.country || "",
    email: job.fields.email || "",
    phone: job.fields.phone || job.fields.whatsapp || "",
    wechat: job.fields.wechat || "",
    source: "名片 OCR",
    sourceType: "offline",
    sourceChannel: "ocr",
    sourceCampaign: "",
    externalId: job.id,
    sourceUrl: "",
    intent: "中",
    stage: "新线索",
    estimatedAmount: 0,
    nextFollowAt: "",
    remark: job.fields.title ? `名片职位：${job.fields.title}` : "OCR 名片识别",
    rawPayload: job.fields
  });
  job.status = "synced";
  await store.persist();
  res.json(result);
}));

app.get("/api/tools/website-opportunities", requireAuth, (req, res) => {
  const { websiteOpportunities } = getStore();
  const scoped = websiteOpportunities.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
  res.json({ opportunities: scoped });
});

app.get("/api/tools/ai-config", requireAuth, (req, res) => {
  const configs = getAiConfigs(req.user!);
  const config = getAiConfig(req.user!);
  res.json({ config: config ? publicAiConfig(config) : null, configs: configs.map(publicAiConfig) });
});

app.post("/api/tools/ai-config", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    id: z.string().min(1).max(64).optional(),
    provider: z.string().min(1).max(40).default("openai"),
    protocol: z.enum(["openai-compatible", "anthropic", "gemini"]).default("openai-compatible"),
    name: z.string().min(1).default("AI业务模型配置"),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKey: z.string().optional().default(""),
    enabled: z.boolean().default(false),
    temperature: z.number().min(0).max(2).default(0.1),
    useLeadFinder: z.boolean().default(true),
    useWebsiteParse: z.boolean().default(true),
    useScoring: z.boolean().default(true),
    useEmailDraft: z.boolean().default(true),
    useExam: z.boolean().default(false)
  });
  const body = schema.parse(req.body);
  const store = getStore();
  const existing = body.id ? store.aiModelConfigs.find((item) => item.id === body.id && item.ownerId === req.user!.id) : undefined;
  const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : existing?.apiKey || "";
  if (body.enabled && !apiKey) {
    res.status(400).json({ message: "启用配置前必须填写 API Key" });
    return;
  }
  const config: AiModelConfig = {
    id: existing?.id || body.id || `ai_${req.user!.id}_${Date.now()}`,
    provider: body.provider,
    protocol: body.protocol,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/+$/, ""),
    model: body.model,
    apiKey,
    enabled: body.enabled,
    temperature: body.temperature,
    useLeadFinder: body.useLeadFinder,
    useWebsiteParse: body.useWebsiteParse,
    useScoring: body.useScoring,
    useEmailDraft: body.useEmailDraft,
    useExam: body.useExam,
    lastTestAt: existing?.lastTestAt,
    lastTestStatus: existing?.lastTestStatus || "untested",
    lastTestMessage: existing?.lastTestMessage || "",
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, config);
  else store.aiModelConfigs.unshift(config);
  await store.persist();
  res.json({ config: publicAiConfig(config), configs: getAiConfigs(req.user!).map(publicAiConfig) });
}));

app.delete("/api/tools/ai-config/:id", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.aiModelConfigs.findIndex((item) => item.id === req.params.id && item.ownerId === req.user!.id);
  if (index < 0) {
    res.status(404).json({ message: "配置不存在或无权删除" });
    return;
  }
  store.aiModelConfigs.splice(index, 1);
  await store.persist();
  const config = getAiConfig(req.user!);
  res.json({ config: config ? publicAiConfig(config) : null, configs: getAiConfigs(req.user!).map(publicAiConfig) });
}));

app.post("/api/tools/ai-config/test", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ id: z.string().min(1).max(64).optional() });
  const body = schema.parse(req.body || {});
  const config = body.id
    ? getStore().aiModelConfigs.find((item) => item.id === body.id && item.ownerId === req.user!.id) || null
    : getAiConfig(req.user!);
  if (!config || !config.baseUrl || !config.model) {
    res.status(400).json({ message: "请先保存模型地址和模型名称" });
    return;
  }
  if (!config.apiKey) {
    res.status(400).json({ message: "请先填写 API Key；系统不会在页面明文回显密钥" });
    return;
  }
  const result = await testAiConfig(config);
  config.lastTestAt = new Date().toISOString();
  config.lastTestStatus = result.ok ? "passed" : "failed";
  config.lastTestMessage = result.message;
  config.updatedAt = new Date().toISOString();
  await getStore().persist();
  res.json({ ok: result.ok, message: result.message, config: publicAiConfig(config), configs: getAiConfigs(req.user!).map(publicAiConfig) });
}));

const leadFinderSearchSchema = z.object({
  productKeywords: z.string().default(""),
  countries: z.string().default(""),
  industry: z.string().default(""),
  customerType: z.string().default(""),
  goal: z.string().default(""),
  limit: z.number().min(1).max(30).default(10)
});

app.post("/api/lead-finder/free-search", requireAuth, asyncRoute(async (req, res) => {
  const body = leadFinderSearchSchema.parse(req.body);
  const store = getStore();
  const limit = Math.min(body.limit, 12);
  const [gleif, wikidata] = await Promise.all([
    searchGleifLeads(body, req.user!, Math.ceil(limit / 2)),
    searchWikidataLeads(body, req.user!, Math.ceil(limit / 2))
  ]);
  const merged: WebsiteOpportunity[] = [];
  for (const item of [...gleif, ...wikidata]) {
    if (merged.some((row) => row.company.toLowerCase() === item.company.toLowerCase() || row.website === item.website)) continue;
    merged.push(item);
  }
  for (const item of merged) {
    const existing = store.websiteOpportunities.find((row) => row.ownerId === req.user!.id && (row.website === item.website || row.company.toLowerCase() === item.company.toLowerCase()));
    if (existing) Object.assign(existing, item, { id: existing.id, status: existing.status, customerId: existing.customerId, dealId: existing.dealId, leadId: existing.leadId });
    else store.websiteOpportunities.unshift(item);
  }
  await store.persist();
  res.json({ opportunities: merged, sources: { gleif: gleif.length, wikidata: wikidata.length } });
}));

// ---------------------------------------------------------------------------
// 自动获客 · 数据源中心（Provider 注册表 + 用户 Key 配置 + 统一搜索）
// ---------------------------------------------------------------------------

function getLeadSourceConfig(user: SessionUser, provider: string): LeadSourceConfig | undefined {
  return getStore().leadSourceConfigs.find((item) => item.provider === provider && item.ownerId === user.id);
}

function publicLeadSourceConfig(config: LeadSourceConfig) {
  return {
    id: config.id,
    provider: config.provider,
    scope: config.scope,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(config.apiKey),
    baseUrl: config.baseUrl || "",
    enabled: config.enabled,
    lastTestAt: config.lastTestAt || "",
    lastTestStatus: config.lastTestStatus || "untested",
    lastTestMessage: config.lastTestMessage || "",
    usage: config.usageJson || "",
    updatedAt: config.updatedAt
  };
}

function providerStatusFor(user: SessionUser, provider: LeadProvider) {
  const config = getLeadSourceConfig(user, provider.id);
  const hasKey = !provider.requiresKey || Boolean(config?.apiKey);
  const enabled = provider.requiresKey ? Boolean(config?.enabled && config?.apiKey) : config ? config.enabled : true;
  return {
    ...providerMeta(provider),
    hasApiKey: Boolean(config?.apiKey),
    ready: hasKey,
    enabled,
    lastTestStatus: config?.lastTestStatus || (provider.requiresKey ? "untested" : "passed"),
    lastTestMessage: config?.lastTestMessage || "",
    lastTestAt: config?.lastTestAt || "",
    usage: config?.usageJson || ""
  };
}

// AI 搜索作为一种数据源：不需要独立 API Key，直接复用「AI 模型配置」里已启用且勾选自动获客的模型
function aiSearchStatus(user: SessionUser) {
  const config = getAiConfig(user, "leadFinder");
  const ready = Boolean(config?.enabled && config?.apiKey && config?.useLeadFinder);
  return {
    id: "ai_search",
    name: "AI 搜索",
    tier: "ai" as const,
    category: "ai" as const,
    requiresKey: false,
    capabilities: ["ai", "company"],
    docsUrl: "",
    keyHint: "使用「AI 模型配置」中已启用并勾选自动获客的模型，无需在此另填 Key。",
    defaultBaseUrl: "",
    costNote: "调用你配置的 AI 模型直接生成候选公司，结果需人工核实。",
    hasApiKey: ready,
    ready,
    enabled: ready,
    lastTestStatus: ready ? "passed" : "untested",
    lastTestMessage: ready ? `当前模型：${config?.model || "已配置"}` : "请先在「AI 模型配置」启用模型并勾选“自动获客”",
    lastTestAt: config?.lastTestAt || "",
    usage: ""
  };
}

function allProviderStatuses(user: SessionUser) {
  return [aiSearchStatus(user), ...LEAD_PROVIDERS.map((provider) => providerStatusFor(user, provider))];
}

app.get("/api/lead-finder/providers", requireAuth, (req, res) => {
  res.json({ providers: allProviderStatuses(req.user!) });
});

app.post("/api/lead-finder/source-config", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({
    provider: z.string().min(1).max(40),
    apiKey: z.string().max(400).optional().default(""),
    baseUrl: z.string().max(255).optional().default(""),
    enabled: z.boolean().optional().default(false)
  });
  const body = schema.parse(req.body);
  const provider = getProvider(body.provider);
  if (!provider) {
    res.status(404).json({ message: "未知数据源" });
    return;
  }
  const store = getStore();
  const existing = getLeadSourceConfig(req.user!, body.provider);
  const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : existing?.apiKey || "";
  if (provider.requiresKey && body.enabled && !apiKey) {
    res.status(400).json({ message: "启用前请先填写该数据源的 API Key" });
    return;
  }
  const config: LeadSourceConfig = {
    id: existing?.id || `ls_${provider.id}_${req.user!.id}_${Date.now()}`,
    provider: provider.id,
    scope: "personal",
    apiKey,
    baseUrl: body.baseUrl || existing?.baseUrl || "",
    enabled: body.enabled,
    lastTestAt: existing?.lastTestAt,
    lastTestStatus: existing?.lastTestStatus || "untested",
    lastTestMessage: existing?.lastTestMessage || "",
    usageJson: existing?.usageJson,
    ownerId: req.user!.id,
    teamId: req.user!.teamId,
    updatedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, config);
  else store.leadSourceConfigs.unshift(config);
  await store.persist();
  res.json({ config: publicLeadSourceConfig(config), providers: allProviderStatuses(req.user!) });
}));

app.post("/api/lead-finder/source-config/test", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ provider: z.string().min(1).max(40) });
  const body = schema.parse(req.body);
  const provider = getProvider(body.provider);
  if (!provider) {
    res.status(404).json({ message: "未知数据源" });
    return;
  }
  const store = getStore();
  const config = getLeadSourceConfig(req.user!, provider.id);
  if (provider.requiresKey && !config?.apiKey) {
    res.status(400).json({ message: "请先保存该数据源的 API Key，再测试连接" });
    return;
  }
  let result;
  try {
    result = await provider.test({ apiKey: config?.apiKey || "", baseUrl: config?.baseUrl });
  } catch (error) {
    result = { ok: false, message: `连接异常：${error instanceof Error ? error.message : "未知错误"}` };
  }
  if (config) {
    config.lastTestAt = new Date().toISOString();
    config.lastTestStatus = result.ok ? "passed" : "failed";
    config.lastTestMessage = result.message;
    if (result.usage) config.usageJson = result.usage;
    config.updatedAt = new Date().toISOString();
    await store.persist();
  }
  res.json({ ok: result.ok, message: result.message, usage: result.usage || "", providers: allProviderStatuses(req.user!) });
}));

app.delete("/api/lead-finder/source-config/:provider", requireAuth, asyncRoute(async (req, res) => {
  const store = getStore();
  const index = store.leadSourceConfigs.findIndex((item) => item.provider === req.params.provider && item.ownerId === req.user!.id);
  if (index < 0) {
    res.status(404).json({ message: "配置不存在或无权删除" });
    return;
  }
  store.leadSourceConfigs.splice(index, 1);
  await store.persist();
  res.json({ providers: allProviderStatuses(req.user!) });
}));

const leadSearchSchema = z.object({
  goal: z.string().default(""),
  productKeywords: z.string().default(""),
  countries: z.string().default(""),
  industry: z.string().default(""),
  customerType: z.string().default(""),
  excludeKeywords: z.string().default(""),
  sources: z.array(z.string()).default([]),
  useAi: z.boolean().default(false),
  limit: z.number().min(1).max(30).default(12)
});

app.post("/api/lead-finder/search", requireAuth, asyncRoute(async (req, res) => {
  const body = leadSearchSchema.parse(req.body);
  const store = getStore();
  const user = req.user!;
  const query: LeadQuery = {
    goal: body.goal,
    productKeywords: body.productKeywords,
    countries: body.countries,
    industry: body.industry,
    customerType: body.customerType,
    excludeKeywords: body.excludeKeywords,
    limit: Math.min(body.limit, 15)
  };

  // 选中源 ∩ 已启用 ∩ (有 key)。免费源无 key 也可用；未选中时默认用免费源兜底。
  const chosen = body.sources.length
    ? LEAD_PROVIDERS.filter((provider) => body.sources.includes(provider.id))
    : LEAD_PROVIDERS.filter((provider) => !provider.requiresKey);
  const runnable = chosen.filter((provider) => {
    if (!provider.requiresKey) return true;
    const config = getLeadSourceConfig(user, provider.id);
    return Boolean(config?.apiKey && config.enabled);
  });
  const skipped = chosen.filter((provider) => !runnable.includes(provider)).map((provider) => provider.name);
  // 用户明确选了源（哪怕只选 AI 搜索）就不再兜底跑免费源；完全没选时才用免费源兜底
  const activeProviders = runnable.length ? runnable : (body.sources.length ? [] : LEAD_PROVIDERS.filter((provider) => !provider.requiresKey));
  const wantsAiSearch = body.sources.includes("ai_search");

  const searchProviders = activeProviders.filter((provider) => provider.category !== "email");
  const emailProviders = activeProviders.filter((provider) => provider.category === "email" && provider.enrich);

  const sourceStats: Array<{ id: string; name: string; count: number; error?: string; usage?: string }> = [];
  const collected: Array<RawLead & { source: string; sourceLabel: string }> = [];

  await Promise.all(searchProviders.map(async (provider) => {
    const config = getLeadSourceConfig(user, provider.id);
    try {
      const result = await provider.search(query, { apiKey: config?.apiKey || "", baseUrl: config?.baseUrl });
      for (const lead of result.leads) {
        if (!lead.company) continue;
        collected.push({ ...lead, source: provider.id, sourceLabel: provider.name });
      }
      sourceStats.push({ id: provider.id, name: provider.name, count: result.leads.length, usage: result.usage });
    } catch (error) {
      sourceStats.push({ id: provider.id, name: provider.name, count: 0, error: error instanceof Error ? error.message : "调用失败" });
    }
  }));

  // AI 搜索：用「AI 模型配置」里已启用并勾选自动获客的模型直接生成候选公司
  if (wantsAiSearch) {
    const aiSearchConfig = getAiConfig(user, "leadFinder");
    if (aiSearchConfig?.enabled && aiSearchConfig.apiKey && aiSearchConfig.useLeadFinder) {
      try {
        const aiLeads = await aiGenerateLeads(query, aiSearchConfig);
        for (const lead of aiLeads) {
          if (!lead.company) continue;
          collected.push({ ...lead, source: "ai_search", sourceLabel: "AI 搜索" });
        }
        sourceStats.push({ id: "ai_search", name: "AI 搜索", count: aiLeads.length });
      } catch (error) {
        sourceStats.push({ id: "ai_search", name: "AI 搜索", count: 0, error: error instanceof Error ? error.message : "AI 调用失败" });
      }
    } else {
      skipped.push("AI 搜索（未启用模型）");
    }
  }

  // 去重（域名 + 公司名）
  const deduped: Array<RawLead & { source: string; sourceLabel: string }> = [];
  for (const lead of collected) {
    const domain = websiteDomainKey(lead.website || "");
    const key = domain || lead.company.toLowerCase();
    if (deduped.some((row) => (domain && websiteDomainKey(row.website || "") === domain) || row.company.toLowerCase() === lead.company.toLowerCase())) continue;
    deduped.push(lead);
  }

  // Web 源结果做官网解析补全（best-effort，限量控制耗时）
  const aiConfig = body.useAi ? getAiConfig(user, "websiteParse") : null;
  const parseTargets = deduped.filter((lead) => ["serper", "brave", "serpapi", "ai_search"].includes(lead.source) && lead.website).slice(0, 6);
  await Promise.all(parseTargets.map(async (lead) => {
    try {
      const parsed = await parseWebsiteOpportunity(lead.website!, 0, user, aiConfig);
      if (parsed.company && !/unknown/i.test(parsed.company)) lead.company = parsed.company;
      if (parsed.business && parsed.business !== "待维护") lead.business = parsed.business;
      if (parsed.country && parsed.country !== "未知") lead.country = parsed.country;
      if (parsed.contact && parsed.contact !== "待维护") lead.contact = parsed.contact;
      if (parsed.contactInfo && parsed.contactInfo !== "待维护") lead.contactInfo = parsed.contactInfo;
      if (parsed.description) lead.description = parsed.description;
      if (parsed.parseMode === "ai") lead.confidence = Math.max(lead.confidence || 60, 74);
    } catch {
      // 解析失败保留搜索摘要
    }
  }));

  // 邮箱源补全（Hunter 等）：对缺联系方式且有域名的候选补邮箱
  for (const provider of emailProviders) {
    const config = getLeadSourceConfig(user, provider.id);
    const targets = deduped.filter((lead) => !lead.contactInfo && websiteDomainKey(lead.website || "")).slice(0, 8);
    let filled = 0;
    for (const lead of targets) {
      const enriched = await provider.enrich!(websiteDomainKey(lead.website || ""), { apiKey: config?.apiKey || "", baseUrl: config?.baseUrl });
      if (enriched?.contactInfo) {
        lead.contactInfo = enriched.contactInfo;
        if (enriched.contact) lead.contact = enriched.contact;
        lead.confidence = Math.max(lead.confidence || 60, 74);
        filled += 1;
      }
    }
    sourceStats.push({ id: provider.id, name: provider.name, count: filled });
  }

  // 落库为 WebsiteOpportunity
  const now = Date.now();
  const opportunities: WebsiteOpportunity[] = deduped.slice(0, query.limit * 2).map((lead, index) => ({
    id: `lf_${lead.source}_${now}_${index}`,
    company: lead.company,
    business: lead.business || "待维护",
    country: lead.country || "未知",
    website: normalizeWebsite(lead.website || ""),
    contact: lead.contact || "待维护",
    contactInfo: lead.contactInfo || "",
    description: lead.description || "自动获客候选，待核实。",
    ownerId: user.id,
    teamId: user.teamId,
    status: "preview",
    createdAt: new Date().toISOString(),
    parseMode: aiConfig ? "ai" : "rule",
    source: lead.source,
    sourceLabel: lead.sourceLabel,
    confidence: lead.confidence
  }));

  for (const item of opportunities) {
    const existing = store.websiteOpportunities.find((row) => row.ownerId === user.id && (row.website === item.website || row.company.toLowerCase() === item.company.toLowerCase()));
    if (existing) Object.assign(existing, item, { id: existing.id, status: existing.status, customerId: existing.customerId, dealId: existing.dealId, leadId: existing.leadId });
    else store.websiteOpportunities.unshift(item);
  }
  await store.persist();
  res.json({ opportunities, sourceStats, skipped, providersUsed: activeProviders.map((provider) => provider.id) });
}));

function websiteDomainKey(raw: string) {
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }
}

app.post("/api/tools/website-scrape/preview", requireAuth, asyncRoute(async (req, res) => {
  const schema = z.object({ urls: z.array(z.string().min(3)).min(1).max(12), useAi: z.boolean().default(false) });
  const body = schema.parse(req.body);
  const store = getStore();
  const aiConfig = body.useAi ? getAiConfig(req.user!, "websiteParse") : null;
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
  const created: Array<{ lead: Lead; sourceEvent: LeadSourceEvent; opportunity: WebsiteOpportunity; duplicate: boolean }> = [];
  for (const source of body.opportunities) {
    const contact = source.contact || source.contactInfo || "待维护";
    const sourceId = source.id || `website_${websiteDomainKey(source.website)}_${normalizedMatchText(source.company)}`;
    const intake = createLeadFromSource(req.user!, {
      company: source.company,
      contact,
      country: source.country || "未知",
      email: source.contactInfo.includes("@") ? source.contactInfo.trim() : "",
      phone: source.contactInfo.includes("@") ? "" : source.contactInfo.trim(),
      wechat: "",
      source: "官网解析",
      sourceType: "outbound",
      sourceChannel: "website-scrape",
      sourceCampaign: "",
      externalId: sourceId,
      sourceUrl: normalizeWebsite(source.website),
      intent: "中",
      stage: "新线索",
      estimatedAmount: 0,
      nextFollowAt: "",
      remark: [source.business, source.description].filter(Boolean).join("；"),
      rawPayload: source
    });
    const opportunity: WebsiteOpportunity = {
      id: sourceId,
      company: source.company,
      business: source.business || "待维护",
      country: source.country || "未知",
      website: normalizeWebsite(source.website),
      contact,
      contactInfo: source.contactInfo || "",
      description: source.description || "已加入线索中心，下一步核实采购负责人和真实采购需求。",
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      status: "synced",
      createdAt: new Date().toISOString(),
      leadId: intake.lead.id,
      parseMode: "rule"
    };
    const existing = store.websiteOpportunities.find((item) => item.id === opportunity.id || (item.ownerId === req.user!.id && item.website === opportunity.website));
    if (existing) Object.assign(existing, opportunity, { id: existing.id });
    else store.websiteOpportunities.unshift(opportunity);
    created.push({ ...intake, opportunity: existing || opportunity });
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
  const scopedDeals = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && !deal.archivedAt);
  const scopedReminders = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
  const scopedKnowledge = req.user?.role === "sales" ? knowledgeAssets.filter((asset) => asset.ownerId === req.user?.id) : knowledgeAssets;
  const scopedMessages = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
  const scopedExams = exams.filter((exam) => canAccessExam(req.user!, exam));
  const scopedExamReport = examReport(req.user!);
  const activeTodos = scopedTodos.filter((todo) => !isHistoricalTodo(todo));
  const pendingTodos = activeTodos.filter((todo) => !todo.done);
  const overdueTodos = pendingTodos.filter((todo) => todo.priority === "high");
  const historyTodos = scopedTodos.filter(isHistoricalTodo);
  const riskCustomers = scopedCustomers.filter((customer) => customer.nextReminder.includes("逾期") || customer.health < 60);
  const riskAmount = riskCustomers.reduce((sum, customer) => sum + customer.amount, 0);
  const forecastAmount = scopedDeals.reduce((sum, deal) => sum + deal.amount, 0) || scopedCustomers.reduce((sum, customer) => sum + customer.amount, 0);
  const wecomBound = scopedCustomers.filter((customer) => customer.wecomBound).length;
  const pendingKnowledge = scopedKnowledge.filter((asset) => asset.status !== "published");
  const publishedExams = scopedExams.filter((exam) => exam.status === "published");
  const averagePassRate = scopedExamReport.totalAttempts ? Math.round((scopedExamReport.passedAttempts / scopedExamReport.totalAttempts) * 100) : 0;
  const pendingMessages = scopedMessages.filter((message) => message.status === "pending");
  const readyDeals = scopedDeals.filter((deal) => ["已报价", "样品", "谈判"].includes(deal.stage));
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
      unfinishedExams: canManageTraining(req.user) ? scopedExams.filter((exam) => exam.status !== "published").length : scopedExams.filter((exam) => exam.status === "published" && !store.examAttempts.some((attempt) => attempt.examId === exam.id && attempt.userId === req.user!.id && attempt.passed)).length,
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
  const scopedDeals = store.deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && !deal.archivedAt);
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
    .filter((deal) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单")
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
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判", "成交"];
  const activeDeals = deals.filter((deal) => !deal.archivedAt && deal.stage !== "丢单");
  const maxCount = Math.max(...stages.map((stage) => activeDeals.filter((deal) => deal.stage === stage).length), 1);
  return stages.map((stage) => {
    const stageDeals = activeDeals.filter((deal) => deal.stage === stage);
    const amount = stageDeals.reduce((sum, deal) => sum + deal.amount, 0);
    const riskCount = stageDeals.filter((deal) => {
      const customer = customers.find((item) => item.id === deal.customerId);
      return Boolean(customer?.nextReminder.includes("逾期")) || (customer?.health ?? 100) < 60;
    }).length;
    return {
      stage,
      count: stageDeals.length,
      amount,
      riskCount,
      width: stageDeals.length ? Math.max(8, Math.round((stageDeals.length / maxCount) * 100)) : 0,
      tone: riskCount ? "amber" : stage === "成交" ? "green" : "aqua"
    };
  });
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

function reminderRuleTitle(ruleType = "quote_no_reply") {
  const map: Record<string, string> = {
    quote_no_reply: "报价后未回复提醒",
    sample_feedback: "样品反馈提醒",
    inactive_customer: "长期未联系提醒",
    high_value_revisit: "高价值客户复访",
    custom_due: "自定义跟进提醒"
  };
  return map[ruleType] || "自定义跟进提醒";
}

function reminderRuleText(rule: { ruleType?: string; targetStage?: string; days?: number; channel?: string; priority?: string }) {
  const days = rule.days ?? 3;
  const stage = rule.targetStage || "已报价";
  const channel = rule.channel || "企业微信";
  if (rule.ruleType === "sample_feedback") return `客户阶段为样品，${days} 天内需要反馈，通过${channel}提醒`;
  if (rule.ruleType === "inactive_customer") return `${days} 天未推进且客户仍在${stage}阶段，通过${channel}提醒`;
  if (rule.ruleType === "high_value_revisit") return `金额较高或健康度偏低客户 ${days} 天复访，通过${channel}提醒`;
  if (rule.ruleType === "custom_due") return `${stage}阶段客户按指定时间提醒，通过${channel}提醒`;
  return `${stage}阶段客户报价后 ${days} 天未回复，通过${channel}提醒`;
}

function matchReminderRule(user: SessionUser, rule: { ruleType?: string; targetStage?: string; days?: number; priority?: string }) {
  const store = getStore();
  const scopedCustomers = store.customers.filter((customer) => canSeeOwner(user, customer.ownerId, customer.teamId));
  const stage = rule.targetStage || "已报价";
  const ruleType = rule.ruleType || "quote_no_reply";
  if (ruleType === "sample_feedback") return scopedCustomers.filter((customer) => customer.stage === "样品");
  if (ruleType === "inactive_customer") return scopedCustomers.filter((customer) => customer.stage === stage || customer.nextReminder.includes("逾期"));
  if (ruleType === "high_value_revisit") return scopedCustomers.filter((customer) => customer.amount >= 30000 || customer.health < 65);
  if (ruleType === "custom_due") return scopedCustomers.filter((customer) => customer.stage === stage);
  return scopedCustomers.filter((customer) => customer.stage === stage || customer.nextReminder.includes("逾期"));
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

type AiUseCase = "leadFinder" | "websiteParse" | "scoring" | "emailDraft" | "exam";
const AI_MODEL_TIMEOUT_MS = 120000;

function getAiConfigs(user: SessionUser) {
  return getStore().aiModelConfigs
    .filter((item) => item.ownerId === user.id)
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function configSupportsUseCase(config: AiModelConfig, useCase?: AiUseCase) {
  if (!useCase) return true;
  const map: Record<AiUseCase, keyof AiModelConfig> = {
    leadFinder: "useLeadFinder",
    websiteParse: "useWebsiteParse",
    scoring: "useScoring",
    emailDraft: "useEmailDraft",
    exam: "useExam"
  };
  return Boolean(config[map[useCase]]);
}

function getAiConfig(user: SessionUser, useCase?: AiUseCase) {
  const configs = getAiConfigs(user);
  return configs.find((item) => item.enabled && item.apiKey && configSupportsUseCase(item, useCase))
    || configs.find((item) => configSupportsUseCase(item, useCase))
    || configs[0]
    || null;
}

function publicAiConfig(config: AiModelConfig) {
  return {
    id: config.id,
    provider: config.provider,
    protocol: config.protocol || "openai-compatible",
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : "",
    hasApiKey: Boolean(config.apiKey),
    enabled: config.enabled,
    temperature: config.temperature ?? 0.1,
    useLeadFinder: config.useLeadFinder ?? true,
    useWebsiteParse: config.useWebsiteParse ?? true,
    useScoring: config.useScoring ?? true,
    useEmailDraft: config.useEmailDraft ?? true,
    useExam: config.useExam ?? false,
    lastTestAt: config.lastTestAt || "",
    lastTestStatus: config.lastTestStatus || "untested",
    lastTestMessage: config.lastTestMessage || "",
    ownerId: config.ownerId,
    teamId: config.teamId,
    updatedAt: config.updatedAt
  };
}

async function testAiConfig(config: AiModelConfig) {
  try {
    const content = await callAiModel(config, "只返回 JSON：{\"ok\":true}", 1200);
    const ok = /ok|true/i.test(content);
    return {
      ok,
      message: ok ? `${providerLabel(config.provider)} 连接测试通过` : "模型已响应，但返回内容不符合测试格式"
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `AI 连接失败：${error.message}` : "AI 连接失败，请检查 Base URL / Key / Model"
    };
  }
}

function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Claude",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    qwen: "通义千问",
    moonshot: "Kimi",
    zhipu: "智谱GLM",
    baidu: "百度千帆",
    volcengine: "豆包",
    mistral: "Mistral",
    groq: "Groq",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    custom: "自定义模型"
  };
  return labels[provider] || provider || "AI模型";
}

function normalizeWebsite(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function leadFinderQueryText(body: z.infer<typeof leadFinderSearchSchema>) {
  return [body.goal, body.productKeywords, body.industry, body.customerType, body.countries]
    .join(" ")
    .replace(/[,，/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchGleifLeads(body: z.infer<typeof leadFinderSearchSchema>, user: SessionUser, limit: number): Promise<WebsiteOpportunity[]> {
  const firstCountry = body.countries.split(/,|，/)[0]?.trim();
  const firstIndustry = body.industry.split(/,|，/)[0]?.trim();
  const firstProduct = body.productKeywords.split(/,|，/)[0]?.trim();
  const queryCandidates = [
    leadFinderQueryText(body),
    [firstIndustry, firstCountry].filter(Boolean).join(" "),
    [firstProduct, firstCountry].filter(Boolean).join(" "),
    [body.customerType, firstCountry].filter(Boolean).join(" "),
    firstIndustry || firstProduct || firstCountry || "automation"
  ].filter(Boolean);
  try {
    let records: Array<{
      id?: string;
      attributes?: {
        lei?: string;
        entity?: {
          legalName?: { name?: string };
          legalAddress?: { country?: string; city?: string };
          headquartersAddress?: { country?: string; city?: string };
        };
      };
    }> = [];
    for (const query of queryCandidates) {
      const url = `https://api.gleif.org/api/v1/lei-records?filter[fulltext]=${encodeURIComponent(query)}&page[size]=${limit}`;
      const response = await fetch(url, { headers: { accept: "application/vnd.api+json" } });
      if (!response.ok) continue;
      const data = await response.json() as { data?: typeof records };
      records = data.data || [];
      if (records.length) break;
    }
    return records.slice(0, limit).map((item, index) => {
      const entity = item.attributes?.entity;
      const company = entity?.legalName?.name || `GLEIF Entity ${index + 1}`;
      const country = entity?.legalAddress?.country || entity?.headquartersAddress?.country || body.countries.split(/,|，/)[0]?.trim() || "未知";
      const city = entity?.legalAddress?.city || entity?.headquartersAddress?.city || "";
      const lei = item.attributes?.lei || item.id || "";
      return {
        id: `lf_gleif_${Date.now()}_${index}`,
        company,
        business: body.productKeywords || body.industry || "法人实体 / 待核实业务",
        country,
        website: lei ? `https://search.gleif.org/#/record/${lei}` : "https://search.gleif.org/",
        contact: "待维护",
        contactInfo: "",
        description: `GLEIF公开法人实体。${city ? `城市：${city}。` : ""}需继续核实官网、采购角色和产品匹配。`,
        ownerId: user.id,
        teamId: user.teamId,
        status: "preview" as const,
        createdAt: new Date().toISOString(),
        parseMode: "rule" as const
      };
    });
  } catch {
    return [];
  }
}

async function searchWikidataLeads(body: z.infer<typeof leadFinderSearchSchema>, user: SessionUser, limit: number): Promise<WebsiteOpportunity[]> {
  const firstCountry = body.countries.split(/,|，/)[0]?.trim();
  const firstIndustry = body.industry.split(/,|，/)[0]?.trim();
  const firstProduct = body.productKeywords.split(/,|，/)[0]?.trim();
  const queryCandidates = [
    leadFinderQueryText(body),
    [firstProduct, firstIndustry, firstCountry].filter(Boolean).join(" "),
    [firstIndustry, "company"].filter(Boolean).join(" "),
    firstProduct || firstIndustry || "instrumentation company"
  ].filter(Boolean);
  try {
    let records: Array<{ id?: string; label?: string; description?: string; concepturi?: string }> = [];
    for (const query of queryCandidates) {
      const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&format=json&type=item&limit=${limit}&search=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const data = await response.json() as { search?: typeof records };
      records = data.search || [];
      if (records.length) break;
    }
    return records
      .filter((item) => item.label)
      .slice(0, limit)
      .map((item, index) => ({
        id: `lf_wikidata_${Date.now()}_${index}`,
        company: item.label || `Wikidata Entity ${index + 1}`,
        business: body.productKeywords || body.industry || item.description || "公开实体 / 待核实业务",
        country: body.countries.split(/,|，/)[0]?.trim() || "未知",
        website: item.concepturi || (item.id ? `https://www.wikidata.org/wiki/${item.id}` : "https://www.wikidata.org/"),
        contact: "待维护",
        contactInfo: "",
        description: `Wikidata公开实体：${item.description || "描述待补充"}。需继续核实官网、联系人和真实采购意向。`,
        ownerId: user.id,
        teamId: user.teamId,
        status: "preview" as const,
        createdAt: new Date().toISOString(),
        parseMode: "rule" as const
      }));
  } catch {
    return [];
  }
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
  if (!aiConfig?.enabled || !aiConfig.apiKey || !aiConfig.useWebsiteParse) return ruleResult;
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

async function aiGenerateLeads(query: LeadQuery, config: AiModelConfig): Promise<RawLead[]> {
  const n = Math.min(query.limit, 12);
  const prompt = [
    "你是资深外贸获客研究助手。根据下面的客户画像，列出真实、可能存在的目标公司（分销商/系统集成商/OEM/EPC/MRO/终端工厂/贸易商等）。",
    "严格只返回 JSON，不要解释、不要 Markdown。",
    "JSON 结构：{\"companies\":[{\"company\":\"\",\"website\":\"\",\"country\":\"\",\"business\":\"\",\"description\":\"\"}]}",
    "要求：",
    "1. 只给你有把握真实存在的公司；website 用你所知的官网域名，不确定就留空字符串，绝不编造域名。",
    "2. 绝不编造邮箱、电话或联系人。",
    "3. business 聚焦公司产品/业务方向；description 用一句话说明为何匹配画像。",
    `目标公司数量：${n}`,
    `产品/关键词：${query.productKeywords || "未指定"}`,
    `国家/地区：${query.countries || "未指定"}`,
    `行业/场景：${query.industry || "未指定"}`,
    `客户类型：${query.customerType || "未指定"}`,
    `获客目标：${query.goal || "未指定"}`,
    `排除：${query.excludeKeywords || "无"}`
  ].join("\n");
  const content = await callAiModel(config, prompt, 4000);
  const parsed = extractJsonObject(content) as { companies?: unknown };
  const companies = Array.isArray(parsed.companies) ? parsed.companies : [];
  return companies
    .slice(0, n)
    .map((raw): RawLead => {
      const item = (raw || {}) as Record<string, unknown>;
      const firstCountry = query.countries.split(/,|，/)[0]?.trim() || "未知";
      const detail = String(item.description || "").trim();
      return {
        company: String(item.company || "").trim(),
        website: String(item.website || "").trim(),
        country: String(item.country || firstCountry).trim(),
        business: String(item.business || query.productKeywords || "待核实业务").trim(),
        contact: "待维护",
        contactInfo: "",
        description: `${detail}${detail ? "（AI 生成，待核实）" : "AI 生成候选，待核实。"}`,
        confidence: 58
      };
    })
    .filter((lead) => lead.company);
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
  const protocol = config.protocol || "openai-compatible";
  const endpointBase = config.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_MODEL_TIMEOUT_MS);
  try {
    if (protocol === "anthropic") {
      const endpoint = `${endpointBase}/messages`;
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 800,
          temperature: config.temperature ?? 0.1,
          system: "你擅长把官网公开信息整理成外贸CRM商机。输出必须可被 JSON.parse 解析。",
          messages: [{ role: "user", content: prompt.slice(0, maxInputChars) }]
        })
      });
      const data = await readAiJson<{ content?: Array<{ type?: string; text?: string }> }>(response, endpoint);
      const content = data.content?.map((item) => item.text || "").join("\n").trim() || "";
      if (!content) throw new Error("模型返回为空");
      return content;
    }
    if (protocol === "gemini") {
      const endpoint = `${endpointBase}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generationConfig: { temperature: config.temperature ?? 0.1 },
          contents: [{
            role: "user",
            parts: [{ text: `你擅长把官网公开信息整理成外贸CRM商机。输出必须可被 JSON.parse 解析。\n${prompt.slice(0, maxInputChars)}` }]
          }]
        })
      });
      const data = await readAiJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(response, endpoint);
      const content = data.candidates?.[0]?.content?.parts?.map((item) => item.text || "").join("\n").trim() || "";
      if (!content) throw new Error("模型返回为空");
      return content;
    }
    const endpoint = `${endpointBase}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature ?? 0.1,
        messages: [
          { role: "system", content: "你擅长把官网公开信息整理成外贸CRM商机。输出必须可被 JSON.parse 解析。" },
          { role: "user", content: prompt.slice(0, maxInputChars) }
        ],
        response_format: { type: "json_object" }
      })
    });
    const data = await readAiJson<{ choices?: Array<{ message?: { content?: string } }> }>(response, endpoint);
    const content = data.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("模型返回为空");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function readAiJson<T>(response: globalThis.Response, endpoint: string): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
    if (contentType.includes("text/html") || text.trim().startsWith("<")) {
      throw new Error(`接口返回 HTML 页面而不是 JSON。请检查 Base URL 是否填到了 API 地址，例如 OpenAI 兼容接口通常需要以 /v1 结尾；当前请求：${endpoint}`);
    }
    throw new Error(`接口返回内容不是 JSON：${preview || "空响应"}`);
  }
  if (!response.ok) {
    const providerMessage = data?.error?.message || data?.message || "";
    const providerType = data?.error?.type || data?.error?.code || "";
    const suffix = providerMessage ? `：${providerMessage}${providerType ? `（${providerType}）` : ""}` : "";
    throw new Error(`HTTP ${response.status}${suffix}`);
  }
  return data as T;
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
  const mysqlRequested = process.env.CRM_STORE === "mysql" || Boolean(process.env.DATABASE_URL || process.env.MYSQL_URL);
  if (mysqlRequested) {
    try {
      const store = await createMysqlStore();
      setStore(store);
      console.log("GoodJob CRM using MySQL persistence");
    } catch (error) {
      console.error(`GoodJob CRM MySQL unavailable, startup aborted: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
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
