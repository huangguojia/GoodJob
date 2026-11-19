/**
 * 资料库、题库、考试路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, isPlatformIdentity, requireAuth } from "../auth.js";
import { emptyEventCounts, getResourceHubRepository, knowledgeAssetTeamId } from "../resource-hub.js";
import { getKnowledgeGovernanceRepository, normalizeVocabularyValue } from "../knowledge-governance.js";
import { type Exam, type ExamAssignment, type ExamAttempt, type ExamQuestion, type Order, type OrderFile, type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import {
  asyncRoute,
  bankQuestions,
  canAccessExam,
  canManageTraining,
  canSeeKnowledgeAsset,
  canUseExamQuestion,
  examQuestionsFor,
  examReport,
  isSubmittedExamAttempt,
  knowledgeQualityFlags,
  normalizeKnowledgeSource,
  orderVisible,
  recordResourceHubEvents
} from "../server-core.js";

function canEditKnowledgeAsset(user: SessionUser, asset: ReturnType<typeof getStore>["knowledgeAssets"][number]) {
  const teamId = knowledgeAssetTeamId(getStore(), asset);
  if (teamId !== user.teamId || isPlatformIdentity(user)) return false;
  if (asset.ownerId === user.id) return true;
  return canManageTraining(user) && canSeeOwner(user, asset.ownerId, teamId);
}

const knowledgeFileTypes = ["pdf", "word", "excel", "image", "video", "archive", "link", "other"] as const;

const knowledgeAssetInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).default("产品知识"),
  version: z.string().trim().min(1).max(40).default("v1"),
  sourceUrl: z.string().trim().min(1).max(2048),
  shareCode: z.string().trim().max(64).optional().default(""),
  fileType: z.enum(knowledgeFileTypes).default("other"),
  description: z.string().trim().max(2000).optional().default(""),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional().default([]),
  /** 人工校订标记：仅 training.manage 可置 1（两池分层依据，默认 0）。 */
  verified: z.boolean().optional()
});

/** 词表近似建议：供「类目不在词表」时给用户「是不是想选这个」。 */
function knowledgeVocabularySuggestions(
  entries: Array<{ value: string; normalized: string; enabled: boolean }>,
  value: string,
  limit = 5
) {
  const target = normalizeVocabularyValue(value);
  const targetChars = new Set([...target]);
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const entryChars = new Set([...entry.normalized]);
      let score = entry.normalized.includes(target) || target.includes(entry.normalized) ? 2 : 0;
      const overlap = [...targetChars].filter((ch) => entryChars.has(ch)).length;
      score += overlap / Math.max(1, Math.max(entryChars.size, targetChars.size));
      return { value: entry.value, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.value);
}

/**
 * 查重：同团队内按归一化 URL（主键）或标题（次键）找已有资料。
 *
 * 不建表 —— knowledgeAssets 在内存 store 里，现算成本为零，还避免第二处真相。
 * 与训练库指纹（training-library-service.ts）同思想，只是不落库。
 */
function findKnowledgeDuplicate(
  store: ReturnType<typeof getStore>,
  teamId: string,
  input: { sourceUrl?: string; title?: string },
  excludeId?: string
) {
  const normalizedUrl = String(input.sourceUrl || "").trim().toLowerCase();
  const normalizedTitle = normalizeVocabularyValue(input.title || "");
  const scoped = store.knowledgeAssets.filter(
    (item) => item.id !== excludeId && item.status !== "archived" && knowledgeAssetTeamId(store, item) === teamId
  );
  const sameUrl = normalizedUrl
    ? scoped.find((item) => String(item.sourceUrl || "").trim().toLowerCase() === normalizedUrl)
    : undefined;
  const sameTitle = normalizedTitle.length >= 4
    ? scoped.find((item) => normalizeVocabularyValue(item.title) === normalizedTitle)
    : undefined;
  return { sameUrl, sameTitle };
}

/**
 * 类目校验：必须命中词表。返回 { ok, entry?, created?, suggestions }。
 *
 * `allowCreate` = 调用方有 training.manage。把关人自己录入时允许隐式扩词表
 * （否则新团队第一条资料被空词表拦死），但会把「新建了词条」返回给调用方提示；
 * 普通业务员只能从已有词表里选 —— 这才是「受控」的意义。
 */
async function validateKnowledgeCategory(teamId: string, category: string, allowCreate: boolean) {
  const repository = getKnowledgeGovernanceRepository();
  const entries = await repository.list(teamId, "category");
  const normalized = normalizeVocabularyValue(category);
  const hit = entries.find((entry) => entry.normalized === normalized && entry.enabled);
  if (hit) return { ok: true as const, entry: hit, created: false, suggestions: [] as string[] };
  const enabled = entries.filter((entry) => entry.enabled);
  if (allowCreate && !enabled.length) {
    // 词表整体为空：新团队的第一条资料，直接建条放行
    const entry = await repository.ensure(teamId, "category", category);
    return { ok: true as const, entry, created: true, suggestions: [] as string[] };
  }
  return {
    ok: false as const,
    entry: null,
    created: false,
    suggestions: enabled.length ? knowledgeVocabularySuggestions(entries, category) : []
  };
}

function canManageExam(user: SessionUser, exam: Exam) {
  return hasIamPermission(user, "training.manage") && exam.teamId === user.teamId;
}

function canManageExamQuestion(user: SessionUser, question: ExamQuestion) {
  return hasIamPermission(user, "training.manage") && question.teamId === user.teamId;
}

function requireTrainingManager(req: Request, res: Response) {
  if (canManageTraining(req.user)) return true;
  res.status(403).json({ message: "只有主管、管理员和超级管理员可以维护题库和考试" });
  return false;
}

function examQuestionsAtPublish(examId: string, user?: SessionUser) {
  const snapshot = getStore().examSnapshots.find((item) => item.examId === examId);
  const questions = snapshot?.questions?.length ? snapshot.questions : examQuestionsFor(examId, user);
  return user ? questions.filter((question) => canUseExamQuestion(user, question)) : questions;
}

function examRuntimeStatus(exam: Exam, now = new Date()) {
  if (exam.status === "closed") return "closed";
  if (exam.status !== "published") return "draft";
  if (exam.startAt && new Date(exam.startAt).getTime() > now.getTime()) return "upcoming";
  if (exam.endAt && new Date(exam.endAt).getTime() <= now.getTime()) return "expired";
  return "open";
}

function examAssignmentFor(examId: string, userId: string) {
  return getStore().examAssignments.find((item) => item.examId === examId && item.userId === userId);
}

function safeExamQuestion(question: ExamQuestion, includeReview: boolean) {
  return includeReview
    ? question
    : { ...question, answerIndex: -1, answerIndexes: [], explanation: "" };
}

function refreshExamAssignment(assignment: ExamAssignment) {
  const attempts = getStore().examAttempts
    .filter((item) => item.examId === assignment.examId && item.userId === assignment.userId && isSubmittedExamAttempt(item));
  const inProgress = getStore().examAttempts.find((item) => item.examId === assignment.examId && item.userId === assignment.userId && !isSubmittedExamAttempt(item));
  assignment.attemptCount = attempts.length;
  assignment.bestScore = attempts.length ? Math.max(...attempts.map((item) => item.score)) : 0;
  assignment.latestAttemptId = (inProgress || attempts[0])?.id || "";
  assignment.status = inProgress ? "in_progress" : attempts.some((item) => item.passed) ? "passed" : attempts.length ? "failed" : "pending";
  assignment.updatedAt = new Date().toISOString();
}

function gradeExamAttempt(exam: Exam, attempt: ExamAttempt, status: "submitted" | "auto_submitted") {
  const questions = examQuestionsAtPublish(exam.id);
  const correctCount = questions.filter((question) => {
    const rawAnswer = attempt.answers[question.id];
    const selectedIndexes = Array.isArray(rawAnswer) ? rawAnswer : rawAnswer == null ? [] : [rawAnswer];
    return indexesEqual(selectedIndexes, correctIndexesFor(question));
  }).length;
  const now = new Date().toISOString();
  attempt.correctCount = correctCount;
  attempt.totalQuestions = questions.length;
  attempt.score = questions.length ? Math.round((correctCount / questions.length) * 100) : 0;
  attempt.passed = attempt.score >= (exam.passScore || 80);
  attempt.status = status;
  attempt.submittedAt = now;
  attempt.updatedAt = now;
  const assignment = examAssignmentFor(exam.id, attempt.userId);
  if (assignment) refreshExamAssignment(assignment);
  refreshExamStats(exam);
  return attempt;
}

function expireExamAttemptIfNeeded(exam: Exam, attempt?: ExamAttempt | null) {
  if (!attempt || isSubmittedExamAttempt(attempt) || !attempt.expiresAt) return attempt || null;
  if (new Date(attempt.expiresAt).getTime() <= Date.now()) return gradeExamAttempt(exam, attempt, "auto_submitted");
  return attempt;
}

function examWithRuntimeStats(exam: Exam, user?: SessionUser) {
  const store = getStore();
  const questions = examQuestionsAtPublish(exam.id, user);
  const attempts = store.examAttempts.filter((attempt) => {
    if (attempt.examId !== exam.id) return false;
    if (!user) return true;
    if (!canManageTraining(user)) return attempt.userId === user.id;
    const owner = store.users.find((item) => item.id === attempt.userId);
    return Boolean(owner && canSeeOwner(user, owner.id, owner.teamId));
  });
  const submittedAttempts = attempts.filter(isSubmittedExamAttempt);
  const assignments = store.examAssignments.filter((item) => item.examId === exam.id && (!user || item.teamId === user.teamId));
  const assignment = user ? assignments.find((item) => item.userId === user.id) : undefined;
  const passRate = submittedAttempts.length
    ? Math.round((submittedAttempts.filter((attempt) => attempt.passed).length / submittedAttempts.length) * 100)
    : canManageTraining(user) || !user ? exam.passRate : 0;
  return {
    ...exam,
    questionCount: questions.length || exam.questionCount,
    passRate,
    runtimeStatus: examRuntimeStatus(exam),
    assignedCount: assignments.length,
    completedCount: assignments.filter((item) => item.attemptCount > 0).length,
    assignment: assignment || null,
    attemptsUsed: assignment?.attemptCount || submittedAttempts.length,
    bestScore: assignment?.bestScore || (submittedAttempts.length ? Math.max(...submittedAttempts.map((item) => item.score)) : 0),
    inProgressAttemptId: attempts.find((item) => !isSubmittedExamAttempt(item))?.id || ""
  };
}

function refreshExamStats(exam: Exam) {
  const store = getStore();
  const attempts = store.examAttempts.filter((attempt) => attempt.examId === exam.id && isSubmittedExamAttempt(attempt));
  const questionCount = examQuestionsAtPublish(exam.id).length;
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

/* ========================= 资料治理：受控词表 ========================= */
/* 权限由 /api/knowledge 中间件统一给：GET → training.read，写 → training.manage。 */

const knowledgeVocabularyInputSchema = z.object({
  type: z.enum(["category", "tag"]),
  value: z.string().trim().min(1).max(100)
});

export function registerKnowledgeExamsRoutes(app: Express) {
  app.get("/api/knowledge/assets", requireAuth, (req, res) => {
    const store = getStore();
    // 文件中心要能回答「这份资料被哪些订单引用」。反向索引在服务端算好，
    // 前端不必为了详情页的一行字再拉一次全部订单；同时按订单可见性过滤，
    // 避免别人从文件反查出自己无权看的单号。
    const visibleOrders = new Map(
      store.orders.filter((order) => orderVisible(req.user!, order)).map((order) => [order.id, order])
    );
    const assets = store.knowledgeAssets
      .filter((asset) => canSeeKnowledgeAsset(req.user!, asset))
      .map((asset) => {
        const linkedOrders = store.orderFiles
          .filter((file) => file.assetId === asset.id)
          .map((file) => {
            const order = visibleOrders.get(file.orderId);
            return order ? { id: order.id, orderNo: order.orderNo, companyOrderNo: order.companyOrderNo || "", status: order.status, kind: file.kind } : null;
          })
          .filter((order): order is { id: string; orderNo: string; companyOrderNo: string; status: Order["status"]; kind: OrderFile["kind"] } => Boolean(order));
        return { ...asset, linkedOrders, linkedOrderCount: linkedOrders.length };
      });
    res.json({ assets });
  });

  app.post("/api/knowledge/assets", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const body = knowledgeAssetInputSchema.parse(req.body);
    let source;
    try {
      source = normalizeKnowledgeSource(body.sourceUrl);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "资料链接无效" });
      return;
    }
    if (body.shareCode && source.sourceType !== "baidu_share") {
      res.status(400).json({ message: "提取码仅适用于百度网盘分享链接" });
      return;
    }

    const warnings: string[] = [];

    /* --- 入库闸 ①：类目必须在受控词表内（不在则给近似建议） --- */
    const categoryCheck = await validateKnowledgeCategory(req.user!.teamId, body.category, canManageTraining(req.user));
    if (!categoryCheck.ok) {
      res.status(400).json({
        message: `类目「${body.category}」不在词表内，请从词表选择或先由资料维护人添加`,
        code: "CATEGORY_NOT_IN_VOCABULARY",
        suggestions: categoryCheck.suggestions
      });
      return;
    }
    if (categoryCheck.created) warnings.push(`新类目「${categoryCheck.entry?.value}」已加入词表`);

    /* --- 入库闸 ②：查重（同团队同链接硬拦，同标题软警示） --- */
    const duplicate = findKnowledgeDuplicate(store, req.user!.teamId, {
      sourceUrl: source.sourceUrl,
      title: body.title
    });
    if (duplicate.sameUrl) {
      res.status(409).json({
        message: `同一链接的资料已存在：「${duplicate.sameUrl.title}」`,
        code: "DUPLICATE_SOURCE_URL",
        duplicateOf: duplicate.sameUrl.id
      });
      return;
    }
    if (duplicate.sameTitle) warnings.push(`已有同名资料「${duplicate.sameTitle.title}」，请确认不是重复入库`);

    /* --- 入库闸 ③：标签不在词表的自动建条（自由标签但可治理） --- */
    const tagRepository = getKnowledgeGovernanceRepository();
    const tagEntries = await tagRepository.list(req.user!.teamId, "tag");
    const knownTags = new Set(tagEntries.filter((entry) => entry.enabled).map((entry) => entry.normalized));
    const newTags: string[] = [];
    const tags = [...new Set(body.tags)];
    for (const tag of tags) {
      if (knownTags.has(normalizeVocabularyValue(tag))) continue;
      await tagRepository.ensure(req.user!.teamId, "tag", tag);
      newTags.push(tag);
    }
    if (newTags.length) warnings.push(`新标签已加入词表：${newTags.join("、")}`);

    const now = new Date().toISOString();
    const verified = body.verified === true && canManageTraining(req.user);
    const asset = {
      id: `k_${randomUUID()}`,
      status: canManageTraining(req.user) ? "draft" as const : "review" as const,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      title: body.title,
      category: categoryCheck.entry ? categoryCheck.entry.value : body.category,
      version: body.version,
      ...source,
      shareCode: source.sourceType === "baidu_share" ? body.shareCode : "",
      fileType: body.fileType,
      description: body.description,
      tags,
      verified,
      accessCount: 0,
      createdAt: now,
      updatedAt: now
    };
    store.knowledgeAssets.unshift(asset);
    await store.persist();
    await tagRepository.bumpUsage(req.user!.teamId, "category", [asset.category]);
    if (tags.length) await tagRepository.bumpUsage(req.user!.teamId, "tag", tags);
    res.json({ asset, qualityFlags: knowledgeQualityFlags(asset), warnings });
  }));

  app.patch("/api/knowledge/assets/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const asset = store.knowledgeAssets.find((item) => item.id === req.params.id);
    if (!asset || !canEditKnowledgeAsset(req.user!, asset)) {
      res.status(404).json({ message: "资料不存在或无权编辑" });
      return;
    }
    const body = knowledgeAssetInputSchema.partial().parse(req.body);
    let source: { sourceUrl: string; sourceType: "external_url" | "baidu_share" | "legacy" } = {
      sourceUrl: asset.sourceUrl || "",
      sourceType: asset.sourceType || "legacy"
    };
    if (body.sourceUrl !== undefined) {
      try {
        source = normalizeKnowledgeSource(body.sourceUrl);
      } catch (error) {
        res.status(400).json({ message: error instanceof Error ? error.message : "资料链接无效" });
        return;
      }
    }
    const shareCode = body.shareCode === undefined ? asset.shareCode || "" : body.shareCode;
    if (shareCode && source.sourceType !== "baidu_share") {
      res.status(400).json({ message: "提取码仅适用于百度网盘分享链接" });
      return;
    }

    const warnings: string[] = [];

    /* 编辑路径同样过入库闸：类目必须命中词表（改了类目才校验，没改不打扰）。 */
    let nextCategory = asset.category;
    if (body.category !== undefined) {
      const categoryCheck = await validateKnowledgeCategory(req.user!.teamId, body.category, canManageTraining(req.user));
      if (!categoryCheck.ok) {
        res.status(400).json({
          message: `类目「${body.category}」不在词表内，请从词表选择或先由资料维护人添加`,
          code: "CATEGORY_NOT_IN_VOCABULARY",
          suggestions: categoryCheck.suggestions
        });
        return;
      }
      nextCategory = categoryCheck.entry ? categoryCheck.entry.value : body.category;
    }

    /* 编辑路径同样查重：改链接撞库硬拦，改标题撞名软警示。 */
    const duplicate = findKnowledgeDuplicate(
      store,
      req.user!.teamId,
      { sourceUrl: source.sourceUrl, title: body.title ?? asset.title },
      asset.id
    );
    if (body.sourceUrl !== undefined && duplicate.sameUrl) {
      res.status(409).json({
        message: `同一链接的资料已存在：「${duplicate.sameUrl.title}」`,
        code: "DUPLICATE_SOURCE_URL",
        duplicateOf: duplicate.sameUrl.id
      });
      return;
    }
    if (body.title !== undefined && duplicate.sameTitle) {
      warnings.push(`已有同名资料「${duplicate.sameTitle.title}」，请确认不是重复`);
    }

    const tagRepository = getKnowledgeGovernanceRepository();
    let nextTags = asset.tags || [];
    if (body.tags !== undefined) {
      nextTags = [...new Set(body.tags)];
      const tagEntries = await tagRepository.list(req.user!.teamId, "tag");
      const knownTags = new Set(tagEntries.filter((entry) => entry.enabled).map((entry) => entry.normalized));
      const newTags: string[] = [];
      for (const tag of nextTags) {
        if (knownTags.has(normalizeVocabularyValue(tag))) continue;
        await tagRepository.ensure(req.user!.teamId, "tag", tag);
        newTags.push(tag);
      }
      if (newTags.length) warnings.push(`新标签已加入词表：${newTags.join("、")}`);
    }

    Object.assign(asset, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      category: nextCategory,
      ...(body.version !== undefined ? { version: body.version } : {}),
      ...(body.fileType !== undefined ? { fileType: body.fileType } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.tags !== undefined ? { tags: nextTags } : {}),
      ...source,
      shareCode: source.sourceType === "baidu_share" ? shareCode : "",
      ...(body.verified !== undefined && canManageTraining(req.user) ? { verified: body.verified === true } : {}),
      status: canManageTraining(req.user) ? asset.status : "review",
      updatedAt: new Date().toISOString()
    });
    await store.persist();
    if (body.tags !== undefined && nextTags.length) await tagRepository.bumpUsage(req.user!.teamId, "tag", nextTags);
    res.json({ asset, qualityFlags: knowledgeQualityFlags(asset), warnings });
  }));

  app.patch("/api/knowledge/assets/:id/publish", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageTraining(req.user)) {
      res.status(403).json({ message: "无发布资料权限" });
      return;
    }
    const store = getStore();
    const asset = store.knowledgeAssets.find((item) => item.id === req.params.id);
    if (!asset || !canSeeKnowledgeAsset(req.user!, asset)) {
      res.status(404).json({ message: "资料不存在" });
      return;
    }
    /* 版本线性化：同团队、同标题、同类目、已发布的其他资料自动归档 ——
       否则同一份资料的不同版本会并列出现在推荐位，谁新谁旧无从判断。 */
    const normalizedTitle = normalizeVocabularyValue(asset.title);
    const superseded = store.knowledgeAssets.filter(
      (item) =>
        item.id !== asset.id
        && item.status === "published"
        && normalizeVocabularyValue(item.title) === normalizedTitle
        && normalizeVocabularyValue(item.category) === normalizeVocabularyValue(asset.category)
        && knowledgeAssetTeamId(store, item) === knowledgeAssetTeamId(store, asset)
    );
    const now = new Date().toISOString();
    for (const item of superseded) {
      item.status = "archived";
      item.updatedAt = now;
    }
    asset.status = "published";
    asset.updatedAt = now;
    await store.persist();
    res.json({
      asset,
      qualityFlags: knowledgeQualityFlags(asset),
      archivedSuperseded: superseded.map((item) => ({ id: item.id, title: item.title, version: item.version }))
    });
  }));

  app.post("/api/knowledge/assets/:id/access", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const asset = store.knowledgeAssets.find((item) => item.id === req.params.id);
    if (!asset || !canSeeKnowledgeAsset(req.user!, asset)) {
      res.status(404).json({ message: "资料不存在或无权访问" });
      return;
    }
    if (!asset.sourceUrl || asset.sourceType === "legacy") {
      res.status(409).json({ message: "该历史资料尚未配置访问链接" });
      return;
    }
    try {
      normalizeKnowledgeSource(asset.sourceUrl);
    } catch {
      res.status(409).json({ message: "资料链接已失效，请联系资料维护人更新" });
      return;
    }
    asset.accessCount = (asset.accessCount || 0) + 1;
    asset.lastAccessedAt = new Date().toISOString();
    asset.updatedAt = asset.updatedAt || asset.lastAccessedAt;
    await store.persist();
    // CRM 内打开资料同样记一条 revealed（旁路，失败不影响 access 返回）——
    // 否则报表的 revealed 只反映扩展侧行为，业务员在 CRM 内的查看完全不进报表（G11）。
    void recordResourceHubEvents([{
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      resourceType: "file",
      resourceId: asset.id,
      eventType: "revealed",
      channel: "crm-access"
    }]);
    res.json({
      asset,
      access: {
        url: asset.sourceUrl,
        sourceType: asset.sourceType,
        shareCode: asset.sourceType === "baidu_share" ? asset.shareCode || "" : ""
      }
    });
  }));

  app.delete("/api/knowledge/assets/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.knowledgeAssets.findIndex((item) => item.id === req.params.id && canEditKnowledgeAsset(req.user!, item));
    if (index < 0) {
      res.status(404).json({ message: "资料不存在或无权删除" });
      return;
    }
    const [asset] = store.knowledgeAssets.splice(index, 1);
    await store.persist();
    res.json({ asset, deleted: true });
  }));

  app.get("/api/knowledge/vocabulary", requireAuth, asyncRoute(async (req, res) => {
    const type = z.enum(["category", "tag"]).optional().catch(undefined).parse(req.query.type);
    const entries = await getKnowledgeGovernanceRepository().list(req.user!.teamId, type);
    res.json({ entries });
  }));

  app.post("/api/knowledge/vocabulary", requireAuth, asyncRoute(async (req, res) => {
    const body = knowledgeVocabularyInputSchema.parse(req.body || {});
    // ensure 语义：同归一化值已存在则返回既有条，不报错（「建议新类目」落到已有时静默复用）
    const entry = await getKnowledgeGovernanceRepository().ensure(req.user!.teamId, body.type, body.value);
    res.json({ entry });
  }));

  app.patch("/api/knowledge/vocabulary/:id", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      value: z.string().trim().min(1).max(100).optional(),
      enabled: z.boolean().optional()
    }).parse(req.body || {});
    const entry = await getKnowledgeGovernanceRepository().update(req.user!.teamId, req.params.id, body);
    if (!entry) {
      res.status(404).json({ message: "词条不存在" });
      return;
    }
    res.json({ entry });
  }));

  /**
   * 合并词条：{ fromId, toValue } → 把资料里用旧值的 category/tags 批量改成新值，停用旧词条。
   * 破坏性操作（改的是存量资料），前端必须二次确认。
   */
  app.post("/api/knowledge/vocabulary/merge", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      fromId: z.string().trim().min(1),
      toValue: z.string().trim().min(1).max(100)
    }).parse(req.body || {});
    const repository = getKnowledgeGovernanceRepository();
    const entries = await repository.list(req.user!.teamId);
    const source = entries.find((entry) => entry.id === body.fromId);
    if (!source) {
      res.status(404).json({ message: "被合并的词条不存在" });
      return;
    }
    if (source.normalized === normalizeVocabularyValue(body.toValue)) {
      res.status(400).json({ message: "新值与被合并词条相同" });
      return;
    }
    // 目标词条必须是同类型的词表成员（不存在则建）
    const target = await repository.ensure(req.user!.teamId, source.type, body.toValue);

    const store = getStore();
    const teamId = req.user!.teamId;
    let affected = 0;
    for (const asset of store.knowledgeAssets) {
      if (knowledgeAssetTeamId(store, asset) !== teamId) continue;
      if (source.type === "category") {
        if (normalizeVocabularyValue(asset.category) === source.normalized) {
          asset.category = target.value;
          asset.updatedAt = new Date().toISOString();
          affected += 1;
        }
      } else if (Array.isArray(asset.tags)) {
        const next = asset.tags.map((tag) => (normalizeVocabularyValue(tag) === source.normalized ? target.value : tag));
        if (next.join("\u0000") !== asset.tags.join("\u0000")) {
          asset.tags = [...new Set(next)];
          asset.updatedAt = new Date().toISOString();
          affected += 1;
        }
      }
    }
    if (affected) await store.persist();
    // 停用旧词条（保留行以留痕：老资料若仍引用旧值，面板上还能看到它是「已停用」而不是凭空消失）
    await repository.update(teamId, source.id, { enabled: false });
    await repository.bumpUsage(teamId, target.type, [target.value]);
    res.json({ merged: { from: source.value, to: target.value, type: source.type }, affected });
  }));

  /* ========================= 资料治理：批量与归档 ========================= */

  app.patch("/api/knowledge/assets/:id/archive", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ reason: z.string().trim().max(200).optional().default("") }).parse(req.body || {});
    const store = getStore();
    const asset = store.knowledgeAssets.find((item) => item.id === req.params.id && canEditKnowledgeAsset(req.user!, item));
    if (!asset) {
      res.status(404).json({ message: "资料不存在或无权归档" });
      return;
    }
    asset.status = "archived";
    asset.updatedAt = new Date().toISOString();
    asset.archivedReason = body.reason;
    await store.persist();
    res.json({ asset, qualityFlags: knowledgeQualityFlags(asset) });
  }));

  app.post("/api/knowledge/assets/batch", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageTraining(req.user)) {
      res.status(403).json({ message: "只有主管和管理员可以批量维护资料" });
      return;
    }
    const body = z.object({
      ids: z.array(z.string().trim().min(1)).min(1).max(200),
      action: z.enum(["publish", "archive", "set-category", "add-tags"]),
      category: z.string().trim().min(1).max(100).optional(),
      tags: z.array(z.string().trim().min(1).max(60)).max(30).optional()
    }).parse(req.body || {});

    const store = getStore();
    const teamId = req.user!.teamId;
    const repository = getKnowledgeGovernanceRepository();
    const ok: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    const now = new Date().toISOString();

    // set-category 先统一校验词表，避免「一半改了、一半没改」
    let nextCategory: string | null = null;
    if (body.action === "set-category") {
      if (!body.category) {
        res.status(400).json({ message: "缺少目标类目" });
        return;
      }
      const check = await validateKnowledgeCategory(teamId, body.category, true);
      if (!check.ok) {
        res.status(400).json({
          message: `类目「${body.category}」不在词表内`,
          code: "CATEGORY_NOT_IN_VOCABULARY",
          suggestions: check.suggestions
        });
        return;
      }
      nextCategory = check.entry ? check.entry.value : body.category;
    }

    // add-tags 先统一建词条
    if (body.action === "add-tags") {
      if (!body.tags?.length) {
        res.status(400).json({ message: "缺少要添加的标签" });
        return;
      }
      const entries = await repository.list(teamId, "tag");
      const known = new Set(entries.filter((entry) => entry.enabled).map((entry) => entry.normalized));
      for (const tag of body.tags) {
        if (!known.has(normalizeVocabularyValue(tag))) await repository.ensure(teamId, "tag", tag);
      }
    }

    for (const id of [...new Set(body.ids)]) {
      const asset = store.knowledgeAssets.find((item) => item.id === id);
      if (!asset) {
        failed.push({ id, reason: "资料不存在" });
        continue;
      }
      if (!canEditKnowledgeAsset(req.user!, asset)) {
        failed.push({ id, reason: "无权编辑" });
        continue;
      }
      if (body.action === "publish") {
        asset.status = "published";
      } else if (body.action === "archive") {
        asset.status = "archived";
        asset.archivedReason = "批量归档";
      } else if (body.action === "set-category") {
        asset.category = nextCategory as string;
      } else {
        asset.tags = [...new Set([...(asset.tags || []), ...(body.tags || [])])];
      }
      asset.updatedAt = now;
      ok.push(id);
    }
    if (ok.length) await store.persist();
    if (ok.length && body.action === "set-category" && nextCategory) {
      await repository.bumpUsage(teamId, "category", [nextCategory]);
    }
    if (ok.length && body.action === "add-tags" && body.tags?.length) {
      await repository.bumpUsage(teamId, "tag", body.tags);
    }
    res.json({ ok, failed, requested: body.ids.length });
  }));

  /**
   * 治理看数（文件中心指标卡 + 资源中心治理 Tab 共用）。
   * 只做只读聚合；埋点摘要失败只降级该块，不拖垮整个接口。
   */
  app.get("/api/knowledge/assets/governance", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const teamId = req.user!.teamId;
    const visible = store.knowledgeAssets.filter((asset) => canSeeKnowledgeAsset(req.user!, asset));
    const teamAssets = store.knowledgeAssets.filter((asset) => knowledgeAssetTeamId(store, asset) === teamId);

    const flagCounts: Record<string, number> = {};
    const missingLink: Array<{ id: string; title: string; category: string }> = [];
    for (const asset of visible) {
      for (const flag of knowledgeQualityFlags(asset)) {
        flagCounts[flag] = (flagCounts[flag] || 0) + 1;
      }
      if (!asset.sourceUrl || asset.sourceType === "legacy") {
        missingLink.push({ id: asset.id, title: asset.title, category: asset.category });
      }
    }

    // 孤儿：owner 已删除（team 归属无从判定）——与迁移里的 orphanIds 同一口径
    const orphans = teamAssets
      .filter((asset) => !store.users.some((user) => user.id === asset.ownerId))
      .map((asset) => ({ id: asset.id, title: asset.title, ownerId: asset.ownerId, category: asset.category }));

    const warnings: string[] = [];
    let retrieval: { totals: Record<string, number>; adoptionRate: number; sendRate: number; items: number } | null = null;
    try {
      const stats = await getResourceHubRepository().eventStats(teamId, new Date(Date.now() - 30 * 86_400_000));
      const totals = emptyEventCounts();
      let accepted = 0;
      let revealed = 0;
      let sent = 0;
      for (const entry of stats.values()) {
        totals.exposed += entry.exposed;
        totals.revealed += entry.revealed;
        totals.accepted += entry.accepted;
        totals.dismissed += entry.dismissed;
        totals.sent += entry.sent;
        accepted += entry.accepted;
        revealed += entry.revealed;
        sent += entry.sent;
      }
      retrieval = {
        totals,
        adoptionRate: accepted / Math.max(1, revealed),
        sendRate: sent / Math.max(1, revealed),
        items: stats.size
      };
    } catch {
      warnings.push("埋点统计未取到");
    }

    res.json({
      counts: {
        total: visible.length,
        published: visible.filter((asset) => asset.status === "published").length,
        draft: visible.filter((asset) => asset.status === "draft").length,
        review: visible.filter((asset) => asset.status === "review").length,
        archived: visible.filter((asset) => asset.status === "archived").length,
        verified: visible.filter((asset) => asset.verified).length,
        missingLink: missingLink.length,
        orphans: orphans.length
      },
      qualityFlags: flagCounts,
      missingLink: missingLink.slice(0, 100),
      orphans: orphans.slice(0, 100),
      retrieval,
      warnings
    });
  }));

  app.get("/api/exam-questions", requireAuth, (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const category = String(req.query.category || "").trim();
    const tag = String(req.query.tag || "").trim();
    const type = String(req.query.type || "").trim();
    let questions = bankQuestions(req.user!);
    if (category) questions = questions.filter((question) => question.category === category);
    if (tag) questions = questions.filter((question) => (question.tags || []).includes(tag));
    if (type) questions = questions.filter((question) => (question.questionType || (correctIndexesFor(question).length > 1 ? "multiple" : "single")) === type);
    res.json({ questions, report: examReport(req.user!) });
  });

  app.get("/api/exam-questions/export", requireAuth, (_req, res) => {
    if (!requireTrainingManager(_req, res)) return;
    res.json({ questions: bankQuestions(_req.user!) });
  });

  app.post("/api/exam-questions", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const body = examQuestionSchema.parse(req.body);
    let question: ExamQuestion;
    try {
      question = { ...buildExamQuestion(body), ownerId: req.user!.id, teamId: req.user!.teamId };
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
        imported.push({ ...buildExamQuestion(item, index), ownerId: req.user!.id, teamId: req.user!.teamId });
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
    const index = store.examQuestions.findIndex((question) => question.id === req.params.id && canManageExamQuestion(req.user!, question));
    if (index < 0) {
      res.status(404).json({ message: "题目不存在" });
      return;
    }
    const body = examQuestionSchema.parse(req.body);
    let question: ExamQuestion;
    try {
      question = {
        ...buildExamQuestion(body),
        id: store.examQuestions[index].id,
        examId: store.examQuestions[index].examId || "bank",
        ownerId: store.examQuestions[index].ownerId,
        teamId: store.examQuestions[index].teamId
      };
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
    const index = store.examQuestions.findIndex((question) => question.id === req.params.id && canManageExamQuestion(req.user!, question));
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
    const canManage = canManageTraining(_req.user);
    const candidates = canManage
      ? getStore().users.filter((item) => item.status === "active" && item.teamId === _req.user!.teamId && item.id !== _req.user!.id)
        .map((item) => ({ id: item.id, name: item.name, role: item.role, avatar: item.avatar }))
      : [];
    res.json({ exams: scoped.map((exam) => examWithRuntimeStats(exam, _req.user!)), report: examReport(_req.user!), canManage, candidates });
  });

  app.get("/api/exams/:id/detail", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id);
    if (!exam || !canAccessExam(req.user!, exam)) {
      res.status(404).json({ message: "考试不存在" });
      return;
    }
    const manager = canManageTraining(req.user);
    const assignment = examAssignmentFor(exam.id, req.user!.id) || null;
    const questions = examQuestionsAtPublish(exam.id, req.user!).map((question) => safeExamQuestion(question, manager));
    const attempts = store.examAttempts.filter((item) => item.examId === exam.id);
    const latestAttempt = attempts.find((item) => item.userId === req.user!.id) || null;
    const beforeStatus = latestAttempt?.status;
    expireExamAttemptIfNeeded(exam, latestAttempt);
    if (latestAttempt && beforeStatus !== latestAttempt.status) await store.persist();
    const canReview = manager || Boolean(exam.allowReview && latestAttempt && isSubmittedExamAttempt(latestAttempt));
    res.json({
      exam: examWithRuntimeStats(exam, req.user!),
      questions: examQuestionsAtPublish(exam.id, req.user!).map((question) => safeExamQuestion(question, canReview)),
      latestAttempt,
      assignment,
      canReview,
      report: examReport(req.user!)
    });
  }));

  app.post("/api/exams", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const schema = z.object({
      title: z.string().min(1),
      category: z.string().min(1),
      questionIds: z.array(z.string()).min(1, "请至少选择 1 道题目"),
      durationMinutes: z.number().int().positive().default(20),
      passScore: z.number().int().min(1).max(100).default(80),
      targetRole: z.enum(["all", "sales", "manager"]).default("sales"),
      instructions: z.string().max(2000).optional().default("请在规定时间内独立完成考试。")
    });
    const body = schema.parse(req.body);
    const uniqueQuestionIds = [...new Set(body.questionIds)];
    const selectedQuestions = uniqueQuestionIds.map((id) => store.examQuestions.find((question) => question.id === id && canUseExamQuestion(req.user!, question)));
    if (selectedQuestions.some((question) => !question)) {
      res.status(400).json({ message: "包含不存在的题目，请刷新题库后重试" });
      return;
    }
    const now = new Date().toISOString();
    const exam: Exam = {
      id: `e_${Date.now()}`,
      title: body.title,
      category: body.category,
      status: "draft",
      passRate: 0,
      questionCount: uniqueQuestionIds.length,
      durationMinutes: body.durationMinutes,
      passScore: body.passScore,
      targetRole: body.targetRole,
      instructions: body.instructions,
      maxAttempts: 1,
      allowReview: false,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      updatedAt: now
    };
    store.exams.unshift(exam);
    store.examQuestionLinks.unshift(...uniqueQuestionIds.map((questionId, index) => ({ examId: exam.id, questionId, sortOrder: index + 1 })));
    refreshExamStats(exam);
    await store.persist();
    res.json({ exam: examWithRuntimeStats(exam, req.user!), questions: examQuestionsFor(exam.id, req.user!), report: examReport(req.user!) });
  }));

  app.post("/api/exams/:id/questions", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (!exam) {
      res.status(404).json({ message: "考试不存在" });
      return;
    }
    const body = examQuestionSchema.parse({ ...req.body, category: req.body?.category || exam.category });
    let question: ExamQuestion;
    try {
      question = { ...buildExamQuestion(body), ownerId: req.user!.id, teamId: req.user!.teamId };
    } catch (error) {
      res.status(400).json({ message: "正确答案序号超出选项数量" });
      return;
    }
    store.examQuestions.unshift(question);
    store.examQuestionLinks.push({ examId: exam.id, questionId: question.id, sortOrder: examQuestionsFor(exam.id, req.user!).length + 1 });
    refreshExamStats(exam);
    await store.persist();
    res.json({ question, exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
  }));

  app.post("/api/exams/:id/questions/import", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (!exam) {
      res.status(404).json({ message: "考试不存在" });
      return;
    }
    const schema = z.object({ questions: z.array(examQuestionSchema).min(1).max(300) });
    const body = schema.parse(req.body);
    const imported: ExamQuestion[] = [];
    for (const [index, item] of body.questions.entries()) {
      try {
        imported.push({ ...buildExamQuestion({ ...item, category: item.category || exam.category }, index), ownerId: req.user!.id, teamId: req.user!.teamId });
      } catch (error) {
        res.status(400).json({ message: `第 ${index + 1} 行正确答案序号超出选项数量` });
        return;
      }
    }
    store.examQuestions.unshift(...imported);
    store.examQuestionLinks.push(...imported.map((question, index) => ({ examId: exam.id, questionId: question.id, sortOrder: examQuestionsFor(exam.id, req.user!).length + index + 1 })));
    refreshExamStats(exam);
    await store.persist();
    res.json({ importedCount: imported.length, questions: imported, exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
  }));

  app.patch("/api/exams/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (!exam) return void res.status(404).json({ message: "考试不存在" });
    if (store.examAttempts.some((item) => item.examId === exam.id)) return void res.status(409).json({ message: "考试已有作答记录，不能再修改试卷" });
    const schema = z.object({
      title: z.string().min(1).max(200).optional(),
      category: z.string().min(1).max(100).optional(),
      questionIds: z.array(z.string()).min(1).max(300).optional(),
      durationMinutes: z.number().int().min(1).max(240).optional(),
      passScore: z.number().int().min(1).max(100).optional(),
      targetRole: z.enum(["all", "sales", "manager"]).optional(),
      instructions: z.string().max(2000).optional()
    });
    const body = schema.parse(req.body);
    if (body.questionIds) {
      const ids = [...new Set(body.questionIds)];
      if (ids.some((id) => !store.examQuestions.some((question) => question.id === id && canUseExamQuestion(req.user!, question)))) return void res.status(400).json({ message: "试卷包含无效题目" });
      store.examQuestionLinks = store.examQuestionLinks.filter((item) => item.examId !== exam.id);
      store.examQuestionLinks.push(...ids.map((questionId, index) => ({ examId: exam.id, questionId, sortOrder: index + 1 })));
    }
    Object.assign(exam, {
      ...(body.title ? { title: body.title } : {}),
      ...(body.category ? { category: body.category } : {}),
      ...(body.durationMinutes ? { durationMinutes: body.durationMinutes } : {}),
      ...(body.passScore ? { passScore: body.passScore } : {}),
      ...(body.targetRole ? { targetRole: body.targetRole } : {}),
      ...(body.instructions !== undefined ? { instructions: body.instructions } : {})
    });
    refreshExamStats(exam);
    await store.persist();
    res.json({ exam: examWithRuntimeStats(exam, req.user!), questions: examQuestionsFor(exam.id, req.user!), report: examReport(req.user!) });
  }));

  app.patch("/api/exams/:id/publish", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (!exam) {
      res.status(404).json({ message: "考试不存在" });
      return;
    }
    if (!examQuestionsFor(exam.id, req.user!).length) {
      res.status(400).json({ message: "请先勾选至少 1 道题目组卷" });
      return;
    }
    const publishSchema = z.object({
      assigneeIds: z.array(z.string()).max(500).optional(),
      startAt: z.string().datetime().optional(),
      endAt: z.string().datetime().optional(),
      durationMinutes: z.number().int().min(1).max(240).optional(),
      passScore: z.number().int().min(1).max(100).optional(),
      maxAttempts: z.number().int().min(1).max(10).optional(),
      allowReview: z.boolean().optional(),
      instructions: z.string().max(2000).optional()
    });
    const body = publishSchema.parse(req.body || {});
    const startAt = body.startAt || exam.startAt || new Date().toISOString();
    const endAt = body.endAt || exam.endAt;
    if (endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      res.status(400).json({ message: "考试截止时间必须晚于开始时间" });
      return;
    }
    const defaultCandidates = store.users.filter((item) => item.status === "active" && item.teamId === req.user!.teamId && item.id !== req.user!.id && (exam.targetRole === "all" || item.role === exam.targetRole));
    const requestedIds = [...new Set(body.assigneeIds?.length ? body.assigneeIds : defaultCandidates.map((item) => item.id))];
    const assignees = requestedIds.map((id) => store.users.find((item) => item.id === id && item.status === "active" && item.teamId === req.user!.teamId));
    if (!assignees.length || assignees.some((item) => !item)) {
      res.status(400).json({ message: "请至少选择 1 名当前团队的有效考生" });
      return;
    }
    const now = new Date().toISOString();
    exam.durationMinutes = body.durationMinutes || exam.durationMinutes || 20;
    exam.passScore = body.passScore || exam.passScore || 80;
    exam.maxAttempts = body.maxAttempts || exam.maxAttempts || 1;
    exam.allowReview = body.allowReview ?? exam.allowReview ?? false;
    exam.instructions = body.instructions ?? exam.instructions ?? "";
    exam.startAt = startAt;
    exam.endAt = endAt;
    exam.publishedAt = exam.publishedAt || now;
    exam.closedAt = undefined;
    exam.status = "published";
    const hasSubmittedAttempts = store.examAttempts.some((item) => item.examId === exam.id && isSubmittedExamAttempt(item));
    const snapshot = store.examSnapshots.find((item) => item.examId === exam.id);
    if (!snapshot || !hasSubmittedAttempts) {
      const nextSnapshot = {
        examId: exam.id,
        questions: structuredClone(examQuestionsFor(exam.id, req.user!)),
        rules: { durationMinutes: exam.durationMinutes, passScore: exam.passScore, maxAttempts: exam.maxAttempts, allowReview: exam.allowReview },
        createdAt: now
      };
      if (snapshot) Object.assign(snapshot, nextSnapshot);
      else store.examSnapshots.push(nextSnapshot);
    }
    const preservedUserIds = new Set(requestedIds);
    store.examAssignments = store.examAssignments.filter((item) => item.examId !== exam.id || preservedUserIds.has(item.userId) || item.attemptCount > 0);
    for (const assignee of assignees) {
      if (!assignee) continue;
      if (!examAssignmentFor(exam.id, assignee.id)) {
        store.examAssignments.push({
          id: `exa_${exam.id}_${assignee.id}`,
          examId: exam.id,
          userId: assignee.id,
          assignedById: req.user!.id,
          teamId: req.user!.teamId,
          status: "pending",
          attemptCount: 0,
          bestScore: 0,
          latestAttemptId: "",
          createdAt: now,
          updatedAt: now
        });
      }
    }
    refreshExamStats(exam);
    await store.persist();
    res.json({ exam: examWithRuntimeStats(exam, req.user!), assignments: store.examAssignments.filter((item) => item.examId === exam.id), report: examReport(req.user!) });
  }));

  app.patch("/api/exams/:id/close", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (!exam) return void res.status(404).json({ message: "考试不存在" });
    exam.status = "closed";
    exam.closedAt = new Date().toISOString();
    exam.updatedAt = exam.closedAt;
    for (const attempt of store.examAttempts.filter((item) => item.examId === exam.id && !isSubmittedExamAttempt(item))) gradeExamAttempt(exam, attempt, "auto_submitted");
    await store.persist();
    res.json({ exam: examWithRuntimeStats(exam, req.user!), report: examReport(req.user!) });
  }));

  app.get("/api/exams/:id/results", requireAuth, (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (!exam) return void res.status(404).json({ message: "考试不存在" });
    const assignments = store.examAssignments.filter((item) => item.examId === exam.id && item.teamId === req.user!.teamId).map((assignment) => ({
      ...assignment,
      userName: store.users.find((item) => item.id === assignment.userId)?.name || "未知成员",
      attempts: store.examAttempts.filter((item) => item.examId === exam.id && item.userId === assignment.userId && isSubmittedExamAttempt(item))
    }));
    res.json({ exam: examWithRuntimeStats(exam, req.user!), assignments });
  });

  app.post("/api/exams/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const schema = z.object({ ids: z.array(z.string()).min(1).max(100) });
    const body = schema.parse(req.body);
    const ids = [...new Set(body.ids)];
    const deleted = store.exams.filter((exam) => ids.includes(exam.id) && canManageExam(req.user!, exam));
    if (!deleted.length) {
      res.status(404).json({ message: "未找到可删除的考试" });
      return;
    }
    const deletedIds = new Set(deleted.map((exam) => exam.id));
    store.exams = store.exams.filter((exam) => !deletedIds.has(exam.id));
    store.examQuestionLinks = store.examQuestionLinks.filter((link) => !deletedIds.has(link.examId));
    store.examAttempts = store.examAttempts.filter((attempt) => !deletedIds.has(attempt.examId));
    store.examAssignments = store.examAssignments.filter((assignment) => !deletedIds.has(assignment.examId));
    store.examSnapshots = store.examSnapshots.filter((snapshot) => !deletedIds.has(snapshot.examId));
    store.exams.forEach(refreshExamStats);
    await store.persist();
    const scoped = store.exams.filter((exam) => canAccessExam(req.user!, exam));
    res.json({ deleted, exams: scoped.map((exam) => examWithRuntimeStats(exam, req.user!)), report: examReport(req.user!) });
  }));

  app.delete("/api/exams/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!requireTrainingManager(req, res)) return;
    const store = getStore();
    const index = store.exams.findIndex((item) => item.id === req.params.id && canManageExam(req.user!, item));
    if (index < 0) {
      res.status(404).json({ message: "考试不存在" });
      return;
    }
    const [exam] = store.exams.splice(index, 1);
    store.examQuestionLinks = store.examQuestionLinks.filter((link) => link.examId !== exam.id);
    store.examAttempts = store.examAttempts.filter((attempt) => attempt.examId !== exam.id);
    store.examAssignments = store.examAssignments.filter((assignment) => assignment.examId !== exam.id);
    store.examSnapshots = store.examSnapshots.filter((snapshot) => snapshot.examId !== exam.id);
    store.exams.forEach(refreshExamStats);
    await store.persist();
    const scoped = store.exams.filter((item) => canAccessExam(req.user!, item));
    res.json({ exam, exams: scoped.map((item) => examWithRuntimeStats(item, req.user!)), report: examReport(req.user!) });
  }));

  app.post("/api/exams/:id/start", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id);
    if (!exam || !canAccessExam(req.user!, exam) || canManageTraining(req.user) && !examAssignmentFor(exam.id, req.user!.id)) {
      res.status(404).json({ message: "考试不存在或未分配给当前账号" });
      return;
    }
    const runtimeStatus = examRuntimeStatus(exam);
    if (runtimeStatus === "upcoming") return void res.status(409).json({ message: "考试尚未开始" });
    if (runtimeStatus === "expired" || runtimeStatus === "closed") return void res.status(409).json({ message: "考试已结束" });
    let assignment = examAssignmentFor(exam.id, req.user!.id);
    if (!assignment) {
      const now = new Date().toISOString();
      assignment = { id: `exa_${exam.id}_${req.user!.id}`, examId: exam.id, userId: req.user!.id, assignedById: exam.ownerId || req.user!.id, teamId: req.user!.teamId, status: "pending", attemptCount: 0, bestScore: 0, latestAttemptId: "", createdAt: now, updatedAt: now };
      store.examAssignments.push(assignment);
    }
    const existing = store.examAttempts.find((item) => item.examId === exam.id && item.userId === req.user!.id && !isSubmittedExamAttempt(item));
    const active = expireExamAttemptIfNeeded(exam, existing);
    if (active && !isSubmittedExamAttempt(active)) {
      await store.persist();
      return void res.json({ exam: examWithRuntimeStats(exam, req.user!), attempt: active, questions: examQuestionsAtPublish(exam.id, req.user!).map((item) => safeExamQuestion(item, false)), resumed: true });
    }
    refreshExamAssignment(assignment);
    if (assignment.attemptCount >= (exam.maxAttempts || 1)) return void res.status(409).json({ message: "已达到本场考试的最大作答次数" });
    const startedAt = new Date();
    const durationDeadline = startedAt.getTime() + (exam.durationMinutes || 20) * 60_000;
    const examDeadline = exam.endAt ? new Date(exam.endAt).getTime() : Number.POSITIVE_INFINITY;
    const expiresAt = new Date(Math.min(durationDeadline, examDeadline)).toISOString();
    const attempt: ExamAttempt = {
      id: `attempt_${exam.id}_${req.user!.id}_${Date.now()}`,
      examId: exam.id,
      userId: req.user!.id,
      score: 0,
      passed: false,
      answers: {},
      correctCount: 0,
      totalQuestions: examQuestionsAtPublish(exam.id).length,
      status: "in_progress",
      startedAt: startedAt.toISOString(),
      expiresAt,
      updatedAt: startedAt.toISOString(),
      submittedAt: startedAt.toISOString()
    };
    store.examAttempts.unshift(attempt);
    refreshExamAssignment(assignment);
    await store.persist();
    res.status(201).json({ exam: examWithRuntimeStats(exam, req.user!), attempt, questions: examQuestionsAtPublish(exam.id, req.user!).map((item) => safeExamQuestion(item, false)), resumed: false });
  }));

  app.patch("/api/exam-attempts/:id/answers", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const attempt = store.examAttempts.find((item) => item.id === req.params.id && item.userId === req.user!.id);
    const exam = attempt ? store.exams.find((item) => item.id === attempt.examId) : undefined;
    if (!attempt || !exam || exam.teamId !== req.user!.teamId) return void res.status(404).json({ message: "作答记录不存在" });
    const expired = expireExamAttemptIfNeeded(exam, attempt);
    if (!expired || isSubmittedExamAttempt(expired)) {
      await store.persist();
      return void res.status(409).json({ message: "考试已交卷，不能继续修改", attempt: expired });
    }
    const schema = z.object({ answers: z.record(z.string(), z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])) });
    const body = schema.parse(req.body);
    const allowedQuestions = new Map(examQuestionsAtPublish(exam.id).map((item) => [item.id, item]));
    for (const [questionId, rawAnswer] of Object.entries(body.answers)) {
      const question = allowedQuestions.get(questionId);
      const indexes = Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer];
      if (!question || indexes.some((index) => index >= question.options.length)) return void res.status(400).json({ message: "答案包含无效题目或选项" });
    }
    attempt.answers = { ...attempt.answers, ...body.answers };
    attempt.updatedAt = new Date().toISOString();
    await store.persist();
    res.json({ attempt, savedAt: attempt.updatedAt });
  }));

  app.post("/api/exam-attempts/:id/submit", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const attempt = store.examAttempts.find((item) => item.id === req.params.id && item.userId === req.user!.id);
    const exam = attempt ? store.exams.find((item) => item.id === attempt.examId) : undefined;
    if (!attempt || !exam || exam.teamId !== req.user!.teamId) return void res.status(404).json({ message: "作答记录不存在" });
    if (isSubmittedExamAttempt(attempt)) return void res.status(409).json({ message: "本次考试已经交卷", attempt });
    const schema = z.object({ answers: z.record(z.string(), z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])).optional() });
    const body = schema.parse(req.body || {});
    if (body.answers) attempt.answers = { ...attempt.answers, ...body.answers };
    const status = attempt.expiresAt && new Date(attempt.expiresAt).getTime() <= Date.now() ? "auto_submitted" : "submitted";
    gradeExamAttempt(exam, attempt, status);
    await store.persist();
    const canReview = Boolean(exam.allowReview);
    res.json({ attempt, exam: examWithRuntimeStats(exam, req.user!), questions: examQuestionsAtPublish(exam.id, req.user!).map((item) => safeExamQuestion(item, canReview)), canReview, report: examReport(req.user!) });
  }));

  app.post("/api/exams/:id/submit", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const exam = store.exams.find((item) => item.id === req.params.id);
    if (!exam || !canAccessExam(req.user!, exam)) {
      res.status(404).json({ message: "考试不存在" });
      return;
    }
    const hasPublishedSnapshot = store.examSnapshots.some((item) => item.examId === exam.id);
    const assignment = examAssignmentFor(exam.id, req.user!.id);
    if (hasPublishedSnapshot && !assignment) return void res.status(404).json({ message: "考试不存在或未分配给当前账号" });
    if (assignment) {
      refreshExamAssignment(assignment);
      if (assignment.attemptCount >= (exam.maxAttempts || 1)) return void res.status(409).json({ message: "已达到本场考试的最大作答次数" });
    }
    const schema = z.object({
      answers: z.record(z.string(), z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])).default({})
    });
    const body = schema.parse(req.body);
    const questions = examQuestionsAtPublish(exam.id, req.user!);
    if (!questions.length) {
      res.status(400).json({ message: "当前考试暂无题目" });
      return;
    }
    const answers = body.answers;
    const correctCount = questions.filter((question) => {
      const rawAnswer = answers[question.id];
      const selectedIndexes = Array.isArray(rawAnswer) ? rawAnswer : rawAnswer == null ? [] : [rawAnswer];
      return indexesEqual(selectedIndexes, correctIndexesFor(question));
    }).length;
    const score = Math.round((correctCount / questions.length) * 100);
    const now = new Date().toISOString();
    const attempt: ExamAttempt = {
      id: `attempt_${exam.id}_${req.user!.id}_${Date.now()}`,
      examId: exam.id,
      userId: req.user!.id,
      score,
      passed: score >= (exam.passScore || 80),
      answers,
      correctCount,
      totalQuestions: questions.length,
      status: "submitted",
      startedAt: now,
      updatedAt: now,
      submittedAt: now
    };
    store.examAttempts.unshift(attempt);
    if (assignment) refreshExamAssignment(assignment);
    refreshExamStats(exam);
    await store.persist();
    res.json({ attempt, exam: examWithRuntimeStats(exam, req.user!), questions: questions.map((item) => safeExamQuestion(item, Boolean(exam.allowReview) || !hasPublishedSnapshot)), report: examReport(req.user!) });
  }));
}
