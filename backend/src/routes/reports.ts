/**
 * 工作台汇总、报表路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { z } from "zod";
import { canSeeOwner, canSeePersonalData, requireAuth } from "../auth.js";
import { type Customer, type Deal, type Todo } from "../types.js";
import { getStore } from "../store.js";
import {
  archiveExpiredTodos,
  asyncRoute,
  canAccessExam,
  canManageTraining,
  canSeeKnowledgeAsset,
  currentMinuteText,
  examReport,
  roundMoneyValue
} from "../server-core.js";

function isHistoricalTodo(todo: Todo) {
  return Boolean(todo.historyAt);
}

function priorityWeight(priority: string) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
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
  const stages = ["询盘", "已联系", "已报价", "样品", "谈判"];
  const activeDeals = deals.filter((deal) => !deal.archivedAt && deal.stage !== "丢单" && deal.stage !== "成交");
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
      tone: riskCount ? "amber" : "aqua"
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

const reportStageWeights: Record<string, number> = {
  询盘: 0.05,
  已联系: 0.1,
  已报价: 0.3,
  样品: 0.5,
  谈判: 0.7
};

function reportDate(value: Date) {
  const pad = (item: number) => String(item).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function reportMoneyRows(deals: Deal[], amountFor: (deal: Deal) => number = (deal) => deal.amount) {
  const totals = new Map<string, number>();
  deals.forEach((deal) => {
    const currency = deal.currency || "未设置";
    totals.set(currency, roundMoneyValue((totals.get(currency) || 0) + amountFor(deal)));
  });
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((left, right) => right.amount - left.amount || left.currency.localeCompare(right.currency));
}

function reportRegion(country: string) {
  const value = country.toLowerCase();
  if (["瑞典", "德国", "法国", "英国", "意大利", "西班牙", "荷兰", "波兰", "欧洲", "sweden", "germany", "france", "united kingdom", "italy", "spain", "netherlands", "poland"].some((item) => value.includes(item))) return "欧洲";
  if (["美国", "加拿大", "墨西哥", "usa", "united states", "canada", "mexico"].some((item) => value.includes(item))) return "北美";
  if (["阿联酋", "沙特", "卡塔尔", "科威特", "以色列", "土耳其", "中东", "uae", "saudi", "qatar", "kuwait", "israel", "turkey"].some((item) => value.includes(item))) return "中东";
  if (["中国", "日本", "韩国", "新加坡", "印度", "泰国", "越南", "马来西亚", "亚洲", "china", "japan", "korea", "singapore", "india", "thailand", "vietnam", "malaysia"].some((item) => value.includes(item))) return "亚洲";
  return "其他";
}

export function registerReportsRoutes(app: Express) {
  app.get("/api/dashboard/summary", requireAuth, (req, res) => {
    const store = getStore();
    const archived = archiveExpiredTodos(store.todos, new Date());
    if (archived.length) void store.persist();
    const { customers, todos, deals, reminders, knowledgeAssets, exams, wecomMessages, leads } = store;
    const scopedCustomers = customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
    const scopedLeads = leads.filter((lead) => canSeeOwner(req.user!, lead.ownerId, lead.teamId));
    const activeLeads = scopedLeads.filter((lead) => !lead.deletedAt && lead.status !== "invalid");
    const filteredLeads = scopedLeads.filter((lead) => Boolean(lead.deletedAt) || lead.status === "invalid");
    const pendingCleanLeads = activeLeads.filter((lead) => lead.status === "new");
    const validLeads = activeLeads.filter((lead) => lead.status === "following" || lead.status === "converted");
    const customerLeads = activeLeads.filter((lead) => Boolean(lead.convertedCustomerId));
    const dealLeads = activeLeads.filter((lead) => Boolean(lead.convertedDealId));
    const chinaDateKey = (value: string | Date) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const todayKey = chinaDateKey(new Date());
    const todayLeadCount = activeLeads.filter((lead) => chinaDateKey(lead.createdAt) === todayKey).length;
    const leadFunnelCounts = [
      { key: "entered", label: "进入系统", count: activeLeads.length },
      { key: "pending", label: "待清洗", count: pendingCleanLeads.length },
      { key: "valid", label: "有效线索", count: validLeads.length },
      { key: "customer", label: "已转客户", count: customerLeads.length },
      { key: "deal", label: "已建商机", count: dealLeads.length }
    ];
    const scopedTodos = todos.filter((todo) => canSeePersonalData(req.user!, todo.ownerId));
    const scopedDeals = deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
    const scopedReminders = reminders.filter((reminder) => canSeeOwner(req.user!, reminder.ownerId, reminder.teamId));
    const scopedKnowledge = knowledgeAssets.filter((asset) => canSeeKnowledgeAsset(req.user!, asset));
    const scopedMessages = wecomMessages.filter((message) => canSeeOwner(req.user!, message.ownerId, message.teamId));
    const scopedExams = exams.filter((exam) => canAccessExam(req.user!, exam));
    const scopedExamReport = examReport(req.user!);
    const addDateKeyDays = (dateKey: string, days: number) => {
      const [year, month, day] = dateKey.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day + days));
      return date.toISOString().slice(0, 10);
    };
    const [todayYear, todayMonth] = todayKey.split("-").map(Number);
    const todayWeekday = new Date(`${todayKey}T12:00:00+08:00`).getUTCDay();
    const weekStartKey = addDateKeyDays(todayKey, -(todayWeekday === 0 ? 6 : todayWeekday - 1));
    const weekEndKey = addDateKeyDays(weekStartKey, 6);
    const monthStartKey = `${todayKey.slice(0, 7)}-01`;
    const monthEndKey = new Date(Date.UTC(todayYear, todayMonth, 0)).toISOString().slice(0, 10);
    const activeTodos = scopedTodos.filter((todo) => !isHistoricalTodo(todo));
    const pendingTodos = activeTodos.filter((todo) => !todo.done);
    const overdueTodos = pendingTodos.filter((todo) => todo.priority === "high");
    const historyTodos = scopedTodos.filter(isHistoricalTodo);
    const riskCustomers = scopedCustomers.filter((customer) => customer.nextReminder.includes("逾期") || customer.health < 60);
    const riskAmount = riskCustomers.reduce((sum, customer) => sum + customer.amount, 0);
    const forecastAmount = scopedDeals.reduce((sum, deal) => sum + deal.amount, 0);
    const wecomBound = scopedCustomers.filter((customer) => customer.wecomBound).length;
    const pendingKnowledge = scopedKnowledge.filter((asset) => asset.status !== "published");
    const publishedExams = scopedExams.filter((exam) => exam.status === "published");
    const averagePassRate = scopedExamReport.totalAttempts ? Math.round((scopedExamReport.passedAttempts / scopedExamReport.totalAttempts) * 100) : 0;
    const pendingMessages = scopedMessages.filter((message) => message.status === "pending");
    const dashboardScope = req.user!.iamDataScope;
    const activeTeamOwnerIds = new Set(store.users
      .filter((user) => user.status === "active" && user.teamId === req.user!.teamId)
      .map((user) => user.id));
    const hasFullTeamDashboardScope = Boolean(dashboardScope?.tenantWide)
      || Boolean(dashboardScope?.ownerIds.length && [...activeTeamOwnerIds].every((ownerId) => dashboardScope.ownerIds.includes(ownerId)));
    const readyDeals = scopedDeals.filter((deal) => ["已报价", "样品", "谈判"].includes(deal.stage));
    const topTodos = [...pendingTodos].sort((a, b) => (b.impactAmount || 0) - (a.impactAmount || 0) || priorityWeight(b.priority) - priorityWeight(a.priority)).slice(0, 3);
    const priorityTasks = buildPriorityTasks(scopedDeals, scopedCustomers, pendingTodos);
    const topDeals = priorityTasks.map((task) => task.deal);
    const pipelineHealth = buildPipelineHealth(scopedDeals, scopedCustomers);
    const todoDueDateKey = (dueAt: string) => {
      const value = dueAt.trim();
      const explicitDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
      if (explicitDate) return explicitDate[1];
      if (value.includes("后天")) return addDateKeyDays(todayKey, 2);
      if (value.includes("明天")) return addDateKeyDays(todayKey, 1);
      if (value.includes("今天") || /^\d{1,2}:\d{2}$/.test(value)) return todayKey;
      const weekDay = value.match(/本周([一二三四五六日天])/);
      if (weekDay) {
        const dayIndex = "一二三四五六日天".indexOf(weekDay[1]);
        return addDateKeyDays(weekStartKey, Math.min(dayIndex, 6));
      }
      return "";
    };
    const periodMoneyText = (rows: Array<{ currency: string; amount: number }>) => rows.length
      ? rows.map((row) => `${row.currency} ${Math.round(row.amount).toLocaleString("en-US")}`).join("、")
      : "暂无预计成交金额";
    const buildPeriodSummary = (label: string, start: string, end: string) => {
      const expectedDeals = scopedDeals.filter((deal) => {
        if (!deal.expectedCloseAt) return false;
        const expectedDateKey = chinaDateKey(deal.expectedCloseAt);
        return expectedDateKey >= start && expectedDateKey <= end;
      });
      const periodTodos = pendingTodos.filter((todo) => {
        const dueDateKey = todoDueDateKey(todo.dueAt);
        return dueDateKey >= start && dueDateKey <= end;
      });
      const highPriorityTodos = periodTodos.filter((todo) => todo.priority === "high");
      const newLeads = activeLeads.filter((lead) => {
        const createdDateKey = chinaDateKey(lead.createdAt);
        return createdDateKey >= start && createdDateKey <= end;
      });
      const expectedAmounts = reportMoneyRows(expectedDeals);
      const topExpectedDeal = [...expectedDeals].sort((left, right) => right.amount - left.amount)[0];
      const title = highPriorityTodos.length
        ? `${label}最该优先处理 ${highPriorityTodos.length} 个高优先级待办，并跟进 ${expectedDeals.length} 个预计成交商机。`
        : expectedDeals.length
          ? `${label}有 ${expectedDeals.length} 个预计成交商机，建议围绕成交节点集中推进。`
          : `${label}暂无预计成交商机，建议优先补充线索、推进报价并校准成交日期。`;
      const description = topExpectedDeal
        ? `金额最高的是“${topExpectedDeal.title}”，预计成交金额为 ${topExpectedDeal.currency} ${Math.round(topExpectedDeal.amount).toLocaleString("en-US")}。`
        : newLeads.length
          ? `${label}新增 ${newLeads.length} 条线索，可优先完成清洗并转入客户或商机。`
          : `${label}暂未形成新的成交节点，建议检查活跃商机是否缺少预计成交日期。`;
      const action = highPriorityTodos.length
        ? `先完成 ${highPriorityTodos.length} 个高优先级待办，再逐一确认预计成交商机的决策人、付款条件和下一步。`
        : expectedDeals.length
          ? `逐一核对 ${expectedDeals.length} 个预计成交商机的关键人、报价反馈和下一步时间。`
          : `清洗新增线索、推进有效报价，并为活跃商机补全预计成交日期。`;
      return {
        label,
        start,
        end,
        expectedDeals: expectedDeals.length,
        expectedAmounts,
        pendingTodos: periodTodos.length,
        highPriorityTodos: highPriorityTodos.length,
        newLeads: newLeads.length,
        briefing: {
          title,
          description,
          basis: `${periodTodos.length} 个周期待办、${highPriorityTodos.length} 个高优先级待办、${newLeads.length} 条新增线索、${expectedDeals.length} 个预计成交商机。`,
          action,
          impact: expectedDeals.length
            ? `${label}预计成交 ${periodMoneyText(expectedAmounts)}，应优先降低成交日期延误风险。`
            : `${label}暂无预计成交金额，补齐商机日期和推进动作后才能形成可靠预测。`
        }
      };
    };
    const periods = {
      today: buildPeriodSummary("今日", todayKey, todayKey),
      week: buildPeriodSummary("本周", weekStartKey, weekEndKey),
      month: buildPeriodSummary("本月", monthStartKey, monthEndKey)
    };
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
    const businessScopeLabel = hasFullTeamDashboardScope
      ? "本团队业务"
      : (dashboardScope?.ownerIds.length || 0) > 1 ? "授权组织业务" : "本人业务";
    res.json({
      scope: hasFullTeamDashboardScope
        ? "本团队业务数据，本人待办"
        : (dashboardScope?.ownerIds.length || 0) > 1 ? "授权组织业务数据，本人待办" : "本人业务数据，本人待办",
      scopeLabels: {
        business: businessScopeLabel,
        todos: "本人待办"
      },
      updatedAt: new Date().toISOString(),
      periods,
      briefing: {
        title: pendingTodos.length
          ? `今天最该处理的是 ${pendingTodos.length} 个待办，其中 ${overdueTodos.length} 个属于高优先级。`
          : "今天暂无未完成待办，可以复盘客户资料和销售知识库。",
        description: riskCustomers.length
          ? `系统根据客户金额、健康度、阶段和提醒状态计算，建议优先处理 ${topRiskNames}。`
          : `当前客户风险较低，建议推进 ${topDeals[0]?.title || "高金额商机"} 并保持企微记录归档。`,
        basis: `${pendingTodos.length} 个未完成待办、${riskCustomers.length} 个风险客户、${readyDeals.length} 个可推进商机、${pendingMessages.length} 条企微待归档。`,
        action: overdueTodos.length
          ? `先处理 ${overdueTodos.length} 个高优先级待办，再跟进金额最高的商机。`
          : `按今日节奏完成待办，并把可成交商机推进到下一阶段。`,
        impact: riskAmount
          ? `${moneyText(riskAmount)} 风险金额，处理后可降低逾期和报价流失。`
          : `${moneyText(readyDeals.reduce((sum, deal) => sum + deal.amount, 0))} 可推进金额，适合用于晨会安排。`,
        riskAmount,
        riskLabel: hasFullTeamDashboardScope
          ? "团队风险金额"
          : (dashboardScope?.ownerIds.length || 0) > 1 ? "授权组织风险金额" : "本人名下风险",
        closableDeals: readyDeals.length,
        closableAmount: readyDeals.reduce((sum, deal) => sum + deal.amount, 0),
        unreadWecom: pendingMessages.length
      },
      metrics: {
        customers: scopedCustomers.length,
        riskCustomers: riskCustomers.length,
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
        avgResponseHours: Number((Math.max(1, pendingMessages.length + scopedReminders.filter((reminder) => reminder.enabled !== false).length) * 1.6).toFixed(1))
      },
      leadFunnel: {
        stages: leadFunnelCounts.map((stage, index) => ({
          ...stage,
          conversionRate: index === 0
            ? 100
            : leadFunnelCounts[0].count
              ? Math.round((stage.count / leadFunnelCounts[0].count) * 100)
              : 0
        })),
        todayAdded: todayLeadCount,
        filteredOut: filteredLeads.length,
        dealConversionRate: activeLeads.length ? Math.round((dealLeads.length / activeLeads.length) * 100) : 0
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

  app.get("/api/dashboard/leaderboard", requireAuth, (req, res) => {
    const store = getStore();
    const periodParam = String(req.query.period || "week");
    const periodDays = periodParam === "month" ? 30 : periodParam === "quarter" ? 90 : periodParam === "year" ? 365 : 7;
    const periodLabel = periodParam === "month" ? "近30天" : periodParam === "quarter" ? "近90天" : periodParam === "year" ? "近365天" : "近7天";
    const windowStart = Date.now() - periodDays * 24 * 60 * 60 * 1000;
    const prevWindowStart = Date.now() - periodDays * 2 * 24 * 60 * 60 * 1000;
    const users = store.users.filter((user) => user.status === "active" && canSeeOwner(req.user!, user.id, user.teamId));
    const canCompareMembers = users.some((user) => user.id !== req.user!.id);

    const buildEntry = (user: typeof users[number], from: number, to: number) => {
      const userDeals = store.deals.filter((d) => d.ownerId === user.id);
      const wonDeals = userDeals.filter((d) => d.stage === "成交" && new Date(d.stageChangedAt).getTime() >= from && new Date(d.stageChangedAt).getTime() < to);
      const wonAmount = wonDeals.reduce((sum, d) => sum + d.amount, 0);
      const newCustomers = store.leads.filter((l) => l.ownerId === user.id && l.convertedCustomerId && new Date(l.createdAt).getTime() >= from && new Date(l.createdAt).getTime() < to).length;
      const totalDeals = userDeals.filter((d) => d.stage !== "丢单" && !d.archivedAt).length;
      const wonTotal = userDeals.filter((d) => d.stage === "成交").length;
      const conversionRate = totalDeals > 0 ? Math.round((wonTotal / totalDeals) * 100) : 0;
      const followUps = store.dealEvents.filter((e) => {
        const deal = userDeals.find((d) => d.id === e.dealId);
        return deal && new Date(e.createdAt).getTime() >= from && new Date(e.createdAt).getTime() < to;
      }).length;
      const score = Math.round(wonAmount / 1000 + wonDeals.length * 200 + newCustomers * 500 + followUps * 20);
      return { userId: user.id, userName: user.name, avatar: user.avatar, wonAmount, wonCount: wonDeals.length, newCustomers, conversionRate, followUps, score };
    };

    const entries = users.map((user) => {
      const current = buildEntry(user, windowStart, Date.now());
      const prev = buildEntry(user, prevWindowStart, windowStart);
      return { ...current, prevWonAmount: prev.wonAmount };
    });

    entries.sort((a, b) => b.wonAmount - a.wonAmount || b.newCustomers - a.newCustomers || b.score - a.score);
    const ranked = entries.map((e, i) => ({ ...e, rank: i + 1 }));

    res.json({
      scope: canCompareMembers ? "授权范围" : "仅本人",
      period: periodLabel,
      entries: canCompareMembers ? ranked : ranked.filter((entry) => entry.userId === req.user!.id)
    });
  });

  app.get("/api/dashboard/badges", requireAuth, (req, res) => {
    const store = getStore();
    const user = req.user!;
    const userDeals = store.deals.filter((d) => d.ownerId === user.id);
    const userCustomers = store.customers.filter((c) => c.ownerId === user.id);
    const userEvents = store.dealEvents.filter((e) => userDeals.some((d) => d.id === e.dealId));

    const wonDeals = userDeals.filter((d) => d.stage === "成交");
    const firstWon = wonDeals.length >= 1;
    const weekFollowUps = userEvents.filter((e) => new Date(e.createdAt).getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000).length;
    const streak7 = weekFollowUps >= 7;
    const monthWon = wonDeals.filter((d) => new Date(d.stageChangedAt).getMonth() === new Date().getMonth()).length;
    const isMonthlyChamp = monthWon >= 3;
    const customerCount = userCustomers.length;
    const isExplorer = customerCount >= 20;
    const sampleDeals = userDeals.filter((d) => d.stage === "样品" || d.stage === "谈判" || d.stage === "成交");
    const isSampleMaster = sampleDeals.length >= 5;
    const totalAmount = wonDeals.reduce((sum, d) => sum + d.amount, 0);
    const isMillionaire = totalAmount >= 100000;
    const bigDeal = wonDeals.some((d) => d.amount >= 50000);
    const fastCloser = wonDeals.some((d) => {
      const createdEvent = userEvents.find((e) => e.dealId === d.id && e.type === "created");
      const created = createdEvent ? new Date(createdEvent.createdAt).getTime() : new Date(d.stageChangedAt).getTime();
      const closed = new Date(d.stageChangedAt).getTime();
      return closed - created < 7 * 24 * 60 * 60 * 1000;
    });

    const badges = [
      { id: "first_won", name: "首单达成", icon: "🎯", desc: "完成第一笔成交订单", earned: firstWon, progress: `${wonDeals.length}/1` },
      { id: "streak_7", name: "持续跟进", icon: "🔥", desc: "连续7天有跟进记录", earned: streak7, progress: `${weekFollowUps}/7天` },
      { id: "monthly_champ", name: "月度之星", icon: "⭐", desc: "当月成交3笔以上", earned: isMonthlyChamp, progress: `${monthWon}/3` },
      { id: "explorer", name: "客户开拓者", icon: "🧭", desc: "名下客户达20个", earned: isExplorer, progress: `${customerCount}/20` },
      { id: "sample_master", name: "样品达人", icon: "📦", desc: "推动5个商机进入样品阶段", earned: isSampleMaster, progress: `${sampleDeals.length}/5` },
      { id: "millionaire", name: "十万俱乐部", icon: "💰", desc: "累计成交金额达$100K", earned: isMillionaire, progress: `$${Math.round(totalAmount / 1000)}K/$100K` },
      { id: "big_deal", name: "大单猎手", icon: "🏆", desc: "单笔成交金额超$50K", earned: bigDeal, progress: bigDeal ? "已达成" : "未达成" },
      { id: "fast_closer", name: "闪电成交", icon: "⚡", desc: "7天内从创建到成交", earned: fastCloser, progress: fastCloser ? "已达成" : "未达成" },
    ];

    res.json({ badges, earnedCount: badges.filter((b) => b.earned).length, totalCount: badges.length });
  });

  app.post("/api/dashboard/priority-tasks/batch-process", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const scopedCustomers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
    const scopedDeals = store.deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
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

  app.get("/api/reports/executive", requireAuth, (req, res) => {
    const store = getStore();
    const reportOwner = store.users.find((user) => user.id === req.user!.id);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const periodStart = reportDate(monthStart);
    const periodEnd = reportDate(monthEnd);
    const asOfDate = reportDate(now);
    const scopedCustomers = store.customers.filter((customer) => canSeeOwner(req.user!, customer.ownerId, customer.teamId));
    const scopedCustomerIds = new Set(scopedCustomers.map((customer) => customer.id));
    const scopedDeals = store.deals.filter((deal) => canSeeOwner(req.user!, deal.ownerId, deal.teamId) && scopedCustomerIds.has(deal.customerId));
    const activeDeals = scopedDeals.filter((deal) => !deal.archivedAt && deal.stage !== "成交" && deal.stage !== "丢单");
    const periodClosedDeals = scopedDeals.filter((deal) => {
      if (deal.stage !== "成交" && deal.stage !== "丢单") return false;
      const closedDate = (deal.closedAt || deal.stageChangedAt || "").slice(0, 10);
      return closedDate >= periodStart && closedDate <= asOfDate;
    });
    const wonDeals = periodClosedDeals.filter((deal) => deal.stage === "成交");
    const lostDeals = periodClosedDeals.filter((deal) => deal.stage === "丢单");
    const expectedThisMonth = activeDeals.filter((deal) => deal.expectedCloseAt >= periodStart && deal.expectedCloseAt <= periodEnd);
    const customerMap = new Map(scopedCustomers.map((customer) => [customer.id, customer]));
    const userMap = new Map(store.users.map((user) => [user.id, user]));
    const riskRows = activeDeals.map((deal) => {
      const customer = customerMap.get(deal.customerId);
      const reasons = [
        customer?.nextReminder.includes("逾期") ? "跟进已逾期" : "",
        (customer?.health ?? 100) < 60 ? "客户健康度偏低" : "",
        deal.expectedCloseAt && deal.expectedCloseAt < asOfDate ? "预计成交日已过" : "",
        !deal.nextAction.trim() ? "缺少下一动作" : "",
        !deal.nextActionAt.trim() ? "缺少动作日期" : ""
      ].filter(Boolean);
      return reasons.length ? {
        id: deal.id,
        customerId: deal.customerId,
        title: deal.title,
        customer: customer?.company || "客户待确认",
        owner: userMap.get(deal.ownerId)?.name || deal.ownerId,
        stage: deal.stage,
        amount: deal.amount,
        currency: deal.currency,
        riskReasons: reasons,
        nextAction: deal.nextAction,
        expectedCloseAt: deal.expectedCloseAt
      } : null;
    }).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const riskDealIds = new Set(riskRows.map((row) => row.id));
    const riskDeals = activeDeals.filter((deal) => riskDealIds.has(deal.id));
    const stageRows = ["询盘", "已联系", "已报价", "样品", "谈判"].map((stage) => {
      const deals = activeDeals.filter((deal) => deal.stage === stage);
      return {
        stage,
        count: deals.length,
        amounts: reportMoneyRows(deals),
        riskCount: deals.filter((deal) => riskDealIds.has(deal.id)).length,
        weight: reportStageWeights[stage] || 0
      };
    });
    const maxStageCount = Math.max(...stageRows.map((row) => row.count), 1);
    const funnel = [
      ...stageRows.map((row) => ({ ...row, width: row.count ? Math.max(8, Math.round((row.count / maxStageCount) * 100)) : 0 })),
      {
        stage: "本月成交",
        count: wonDeals.length,
        amounts: reportMoneyRows(wonDeals),
        riskCount: 0,
        weight: 1,
        width: wonDeals.length ? Math.max(8, Math.round((wonDeals.length / maxStageCount) * 100)) : 0
      }
    ];
    const marketGroups = new Map<string, Deal[]>();
    activeDeals.forEach((deal) => {
      const region = reportRegion(customerMap.get(deal.customerId)?.country || "其他");
      marketGroups.set(region, [...(marketGroups.get(region) || []), deal]);
    });
    const market = [...marketGroups.entries()]
      .map(([region, deals]) => ({
        region,
        count: deals.length,
        share: activeDeals.length ? Math.round((deals.length / activeDeals.length) * 100) : 0,
        amounts: reportMoneyRows(deals),
        riskCount: deals.filter((deal) => riskDealIds.has(deal.id)).length
      }))
      .sort((left, right) => right.count - left.count || left.region.localeCompare(right.region));
    const visibleOwnerIds = new Set([...scopedCustomers.map((customer) => customer.ownerId), ...scopedDeals.map((deal) => deal.ownerId)]);
    const performance = [...visibleOwnerIds].map((ownerId) => {
      const ownerCustomers = scopedCustomers.filter((customer) => customer.ownerId === ownerId);
      const ownerCustomerIds = new Set(ownerCustomers.map((customer) => customer.id));
      const ownerActiveDeals = activeDeals.filter((deal) => deal.ownerId === ownerId);
      const ownerRiskDeals = ownerActiveDeals.filter((deal) => riskDealIds.has(deal.id));
      const followUps = store.customerActivities.filter((activity) => ownerCustomerIds.has(activity.customerId) && activity.createdAt.slice(0, 10) >= periodStart && activity.createdAt.slice(0, 10) <= asOfDate);
      return {
        ownerId,
        owner: userMap.get(ownerId)?.name || ownerId,
        customerCount: ownerCustomers.length,
        followUpCount: followUps.length,
        activeDealCount: ownerActiveDeals.length,
        forecastAmounts: reportMoneyRows(ownerActiveDeals, (deal) => deal.amount * (reportStageWeights[deal.stage] || 0)),
        riskCount: ownerRiskDeals.length,
        riskLabel: ownerRiskDeals.length ? `${ownerRiskDeals.length} 个风险商机` : "当前健康"
      };
    }).sort((left, right) => right.activeDealCount - left.activeDealCount || right.followUpCount - left.followUpCount);
    const busiestStage = [...stageRows].sort((left, right) => right.count - left.count)[0];
    const topMarket = market[0];
    const winRate = periodClosedDeals.length ? Math.round((wonDeals.length / periodClosedDeals.length) * 100) : null;
    const scopeKey = req.user!.iamDataScope?.tenantWide
      ? "tenant"
      : (req.user!.iamDataScope?.ownerIds.length || 0) > 1 ? "organization" : "self";
    const scopeLabel = scopeKey === "tenant" ? "全公司业务" : scopeKey === "organization" ? "本团队业务" : "本人业务";
    const currencySet = new Set(activeDeals.map((deal) => deal.currency || "未设置"));
    const dataStatus = activeDeals.length || periodClosedDeals.length ? "实时数据" : "数据不足";
    const conclusions = [
      {
        title: expectedThisMonth.length ? `本月有 ${expectedThisMonth.length} 个商机预计成交` : "本月暂无明确预计成交商机",
        detail: expectedThisMonth.length ? "预测基于商机预计成交日期，并按原币分别展示。" : "建议补齐商机预计成交日期，避免预测遗漏。"
      },
      {
        title: riskRows.length ? `${riskRows.length} 个风险商机需要处理` : "当前未识别到风险商机",
        detail: riskRows.length ? riskRows.slice(0, 2).map((row) => `${row.customer}：${row.riskReasons.join("、")}`).join("；") : "风险规则包含逾期、低健康度、预计成交日已过和动作缺失。"
      },
      {
        title: busiestStage?.count ? `${busiestStage.stage}阶段商机最多` : "当前漏斗暂无活跃商机",
        detail: busiestStage?.count ? `${busiestStage.count} 个商机处于该阶段，建议优先检查停留时间和下一动作。` : "新增或同步商机后，系统将自动生成漏斗快照。"
      },
      {
        title: winRate === null ? "本月暂无可计算的赢单率" : `本月商机赢单率 ${winRate}%`,
        detail: winRate === null ? "赢单率仅按本月已关闭的成交与丢单商机计算。" : `${wonDeals.length} 个成交，${lostDeals.length} 个丢单，分母为本月已关闭商机。`
      }
    ];
    const actions = riskRows.length
      ? riskRows.slice(0, 3).map((row) => ({
          dealId: row.id,
          customerId: row.customerId,
          title: `${row.customer} · ${row.stage}`,
          detail: `${row.riskReasons.join("、")}；下一动作：${row.nextAction || "待补充"}`
        }))
      : expectedThisMonth.slice(0, 3).map((deal) => ({
          dealId: deal.id,
          customerId: deal.customerId,
          title: `${customerMap.get(deal.customerId)?.company || deal.title} · ${deal.stage}`,
          detail: `预计 ${deal.expectedCloseAt} 成交；下一动作：${deal.nextAction || "待补充"}`
        }));
    res.json({
      title: "外贸销售实时经营快照",
      scope: {
        key: scopeKey,
        label: scopeLabel
      },
      period: {
        label: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月（截至 ${asOfDate}）`,
        start: periodStart,
        end: asOfDate,
        forecastEnd: periodEnd,
        asOf: now.toISOString(),
        timezone: "服务器本地时区"
      },
      amountBasis: {
        label: currencySet.size > 1 ? "多币种原币分列，不跨币种合计" : `${[...currencySet][0] || "无金额"} 原币口径`,
        currencies: [...currencySet].sort(),
        exchangeRateApplied: false
      },
      dataStatus,
      headline: expectedThisMonth.length
        ? `本月共有 ${expectedThisMonth.length} 个商机进入预计成交窗口，当前识别 ${riskRows.length} 个风险商机。`
        : `当前有 ${activeDeals.length} 个活跃商机，本月尚无商机进入明确预计成交窗口。`,
      note: "活跃漏斗为当前快照；本月成交、丢单和跟进按自然月统计；预计成交按预计成交日期判断。",
      reportNote: reportOwner?.reportNote || "",
      metrics: {
        activeDealCount: activeDeals.length,
        activePipeline: reportMoneyRows(activeDeals),
        weightedForecast: reportMoneyRows(activeDeals, (deal) => deal.amount * (reportStageWeights[deal.stage] || 0)),
        expectedThisMonth: reportMoneyRows(expectedThisMonth),
        wonThisMonth: reportMoneyRows(wonDeals),
        riskAmounts: reportMoneyRows(riskDeals),
        riskDealCount: riskRows.length,
        winRate,
        closedCount: periodClosedDeals.length
      },
      conclusions,
      funnel,
      market,
      forecastByStage: stageRows.map((row) => ({
        stage: row.stage,
        count: row.count,
        weight: row.weight,
        weightedAmounts: reportMoneyRows(activeDeals.filter((deal) => deal.stage === row.stage), (deal) => deal.amount * row.weight)
      })),
      performanceTitle: scopeKey === "self" ? "个人经营效率" : "成员经营对比",
      performance,
      riskRows,
      actions,
      definitions: [
        "活跃管道：未成交、未丢单且未归档的当前商机。",
        "阶段加权预测：询盘 5%、已联系 10%、已报价 30%、样品 50%、谈判 70%。",
        "本月赢单率：本月成交数 ÷ 本月已关闭商机数。",
        "风险商机：跟进逾期、客户健康度低于 60、预计成交日已过或下一动作信息缺失。",
        "金额未应用汇率，所有金额按原币分别展示。"
      ]
    });
  });

  app.patch("/api/reports/executive/note", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      note: z.string().max(1000).default("")
    }).parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    user.reportNote = body.note.trim();
    await store.persist();
    res.json({ note: user.reportNote });
  }));
}
