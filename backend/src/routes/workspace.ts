/**
 * 日报、站内信、待办、计划任务/模板、问题、备忘、竞品、同行、案例、提醒路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canSeeOwner, canSeePersonalData, hasIamPermission, publicUser, requireAuth } from "../auth.js";
import { type PeerRelation, type PlanTask, type PlanTemplate, type Reminder, type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { isPublicCustomer } from "../customer-public-pool.js";
import {
  archiveExpiredTodos,
  asyncRoute,
  createInternalNotification,
  currentMinuteText,
  entityDuplicateKey,
  matchReminderRule,
  nextTodoSortOrder,
  reminderSkipReason,
  runReminderRuleNow,
  shouldArchiveTodo,
  synchronizeWhatsAppFollowup
} from "../server-core.js";

function collaborationUser(userId: string) {
  if (userId === "system") return { id: "system", name: "GoodJob", avatar: "GJ", role: "admin" as const, teamId: "" };
  const user = getStore().users.find((item) => item.id === userId);
  return user ? { id: user.id, name: user.name, avatar: user.avatar, role: user.role, teamId: user.teamId } : {
    id: userId,
    name: "已停用账号",
    avatar: "--",
    role: "sales" as const,
    teamId: ""
  };
}

function canViewDailyReport(user: SessionUser, report: ReturnType<typeof getStore>["dailyReports"][number]) {
  if (user.iamDataScope) {
    return report.teamId === user.teamId
      && (user.iamDataScope.tenantWide || user.iamDataScope.ownerIds.includes(report.ownerId));
  }
  if (user.role === "super_admin") return true;
  if (user.role === "manager" || user.role === "admin") return report.teamId === user.teamId;
  return report.ownerId === user.id;
}

function publicDailyReport(report: ReturnType<typeof getStore>["dailyReports"][number]) {
  return {
    ...report,
    owner: collaborationUser(report.ownerId),
    commentCount: getStore().dailyReportComments.filter((item) => item.reportId === report.id).length
  };
}

function publicDailyReportComment(comment: ReturnType<typeof getStore>["dailyReportComments"][number]) {
  return { ...comment, author: collaborationUser(comment.authorId) };
}

function publicInternalMessage(message: ReturnType<typeof getStore>["internalMessages"][number]) {
  return {
    ...message,
    sender: collaborationUser(message.senderId),
    recipient: collaborationUser(message.recipientId)
  };
}

const dailyReportBodySchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日报日期格式不正确"),
  completedWork: z.string().trim().min(1, "请填写今日完成工作").max(5000),
  customerProgress: z.string().trim().max(5000).default(""),
  results: z.string().trim().max(5000).default(""),
  risks: z.string().trim().max(5000).default(""),
  nextPlan: z.string().trim().max(5000).default(""),
  supportNeeded: z.string().trim().max(5000).default("")
});

const planTaskDueAtSchema = z.string().refine(
  (value) => !value || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value),
  "计划时间格式无效"
);

const planTaskSchema = z.object({
  title: z.string().min(1),
  phase: z.string().min(1).default("计划任务"),
  category: z.string().min(1).default("客户开发"),
  priority: z.enum(["high", "medium", "normal"]).default("normal"),
  status: z.enum(["planned", "active"]).default("planned"),
  dueAt: planTaskDueAtSchema.default(""),
  target: z.string().default(""),
  description: z.string().default(""),
  customerId: z.string().default(""),
  leadId: z.string().default(""),
  dealId: z.string().default("")
});

function sortPlanTasks(tasks: PlanTask[]) {
  const statusWeight: Record<PlanTask["status"], number> = { active: 0, planned: 1, done: 2, cancelled: 3 };
  const priorityWeight: Record<PlanTask["priority"], number> = { high: 0, medium: 1, normal: 2 };
  return [...tasks].sort((left, right) => {
    return statusWeight[left.status] - statusWeight[right.status]
      || priorityWeight[left.priority] - priorityWeight[right.priority]
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
}

function validatePlanTaskBusinessRefs(user: SessionUser, refs: Pick<PlanTask, "customerId" | "leadId" | "dealId">) {
  const store = getStore();
  const customerId = refs.customerId || "";
  const leadId = refs.leadId || "";
  const dealId = refs.dealId || "";
  if (leadId && (customerId || dealId)) return "线索不能与客户或商机同时关联";
  if (leadId) {
    const lead = store.leads.find((item) => item.id === leadId && !item.deletedAt && canSeeOwner(user, item.ownerId, item.teamId));
    return lead ? "" : "关联线索不存在或无权访问";
  }
  if (dealId) {
    const deal = store.deals.find((item) => item.id === dealId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!deal) return "关联商机不存在或无权访问";
    if (customerId && customerId !== deal.customerId) return "商机与客户不匹配";
    const customer = store.customers.find((item) => item.id === deal.customerId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!customer) return "商机所属客户不存在或无权访问";
    return isPublicCustomer(customer) ? "公池客户请先领取后再创建计划任务" : "";
  }
  if (customerId) {
    const customer = store.customers.find((item) => item.id === customerId && canSeeOwner(user, item.ownerId, item.teamId));
    if (!customer) return "关联客户不存在或无权访问";
    return isPublicCustomer(customer) ? "公池客户请先领取后再创建计划任务" : "";
  }
  return "";
}

function normalizedPlanTaskRefs(user: SessionUser, refs: Pick<PlanTask, "customerId" | "leadId" | "dealId">) {
  if (!refs.dealId) return refs;
  const deal = getStore().deals.find((item) => item.id === refs.dealId && canSeeOwner(user, item.ownerId, item.teamId));
  return { ...refs, customerId: deal?.customerId || refs.customerId || "" };
}

const defaultPlanTemplateDrafts: Array<Omit<PlanTemplate, "id" | "ownerId" | "teamId" | "updatedAt">> = [
  { section: "knowledge", title: "产品分类地图", summary: "按产品线整理核心品类、典型型号、目标市场和应用场景。", output: "输出物：1页分类卡", badge: "必会", badgeTone: "green", phase: "前置知识", category: "产品知识", priority: "high", target: "完成核心产品分类卡和典型应用说明", description: "整理核心产品的型号、卖点、应用行业、常见客户问题和风险边界。", sortOrder: 10 },
  { section: "knowledge", title: "需求追问表", summary: "用途、规格、数量、预算、交期、认证、包装和贸易条款；必须能向客户追问。", output: "输出物：需求确认模板", badge: "必会", badgeTone: "green", phase: "前置知识", category: "需求训练", priority: "high", target: "形成可复制的英文需求确认表", description: "把用途、规格、数量、预算、交期、认证、包装和贸易条款整理成询盘追问模板。", sortOrder: 20 },
  { section: "knowledge", title: "证书与资料包", summary: "按产品归档目录、规格书、测试报告、认证文件、包装资料和常见问答。", output: "输出物：资料索引", badge: "资料化", badgeTone: "amber", phase: "前置知识", category: "资料维护", priority: "medium", target: "完成对外资料索引并标注适用产品", description: "按产品类型整理目录、规格书、认证和测试资料，避免客户索要资料时临时翻找。", sortOrder: 30 },
  { section: "knowledge", title: "行业应用场景", summary: "按目标市场整理终端用户、经销渠道、工程项目和 OEM 客户的采购场景。", output: "输出物：行业话术", badge: "场景", badgeTone: "", phase: "前置知识", category: "场景训练", priority: "medium", target: "每类客户写出1条切入话术和1个典型应用", description: "围绕目标国家和主要客户类型整理采购痛点、决策角色和首触达理由。", sortOrder: 40 },
  { section: "knowledge", title: "竞品替代口径", summary: "整理主要竞品的价格带、交期、渠道、卖点和替代边界。", output: "输出物：竞品对照表", badge: "谈判", badgeTone: "red", phase: "前置知识", category: "竞品研究", priority: "medium", target: "完成至少5个竞品品牌的替代切入点", description: "整理竞品主打产品、客户关注点、我方可替代卖点和风险边界。", sortOrder: 50 },
  { section: "persona", title: "进口商与经销商", summary: "关注稳定供货、利润空间、资料齐全、区域支持和快速响应。", output: "关键词：product distributor / importer / wholesaler / country\n首触达：目录、渠道政策、认证资料、热销型号", badge: "高匹配", badgeTone: "green", phase: "客户画像", category: "客户开发", priority: "high", target: "筛选30家高匹配经销商并完成首触达", description: "使用产品词加 distributor、importer、wholesaler 等关键词，按国家筛选官网、联系人、产品线和代理品牌。", sortOrder: 110 },
  { section: "persona", title: "项目采购商", summary: "关注规格匹配、交期、项目文件、质量保障和协同响应。", output: "关键词：project procurement / solution provider / country\n首触达：询问应用场景、采购清单、规格与交付要求", badge: "项目型", badgeTone: "aqua", phase: "客户画像", category: "客户开发", priority: "high", target: "筛选20家项目客户并确认采购场景", description: "围绕项目采购和解决方案关键词查找客户，首封邮件重点询问用途、规格、数量、交期和认证需求。", sortOrder: 120 },
  { section: "persona", title: "OEM 制造商", summary: "关注批量一致性、定制能力、长期价格、包装和交付稳定性。", output: "关键词：manufacturer / OEM supplier / private label\n首触达：发需求确认表、询问年用量和定制要求", badge: "批量型", badgeTone: "amber", phase: "客户画像", category: "客户开发", priority: "medium", target: "建立20家OEM客户名单并完成需求确认", description: "按产品和应用类型筛选OEM客户，重点记录年用量、现用产品、定制要求、包装和目标价。", sortOrder: 130 },
  { section: "persona", title: "工程承包商", summary: "关注认证、项目清单、交付风险、技术文件和投标资料。", output: "关键词：EPC contractor / project procurement\n首触达：索要 RFQ、项目清单、证书和交付要求", badge: "高价值", badgeTone: "red", phase: "客户画像", category: "客户开发", priority: "medium", target: "筛选15家工程客户并记录项目机会", description: "按目标行业筛选工程客户，邮件重点强调资料完整性、交付能力和项目配合经验。", sortOrder: 140 },
  { section: "execution", title: "第 1 天", summary: "整理产品分类与卖点卡；建立客户搜索关键词库 10 组。", output: "整理产品分类与卖点卡。\n建立客户搜索关键词库 10 组。", badge: "启动", badgeTone: "green", phase: "首周执行", category: "产品知识", priority: "high", target: "完成分类卡和10组关键词库", description: "先把产品分类、卖点卡和客户搜索关键词准备好，避免盲目找客户。", sortOrder: 210 },
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

// ---------------------------------------------------------------------------
// Peers (同行管理) — 互补 / 竞争 / 互相推荐
// ---------------------------------------------------------------------------
const peerRelationsSchema = z.array(z.enum(["互补", "竞争", "互相推荐"])).max(3).default([]);

function reminderRuleTitle(ruleType = "quote_no_reply") {
  const map: Record<string, string> = {
    quote_no_reply: "报价阶段停滞提醒",
    sample_feedback: "样品阶段待确认",
    inactive_customer: "长期未联系提醒",
    high_value_revisit: "高价值客户复访",
    custom_due: "商机下一动作到期提醒"
  };
  return map[ruleType] || "自定义跟进提醒";
}

function reminderTimeUnitText(timeUnit?: string) {
  return timeUnit === "minute" ? "分钟" : timeUnit === "hour" ? "小时" : timeUnit === "week" ? "周" : "天";
}

function reminderRuleText(rule: { ruleType?: string; targetStage?: string; days?: number; timeUnit?: string; channel?: string; priority?: string }) {
  const days = rule.days ?? 3;
  const unit = reminderTimeUnitText(rule.timeUnit);
  const stage = rule.targetStage || "已报价";
  if (rule.ruleType === "sample_feedback") return `进入样品阶段 ${days} ${unit}未更新时生成站内任务`;
  if (rule.ruleType === "inactive_customer") return `距离最后一次客户活动超过 ${days} ${unit}时生成站内任务`;
  if (rule.ruleType === "high_value_revisit") return `高价值或低健康度客户超过 ${days} ${unit}未活动时生成站内任务`;
  if (rule.ruleType === "custom_due") return `${stage}阶段商机下一动作到期后生成站内任务`;
  return `进入${stage}阶段 ${days} ${unit}未更新时生成站内任务`;
}

function resolveReminderTargetOwner(user: SessionUser, requestedOwnerId?: string) {
  const store = getStore();
  const targetOwnerId = requestedOwnerId || user.id;
  if (targetOwnerId !== user.id) return "";
  const target = store.users.find((item) => item.id === targetOwnerId);
  if (!target || !canSeeOwner(user, target.id, target.teamId)) return "";
  return target.id;
}

/**
 * 是否应当跳过这条匹配（即不建待办）—— `reminderSkipReason()` 的布尔封装。
 * 只在需要"数量"而不关心原因的地方用（如 preview 预检）。
 */
function shouldSkipReminderMatch(reminder: Reminder, triggerKey: string, now = Date.now()) {
  return reminderSkipReason(reminder, triggerKey, now) !== "";
}

export function registerWorkspaceRoutes(app: Express) {
  app.get("/api/daily-reports", requireAuth, (req, res) => {
    const query = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      ownerId: z.string().max(64).optional()
    }).parse(req.query);
    const store = getStore();
    const reports = store.dailyReports
      .filter((item) => canViewDailyReport(req.user!, item))
      .filter((item) => !query.from || item.reportDate >= query.from)
      .filter((item) => !query.to || item.reportDate <= query.to)
      .filter((item) => !query.ownerId || item.ownerId === query.ownerId)
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate) || right.updatedAt.localeCompare(left.updatedAt))
      .map(publicDailyReport);
    const visibleOwners = store.users
      .filter((item) => item.status === "active")
      .filter((item) => item.teamId === req.user!.teamId)
      .filter((item) => req.user!.iamDataScope?.tenantWide || req.user!.iamDataScope?.ownerIds.includes(item.id) || item.id === req.user!.id)
      .map((item) => collaborationUser(item.id));
    res.json({
      reports,
      owners: visibleOwners,
      canViewTeam: Boolean(req.user!.iamDataScope?.tenantWide || (req.user!.iamDataScope?.ownerIds.length || 0) > 1)
    });
  });

  app.post("/api/daily-reports", requireAuth, asyncRoute(async (req, res) => {
    const body = dailyReportBodySchema.parse(req.body);
    const store = getStore();
    const now = new Date().toISOString();
    let report = store.dailyReports.find((item) => item.ownerId === req.user!.id && item.reportDate === body.reportDate);
    const created = !report;
    if (report) {
      Object.assign(report, body, {
        status: "submitted" as const,
        submittedAt: now,
        updatedAt: now
      });
    } else {
      report = {
        id: `report_${randomUUID()}`,
        ...body,
        status: "submitted",
        ownerId: req.user!.id,
        teamId: req.user!.teamId,
        submittedAt: now,
        createdAt: now,
        updatedAt: now
      };
      store.dailyReports.unshift(report);
    }
    const recipients = store.users.filter((item) =>
      item.status === "active"
      && item.teamId === req.user!.teamId
      && hasIamPermission(publicUser(item), "daily_report.read")
      && item.id !== req.user!.id
    );
    recipients.forEach((recipient) => createInternalNotification({
      senderId: req.user!.id,
      recipientId: recipient.id,
      teamId: recipient.teamId,
      subject: `${req.user!.name}${created ? "提交" : "更新"}了 ${body.reportDate} 日报`,
      content: body.completedWork.slice(0, 240),
      relatedType: "daily_report",
      relatedId: report!.id
    }));
    await store.persist();
    res.status(created ? 201 : 200).json({ report: publicDailyReport(report), created });
  }));

  app.get("/api/daily-reports/:id", requireAuth, (req, res) => {
    const report = getStore().dailyReports.find((item) => item.id === req.params.id);
    if (!report || !canViewDailyReport(req.user!, report)) {
      res.status(404).json({ message: "日报不存在或无权查看" });
      return;
    }
    const comments = getStore().dailyReportComments
      .filter((item) => item.reportId === report.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicDailyReportComment);
    res.json({ report: publicDailyReport(report), comments });
  });

  app.post("/api/daily-reports/:id/comments", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      content: z.string().trim().min(1, "评论内容不能为空").max(2000),
      parentId: z.string().max(64).optional().default("")
    }).parse(req.body);
    const store = getStore();
    const report = store.dailyReports.find((item) => item.id === req.params.id);
    if (!report || !canViewDailyReport(req.user!, report)) {
      res.status(404).json({ message: "日报不存在或无权评论" });
      return;
    }
    const parent = body.parentId
      ? store.dailyReportComments.find((item) => item.id === body.parentId && item.reportId === report.id)
      : null;
    if (body.parentId && !parent) {
      res.status(400).json({ message: "回复的评论不存在" });
      return;
    }
    const now = new Date().toISOString();
    const comment = {
      id: `comment_${randomUUID()}`,
      reportId: report.id,
      parentId: parent?.id || "",
      content: body.content,
      authorId: req.user!.id,
      teamId: report.teamId,
      createdAt: now,
      updatedAt: now
    };
    store.dailyReportComments.push(comment);
    const recipientIds = new Set<string>([report.ownerId]);
    if (parent) recipientIds.add(parent.authorId);
    recipientIds.delete(req.user!.id);
    recipientIds.forEach((recipientId) => {
      const recipient = store.users.find((item) => item.id === recipientId && item.status === "active");
      if (!recipient) return;
      createInternalNotification({
        senderId: req.user!.id,
        recipientId,
        teamId: recipient.teamId,
        subject: parent ? `${req.user!.name}回复了你的日报评论` : `${req.user!.name}评论了你的日报`,
        content: body.content.slice(0, 240),
        relatedType: "daily_report",
        relatedId: report.id,
        threadId: `daily_report_${report.id}`
      });
    });
    await store.persist();
    res.status(201).json({ comment: publicDailyReportComment(comment) });
  }));

  app.get("/api/internal-messages/recipients", requireAuth, (req, res) => {
    const recipients = getStore().users
      .filter((item) => item.status === "active" && item.id !== req.user!.id)
      .filter((item) => canSeeOwner(req.user!, item.id, item.teamId))
      .map((item) => collaborationUser(item.id));
    res.json({ recipients });
  });

  app.get("/api/internal-messages/unread-count", requireAuth, (req, res) => {
    const unreadCount = getStore().internalMessages.filter((item) => item.recipientId === req.user!.id && !item.readAt).length;
    res.json({ unreadCount });
  });

  app.get("/api/internal-messages", requireAuth, (req, res) => {
    const box = z.enum(["inbox", "sent"]).catch("inbox").parse(req.query.box);
    const store = getStore();
    const messages = store.internalMessages
      .filter((item) => box === "sent" ? item.senderId === req.user!.id : item.recipientId === req.user!.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 300)
      .map(publicInternalMessage);
    res.json({
      messages,
      unreadCount: store.internalMessages.filter((item) => item.recipientId === req.user!.id && !item.readAt).length
    });
  });

  app.post("/api/internal-messages/read-all", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const readAt = new Date().toISOString();
    let updatedCount = 0;
    store.internalMessages.forEach((message) => {
      if (message.recipientId !== req.user!.id || message.readAt) return;
      message.readAt = readAt;
      message.updatedAt = readAt;
      updatedCount += 1;
    });
    if (updatedCount) await store.persist();
    res.json({ updatedCount, unreadCount: 0 });
  }));

  // Communication automation uses the signed CRM session to deliver a system
  // notification directly into the current user's inbox.
  app.post("/api/internal-messages/system", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      subject: z.string().trim().min(1).max(180),
      content: z.string().trim().min(1).max(5000),
      relatedId: z.string().max(128).optional().default(""),
      idempotencyKey: z.string().trim().min(1).max(256).optional()
    }).parse(req.body);
    if (body.idempotencyKey) {
      const existing = getStore().internalMessages.find((item) =>
        item.recipientId === req.user!.id && item.idempotencyKey === body.idempotencyKey
      );
      if (existing) {
        res.json({ message: publicInternalMessage(existing), deduplicated: true });
        return;
      }
    }
    const now = new Date().toISOString();
    const message = {
      id: `msg_${randomUUID()}`,
      threadId: `communication_${body.relatedId || randomUUID()}`,
      senderId: req.user!.id,
      recipientId: req.user!.id,
      teamId: req.user!.teamId,
      type: "system" as const,
      subject: body.subject,
      content: body.content,
      relatedType: "message" as const,
      relatedId: body.relatedId,
      idempotencyKey: body.idempotencyKey,
      readAt: "",
      createdAt: now,
      updatedAt: now
    };
    getStore().internalMessages.unshift(message);
    try {
      await getStore().persist();
    } catch (error) {
      getStore().internalMessages = getStore().internalMessages.filter((item) => item.id !== message.id);
      throw error;
    }
    res.status(201).json({ message: publicInternalMessage(message) });
  }));

  app.post("/api/internal-messages", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      recipientId: z.string().min(1).max(64),
      subject: z.string().trim().min(1, "请填写主题").max(180),
      content: z.string().trim().min(1, "请填写消息内容").max(5000),
      threadId: z.string().max(64).optional().default("")
    }).parse(req.body);
    const store = getStore();
    const recipient = store.users.find((item) => item.id === body.recipientId && item.status === "active");
    if (!recipient || recipient.id === req.user!.id) {
      res.status(400).json({ message: "收件人不可用" });
      return;
    }
    if (!canSeeOwner(req.user!, recipient.id, recipient.teamId)) {
      res.status(403).json({ message: "不能向其他团队发送站内信" });
      return;
    }
    const now = new Date().toISOString();
    const message = {
      id: `msg_${randomUUID()}`,
      threadId: body.threadId || `thread_${randomUUID()}`,
      senderId: req.user!.id,
      recipientId: recipient.id,
      teamId: recipient.teamId,
      type: "manual" as const,
      subject: body.subject,
      content: body.content,
      relatedType: "message" as const,
      relatedId: "",
      readAt: "",
      createdAt: now,
      updatedAt: now
    };
    store.internalMessages.unshift(message);
    await store.persist();
    res.status(201).json({ message: publicInternalMessage(message) });
  }));

  app.post("/api/internal-messages/:id/read", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const message = store.internalMessages.find((item) => item.id === req.params.id && item.recipientId === req.user!.id);
    if (!message) {
      res.status(404).json({ message: "站内信不存在" });
      return;
    }
    if (!message.readAt) {
      message.readAt = new Date().toISOString();
      message.updatedAt = message.readAt;
      await store.persist();
    }
    res.json({ message: publicInternalMessage(message) });
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
      related: z.string().default(""),
      customerId: z.string().optional(),
      triggerKey: z.string().min(1).max(256).optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    if (body.triggerKey) {
      const existing = store.todos.find((item) => item.ownerId === req.user!.id && item.triggerKey === body.triggerKey);
      if (existing) {
        res.json({ todo: existing, deduplicated: true });
        return;
      }
    }
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

  app.get("/api/plan-tasks", requireAuth, (req, res) => {
    const { planTasks } = getStore();
    const scoped = planTasks.filter((task) => canSeePersonalData(req.user!, task.ownerId));
    res.json({ tasks: sortPlanTasks(scoped) });
  });

  app.post("/api/plan-tasks", requireAuth, asyncRoute(async (req, res) => {
    const parsed = planTaskSchema.parse(req.body);
    const explicitRefError = validatePlanTaskBusinessRefs(req.user!, parsed);
    if (explicitRefError) {
      res.status(400).json({ message: explicitRefError });
      return;
    }
    const refs = normalizedPlanTaskRefs(req.user!, parsed);
    const refError = validatePlanTaskBusinessRefs(req.user!, refs);
    if (refError) {
      res.status(400).json({ message: refError });
      return;
    }
    const body = { ...parsed, ...refs };
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
    const requestedRefs = {
      customerId: body.customerId ?? task.customerId,
      leadId: body.leadId ?? task.leadId,
      dealId: body.dealId ?? task.dealId
    };
    const explicitRefError = validatePlanTaskBusinessRefs(req.user!, requestedRefs);
    if (explicitRefError) {
      res.status(400).json({ message: explicitRefError });
      return;
    }
    const refs = normalizedPlanTaskRefs(req.user!, requestedRefs);
    const refError = validatePlanTaskBusinessRefs(req.user!, refs);
    if (refError) {
      res.status(400).json({ message: refError });
      return;
    }
    Object.assign(task, body, refs, { updatedAt: new Date().toISOString() });
    await store.persist();
    res.json({ task });
  }));

  app.post("/api/plan-tasks/:id/complete", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ result: z.string().trim().min(1).max(2000) }).parse(req.body);
    const store = getStore();
    const task = store.planTasks.find((item) => item.id === req.params.id);
    if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
      res.status(404).json({ message: "计划任务不存在" });
      return;
    }
    if (task.status === "cancelled") {
      res.status(409).json({ message: "已取消任务不能标记完成" });
      return;
    }
    const now = new Date().toISOString();
    Object.assign(task, {
      status: "done" as const,
      completionResult: body.result,
      completedAt: now,
      cancellationReason: "",
      cancelledAt: "",
      updatedAt: now
    });
    await store.persist();
    res.json({ task });
  }));

  app.post("/api/plan-tasks/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
    const store = getStore();
    const task = store.planTasks.find((item) => item.id === req.params.id);
    if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
      res.status(404).json({ message: "计划任务不存在" });
      return;
    }
    if (task.status === "done") {
      res.status(409).json({ message: "已完成任务不能取消" });
      return;
    }
    const now = new Date().toISOString();
    Object.assign(task, {
      status: "cancelled" as const,
      cancellationReason: body.reason,
      cancelledAt: now,
      completionResult: "",
      completedAt: "",
      updatedAt: now
    });
    await store.persist();
    res.json({ task });
  }));

  app.post("/api/plan-tasks/:id/reschedule", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      dueAt: planTaskDueAtSchema.refine(Boolean, "请选择新的计划时间"),
      reason: z.string().trim().max(500).default("")
    }).parse(req.body);
    const store = getStore();
    const task = store.planTasks.find((item) => item.id === req.params.id);
    if (!task || !canSeePersonalData(req.user!, task.ownerId)) {
      res.status(404).json({ message: "计划任务不存在" });
      return;
    }
    if (task.status === "done" || task.status === "cancelled") {
      res.status(409).json({ message: "已结束任务不能改期" });
      return;
    }
    const now = new Date().toISOString();
    Object.assign(task, {
      rescheduledFrom: task.dueAt || "",
      dueAt: body.dueAt,
      rescheduledAt: now,
      rescheduleReason: body.reason,
      updatedAt: now
    });
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

  app.post("/api/todos/:id/complete", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ completionResult: z.string().trim().max(255).optional() });
    const body = schema.parse(req.body || {});
    const store = getStore();
    const todo = store.todos.find((item) => item.id === req.params.id);
    if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
      res.status(404).json({ message: "待办不存在" });
      return;
    }
    if (todo.reminderRuleId && !body.completionResult) {
      res.status(400).json({ message: "请填写本次跟进处理结果" });
      return;
    }
    todo.done = true;
    todo.status = "pending";
    todo.completedAt = new Date().toISOString();
    todo.completedBy = req.user!.id;
    todo.completionResult = body.completionResult || todo.completionResult;
    await store.persist();
    await synchronizeWhatsAppFollowup(todo, req.user!, "completed");
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
    if (todo.cancelledAt) {
      res.status(409).json({
        message: todo.cancellationReason
          ? `该待办已取消：${todo.cancellationReason}`
          : "该待办已取消，不能恢复"
      });
      return;
    }
    todo.historyAt = "";
    todo.dueAt = currentMinuteText();
    todo.sortOrder = nextTodoSortOrder(store.todos, todo.ownerId);
    todo.pinState = "";
    if (todo.status === "in_progress" && todo.done) todo.status = "pending";
    await store.persist();
    await synchronizeWhatsAppFollowup(todo, req.user!, "pending");
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
      ,
      snoozeReason: z.string().trim().max(255).optional(),
      completionResult: z.string().trim().max(255).optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const todo = store.todos.find((item) => item.id === req.params.id);
    if (!todo || !canSeePersonalData(req.user!, todo.ownerId)) {
      res.status(404).json({ message: "待办不存在" });
      return;
    }
    if (todo.cancelledAt
      && (body.done === false || body.historyAt === "")) {
      res.status(409).json({
        message: todo.cancellationReason
          ? `该待办已取消：${todo.cancellationReason}`
          : "该待办已取消，不能重新启用"
      });
      return;
    }
    if (typeof body.done === "boolean") {
      if (body.done && todo.reminderRuleId && !body.completionResult) {
        res.status(400).json({ message: "请填写本次跟进处理结果" });
        return;
      }
      todo.done = body.done;
      if (body.done) {
        todo.status = "pending";
        todo.completedAt = new Date().toISOString();
        todo.completedBy = req.user!.id;
        todo.completionResult = body.completionResult || "";
      } else {
        todo.completedAt = "";
        todo.completedBy = "";
        todo.completionResult = "";
      }
    }
    if (body.status) {
      todo.status = todo.done ? "pending" : body.status;
    }
    if (body.title) todo.title = body.title;
    if (body.type) todo.type = body.type;
    if (body.priority) todo.priority = body.priority;
    if (body.dueAt !== undefined) {
      if (todo.reminderRuleId && body.dueAt !== todo.dueAt) {
        if (!body.snoozeReason) {
          res.status(400).json({ message: "延期提醒请填写原因" });
          return;
        }
        todo.snoozedFrom = todo.dueAt;
        todo.snoozeReason = body.snoozeReason;
        todo.snoozeCount = (todo.snoozeCount || 0) + 1;
        todo.snoozedBy = req.user!.id;
      }
      todo.dueAt = body.dueAt;
    }
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
    if (typeof body.done === "boolean") await synchronizeWhatsAppFollowup(todo, req.user!, body.done ? "completed" : "pending");
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
    if (todo.reminderRuleId) {
      res.status(400).json({ message: "跟进提醒需完成或标记无需处理，不能直接删除" });
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
      category: z.string().min(1).default("其它"),
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
    const now = new Date().toISOString();
    const problem = {
      id: `p_${Date.now()}`,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      createdAt: now,
      resolvedAt: body.status === "resolved" ? now : "",
      ...body
    };
    store.problems.unshift(problem);
    await store.persist();
    res.json({ problem });
  }));

  app.patch("/api/problems/:id", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1).optional(),
      category: z.string().min(1).optional(),
      severity: z.enum(["high", "medium", "low"]).optional(),
      status: z.enum(["open", "solving", "resolved"]).optional(),
      relatedCustomer: z.string().optional(),
      rootCause: z.string().optional(),
      solution: z.string().optional(),
      nextAction: z.string().optional(),
      dueAt: z.string().optional()
    }).refine((body) => Object.keys(body).length > 0, "至少需要修改一个字段");
    const body = schema.parse(req.body);
    const store = getStore();
    const problem = store.problems.find((item) => item.id === req.params.id);
    if (!problem || !canSeeOwner(req.user!, problem.ownerId, problem.teamId)) {
      res.status(404).json({ message: "问题不存在或无权访问" });
      return;
    }
    if (body.status) problem.resolvedAt = body.status === "resolved" ? (problem.resolvedAt || new Date().toISOString()) : "";
    Object.assign(problem, body);
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
    problem.resolvedAt = body.status === "resolved" ? (problem.resolvedAt || new Date().toISOString()) : "";
    await store.persist();
    res.json({ problem });
  }));

  app.delete("/api/problems/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.problems.findIndex((item) => item.id === req.params.id);
    const problem = index >= 0 ? store.problems[index] : null;
    if (!problem || !canSeeOwner(req.user!, problem.ownerId, problem.teamId)) {
      res.status(404).json({ message: "问题不存在或无权访问" });
      return;
    }
    store.problems.splice(index, 1);
    await store.persist();
    res.json({ ok: true, id: problem.id });
  }));

  app.get("/api/memos", requireAuth, (req, res) => {
    const { memos } = getStore();
    const trash = req.query.trash === "true";
    const scoped = memos.filter((memo) => canSeePersonalData(req.user!, memo.ownerId) && (trash ? Boolean(memo.deletedAt) : !memo.deletedAt));
    res.json({ memos: scoped });
  });

  app.post("/api/memos", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1),
      content: z.string().default(""),
      category: z.string().min(1).default("客户备忘"),
      tags: z.string().default(""),
      customerId: z.string().trim().default(""),
      dealId: z.string().trim().default(""),
      pinned: z.boolean().default(false)
    });
    const body = schema.parse(req.body);
    const store = getStore();
    let customerId = body.customerId;
    if (body.dealId) {
      const deal = store.deals.find((item) => item.id === body.dealId && canSeeOwner(req.user!, item.ownerId, item.teamId));
      if (!deal) {
        res.status(400).json({ message: "关联商机不存在或无权访问" });
        return;
      }
      if (customerId && customerId !== deal.customerId) {
        res.status(400).json({ message: "关联客户与商机不一致" });
        return;
      }
      customerId = deal.customerId;
    }
    if (customerId && !store.customers.some((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId))) {
      res.status(400).json({ message: "关联客户不存在或无权访问" });
      return;
    }
    const memo = {
      id: `m_${Date.now()}`,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      archived: false,
      deletedAt: "",
      updatedAt: new Date().toISOString(),
      ...body,
      customerId
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
      customerId: z.string().trim().optional(),
      dealId: z.string().trim().optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const memo = store.memos.find((item) => item.id === req.params.id);
    if (!memo || !canSeePersonalData(req.user!, memo.ownerId) || memo.deletedAt) {
      res.status(404).json({ message: "备忘录不存在" });
      return;
    }
    const hasCustomerId = Object.prototype.hasOwnProperty.call(body, "customerId");
    const hasDealId = Object.prototype.hasOwnProperty.call(body, "dealId");
    let customerId = hasCustomerId ? body.customerId || "" : memo.customerId;
    const dealId = hasDealId ? body.dealId || "" : memo.dealId;
    if (dealId) {
      const deal = store.deals.find((item) => item.id === dealId && canSeeOwner(req.user!, item.ownerId, item.teamId));
      if (!deal) {
        res.status(400).json({ message: "关联商机不存在或无权访问" });
        return;
      }
      if (customerId && customerId !== deal.customerId) {
        res.status(400).json({ message: "关联客户与商机不一致" });
        return;
      }
      customerId = deal.customerId;
    }
    if (customerId && !store.customers.some((item) => item.id === customerId && canSeeOwner(req.user!, item.ownerId, item.teamId))) {
      res.status(400).json({ message: "关联客户不存在或无权访问" });
      return;
    }
    if (typeof body.title === "string") memo.title = body.title;
    if (typeof body.content === "string") memo.content = body.content;
    if (typeof body.category === "string") memo.category = body.category;
    if (typeof body.tags === "string") memo.tags = body.tags;
    if (hasCustomerId || hasDealId) memo.customerId = customerId;
    if (hasDealId) memo.dealId = dealId;
    if (typeof body.pinned === "boolean") memo.pinned = body.pinned;
    if (typeof body.archived === "boolean") memo.archived = body.archived;
    memo.updatedAt = new Date().toISOString();
    await store.persist();
    res.json({ memo });
  }));

  app.delete("/api/memos/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const memo = store.memos.find((item) => item.id === req.params.id);
    if (!memo || !canSeePersonalData(req.user!, memo.ownerId)) {
      res.status(404).json({ message: "备忘录不存在" });
      return;
    }
    if (!memo.deletedAt) {
      memo.deletedAt = new Date().toISOString();
      memo.updatedAt = memo.deletedAt;
    }
    await store.persist();
    res.json({ ok: true, memo });
  }));

  app.post("/api/memos/:id/restore", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const memo = store.memos.find((item) => item.id === req.params.id);
    if (!memo || !canSeePersonalData(req.user!, memo.ownerId) || !memo.deletedAt) {
      res.status(404).json({ message: "已删除备忘录不存在" });
      return;
    }
    memo.deletedAt = "";
    memo.updatedAt = new Date().toISOString();
    await store.persist();
    res.json({ memo });
  }));

  app.delete("/api/memos/:id/permanent", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.memos.findIndex((item) => item.id === req.params.id);
    const memo = index >= 0 ? store.memos[index] : null;
    if (!memo || !canSeePersonalData(req.user!, memo.ownerId) || !memo.deletedAt) {
      res.status(404).json({ message: "已删除备忘录不存在" });
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

  app.get("/api/peers", requireAuth, (req, res) => {
    const { peers } = getStore();
    const scoped = peers.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId));
    res.json({ peers: scoped });
  });

  app.post("/api/peers", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      company: z.string().trim().min(1).max(200),
      country: z.string().trim().max(80).default(""),
      industry: z.string().max(4000).default(""),
      relations: peerRelationsSchema,
      contact: z.string().trim().max(120).default(""),
      phone: z.string().trim().max(80).default(""),
      email: z.string().trim().max(160).default(""),
      wechat: z.string().trim().max(80).default(""),
      website: z.string().trim().max(255).default(""),
      remark: z.string().max(2000).default(""),
      source: z.string().trim().max(120).default("手动新增")
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const duplicate = store.peers.find((item) =>
      item.teamId === req.user!.teamId
      && entityDuplicateKey(item.company, item.country) === entityDuplicateKey(body.company, body.country)
    );
    if (duplicate) {
      res.status(409).json({
        message: `同行已存在：「${duplicate.company}」（${duplicate.country || "国家未知"}）已在同行列表中，不能重复添加`,
        errorCode: "PEER_DUPLICATE",
        existingId: duplicate.id
      });
      return;
    }
    const now = new Date().toISOString();
    const peer = {
      id: `peer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      createdAt: now,
      updatedAt: now,
      ...body,
      relations: [...new Set(body.relations)] as PeerRelation[]
    };
    store.peers.unshift(peer);
    await store.persist();
    res.json({ peer });
  }));

  app.post("/api/peers/import", requireAuth, asyncRoute(async (req, res) => {
    const rowSchema = z.object({
      company: z.string().trim().min(1).max(200),
      country: z.string().trim().max(80).default(""),
      industry: z.string().max(4000).default(""),
      relations: z.array(z.enum(["互补", "竞争", "互相推荐"])).max(3).default([]),
      contact: z.string().trim().max(120).default(""),
      phone: z.string().trim().max(80).default(""),
      email: z.string().trim().max(160).default(""),
      wechat: z.string().trim().max(80).default(""),
      website: z.string().trim().max(255).default(""),
      remark: z.string().max(2000).default(""),
      source: z.string().trim().max(120).default("批量导入")
    });
    const body = z.object({
      peers: z.array(rowSchema).min(1).max(500),
      skipDuplicates: z.boolean().default(true)
    }).parse(req.body);
    const store = getStore();
    const seenInBatch = new Set<string>();
    const created: unknown[] = [];
    const skipped: Array<{ company: string; reason: string }> = [];
    for (const row of body.peers) {
      const key = entityDuplicateKey(row.company, row.country);
      const duplicate = store.peers.find((item) =>
        item.teamId === req.user!.teamId
        && entityDuplicateKey(item.company, item.country) === key
      ) || (seenInBatch.has(key) ? { company: row.company } : null);
      if (duplicate) {
        if (body.skipDuplicates) {
          skipped.push({ company: row.company, reason: "与已有同行重复（公司名+国家相同）" });
          continue;
        }
        res.status(409).json({
          message: `导入中止：「${row.company}」与已有同行重复（公司名+国家相同），已创建 ${created.length} 条`,
          errorCode: "PEER_DUPLICATE",
          created: created.length,
          skipped
        });
        return;
      }
      seenInBatch.add(key);
      const now = new Date().toISOString();
      const peer = {
        id: `peer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ownerId: req.user!.id,
        teamId: req.user!.teamId,
        createdAt: now,
        updatedAt: now,
        ...row,
        relations: [...new Set(row.relations)] as PeerRelation[]
      };
      store.peers.unshift(peer);
      created.push(peer);
    }
    if (created.length) await store.persist();
    res.json({
      created: created.length,
      skipped,
      peers: store.peers.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
    });
  }));

  app.patch("/api/peers/:id", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      company: z.string().trim().min(1).max(200).optional(),
      country: z.string().trim().max(80).optional(),
      industry: z.string().max(4000).optional(),
      relations: peerRelationsSchema.optional(),
      contact: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(80).optional(),
      email: z.string().trim().max(160).optional(),
      wechat: z.string().trim().max(80).optional(),
      website: z.string().trim().max(255).optional(),
      remark: z.string().max(2000).optional(),
      source: z.string().trim().max(120).optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const peer = store.peers.find((item) => item.id === req.params.id);
    if (!peer || !canSeeOwner(req.user!, peer.ownerId, peer.teamId)) {
      res.status(404).json({ message: "同行不存在或无权访问" });
      return;
    }
    if (peer.ownerId !== req.user!.id) {
      res.status(403).json({ message: "只有归属人可以修改同行资料" });
      return;
    }
    if (body.company !== undefined || body.country !== undefined) {
      const nextCompany = body.company ?? peer.company;
      const nextCountry = body.country ?? peer.country;
      const duplicate = store.peers.find((item) =>
        item.id !== peer.id
        && item.teamId === req.user!.teamId
        && entityDuplicateKey(item.company, item.country) === entityDuplicateKey(nextCompany, nextCountry)
      );
      if (duplicate) {
        res.status(409).json({
          message: `同行已存在：「${duplicate.company}」（${duplicate.country || "国家未知"}）不能与现有同行重名`,
          errorCode: "PEER_DUPLICATE",
          existingId: duplicate.id
        });
        return;
      }
    }
    Object.assign(peer, body, body.relations ? { relations: [...new Set(body.relations)] as PeerRelation[] } : {}, {
      updatedAt: new Date().toISOString()
    });
    await store.persist();
    res.json({ peer });
  }));

  app.delete("/api/peers/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const peer = store.peers.find((item) => item.id === req.params.id);
    if (!peer || !canSeeOwner(req.user!, peer.ownerId, peer.teamId)) {
      res.status(404).json({ message: "同行不存在或无权访问" });
      return;
    }
    if (peer.ownerId !== req.user!.id) {
      res.status(403).json({ message: "只有归属人可以删除同行" });
      return;
    }
    store.peers = store.peers.filter((item) => item.id !== peer.id);
    await store.persist();
    res.json({ deleted: peer.id, peers: store.peers.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId)) });
  }));

  app.get("/api/case-studies", requireAuth, (req, res) => {  const { caseStudies } = getStore();
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
      channel: z.literal("站内").default("站内"),
      ruleType: z.enum(["quote_no_reply", "sample_feedback", "inactive_customer", "high_value_revisit", "custom_due"]).default("quote_no_reply"),
      targetStage: z.string().default("已报价"),
      days: z.number().int().min(0).max(365).default(3),
      timeUnit: z.enum(["minute", "day", "hour", "week"]).default("day"),
      targetCustomerIds: z.array(z.string().min(1)).max(500).optional().default([]),
      // 「生成待办中心任务」勾选项：契约默认 false（不生成），界面上是默认不勾选。
      generateTodo: z.boolean().default(false),
      priority: z.enum(["high", "medium", "normal"]).default("medium"),
      enabled: z.boolean().default(true),
      targetOwnerId: z.string().optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const targetOwnerId = resolveReminderTargetOwner(req.user!, body.targetOwnerId);
    if (!targetOwnerId) {
      res.status(400).json({ message: "提醒规则目标负责人无效" });
      return;
    }
    const generatedCount = matchReminderRule(targetOwnerId, body).length;
    const reminder = {
      id: `r_${Date.now()}`,
      title: body.title || reminderRuleTitle(body.ruleType),
      rule: body.rule || reminderRuleText(body),
      dueAt: body.dueAt,
      channel: body.channel,
      ruleType: body.ruleType,
      targetStage: body.targetStage,
      days: body.days,
      timeUnit: body.timeUnit,
      targetCustomerIds: body.targetCustomerIds,
      generateTodo: body.generateTodo,
      priority: body.priority,
      enabled: body.enabled,
      generatedCount,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      targetOwnerId,
      status: body.enabled ? "enabled" as const : "disabled" as const
    };
    store.reminders.unshift(reminder);
    await store.persist();
    res.json({ reminder });
  }));

  app.patch("/api/reminders/:id", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      title: z.string().min(1).optional(),
      rule: z.string().min(1).optional(),
      dueAt: z.string().min(1).optional(),
      ruleType: z.enum(["quote_no_reply", "sample_feedback", "inactive_customer", "high_value_revisit", "custom_due"]).optional(),
      targetStage: z.string().optional(),
      days: z.number().int().min(0).max(365).optional(),
      timeUnit: z.enum(["minute", "day", "hour", "week"]).optional(),
      targetCustomerIds: z.array(z.string().min(1)).max(500).optional(),
      generateTodo: z.boolean().optional(),
      priority: z.enum(["high", "medium", "normal"]).optional(),
      enabled: z.boolean().optional(),
      targetOwnerId: z.string().optional()
    });
    const body = schema.parse(req.body);
    const store = getStore();
    const reminder = store.reminders.find((item) => item.id === req.params.id);
    if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
      res.status(404).json({ message: "提醒规则不存在" });
      return;
    }
    const targetOwnerId = body.targetOwnerId === undefined ? (reminder.targetOwnerId || reminder.ownerId) : resolveReminderTargetOwner(req.user!, body.targetOwnerId);
    if (!targetOwnerId) {
      res.status(400).json({ message: "提醒规则目标负责人无效" });
      return;
    }
    Object.assign(reminder, body, { targetOwnerId, channel: "站内", status: body.enabled === false || (body.enabled === undefined && reminder.enabled === false) ? "disabled" : "enabled" });
    reminder.generatedCount = matchReminderRule(targetOwnerId, reminder).length;
    await store.persist();
    res.json({ reminder });
  }));

  app.get("/api/reminders/:id/preview", requireAuth, (req, res) => {
    const store = getStore();
    const reminder = store.reminders.find((item) => item.id === req.params.id);
    if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
      res.status(404).json({ message: "提醒规则不存在" });
      return;
    }
    if (!hasIamPermission(req.user, "reminder.manage")) {
      res.status(403).json({ message: "当前账号没有维护提醒规则的权限" });
      return;
    }
    const matched = matchReminderRule(reminder.targetOwnerId || reminder.ownerId, reminder);
    const preview = matched.slice(0, 5).map((item) => ({ customerId: item.customer.id, customer: item.customer.company, dealId: item.deal?.id || "", deal: item.deal?.title || "", dueAt: item.dueAt }));
    const skippedCount = matched.filter((item) => shouldSkipReminderMatch(reminder, `${reminder.id}:${item.triggerKey}`)).length;
    res.json({ matchedCount: matched.length, creatableCount: matched.length - skippedCount, skippedCount, preview });
  });

  app.post("/api/reminders/:id/run", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const reminder = store.reminders.find((item) => item.id === req.params.id);
    if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
      res.status(404).json({ message: "提醒规则不存在" });
      return;
    }
    if (!hasIamPermission(req.user, "reminder.manage")) {
      res.status(403).json({ message: "当前账号没有维护提醒规则的权限" });
      return;
    }
    if (reminder.enabled === false) {
      res.status(400).json({ message: "提醒规则已停用" });
      return;
    }
    const result = await runReminderRuleNow(reminder, req.user!.id, { persistWhenNoChanges: true });
    res.json({
      reminder: result.reminder,
      createdCount: result.createdCount,
      matchedCount: result.matchedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      todos: result.todos
    });
  }));

  app.post("/api/reminders/:id/toggle", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const reminder = store.reminders.find((item) => item.id === req.params.id);
    if (!reminder || !canSeeOwner(req.user!, reminder.ownerId, reminder.teamId)) {
      res.status(404).json({ message: "提醒不存在" });
      return;
    }
    if (!hasIamPermission(req.user, "reminder.manage")) {
      res.status(403).json({ message: "当前账号没有维护提醒规则的权限" });
      return;
    }
    reminder.enabled = reminder.enabled === false;
    reminder.status = reminder.enabled ? "enabled" : "disabled";
    await store.persist();
    res.json({ reminder });
  }));
}
