/**
 * 提成路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { z } from "zod";
import { hasIamPermission, hasIamScope, requireAuth } from "../auth.js";
import { type CommissionCalculation, type CommissionItem, type CommissionProduct, type CommissionRule, type MonthlySalesRecord, type SalesRecordAudit, type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { asyncRoute, roundMoneyValue } from "../server-core.js";

function canManageCommissionRules(user?: SessionUser) {
  return hasIamPermission(user, "commission.manage");
}

function canReviewCommission(user?: SessionUser) {
  return hasIamScope(user, "commission.manage", ["org_subtree", "tenant"]);
}

function currentMonthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function commissionOwnersFor(user: SessionUser) {
  const store = getStore();
  if (canReviewCommission(user)) {
    return store.users
      .filter((item) => item.status === "active" && item.teamId === user.teamId)
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
  if (canReviewCommission(user)) {
    return getStore().users.some((item) => item.id === ownerId && item.teamId === user.teamId);
  }
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

function visibleCommissionProducts(user: SessionUser) {
  return getStore().commissionProducts.filter((product) =>
    product.teamId === "all" || product.teamId === user.teamId
  );
}

function canManageCommissionProduct(user: SessionUser, product: CommissionProduct) {
  return hasIamPermission(user, "commission.manage") && product.teamId === user.teamId;
}

function findCommissionProduct(productName = "", user?: SessionUser) {
  const normalized = productName.trim().toLowerCase();
  if (!normalized) return undefined;
  const products = user ? visibleCommissionProducts(user) : getStore().commissionProducts;
  return products.find((product) => product.status === "active" && (
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
  const inputSnapshot = {
    recordId: record.id,
    originalAmount: record.salesAmount,
    originalCurrency: record.currency,
    exchangeRate: record.exchangeRate,
    exchangeRateDate: record.exchangeRateDate,
    exchangeRateSource: record.exchangeRateSource,
    settlementCurrency: record.settlementCurrency,
    settlementAmount: sales,
    basisType: record.basisType,
    basisDate: record.basisDate
  };
  if (!rule || rule.ruleType === "none") return { amount: 0, snapshot: { input: inputSnapshot, rule: rule || null, formula: "未匹配启用规则", reason: "无启用规则" } };
  if (rule.ruleType === "rate") {
    const amount = roundMoneyValue(sales * Number(rule.rate || 0));
    return { amount, snapshot: { input: inputSnapshot, rule, formula: `${sales} × ${Number(rule.rate || 0) * 100}% = ${amount}` } };
  }
  if (rule.ruleType === "fixed") {
    const amount = roundMoneyValue(Number(rule.fixedAmount || 0) * Number(record.quantity || 1));
    return { amount, snapshot: { input: inputSnapshot, rule, formula: `${record.quantity} × ${Number(rule.fixedAmount || 0)} = ${amount}` } };
  }
  if (rule.ruleType === "gross_profit") {
    const cost = Number(product?.costPrice || 0) * Number(record.quantity || 0);
    const amount = roundMoneyValue(Math.max(0, sales - cost) * Number(rule.grossProfitRate || 0));
    return { amount, snapshot: { input: inputSnapshot, rule, cost, formula: `max(0, ${sales} - ${cost}) × ${Number(rule.grossProfitRate || 0) * 100}% = ${amount}` } };
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
    const amount = roundMoneyValue(sales * rate);
    return { amount, snapshot: { input: inputSnapshot, rule, appliedRate: rate, formula: `${sales} × ${rate * 100}% = ${amount}` } };
  }
  return { amount: 0, snapshot: { input: inputSnapshot, rule, formula: "不计提" } };
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
  let calculation = store.commissionCalculations.find((item) => item.month === month && item.ownerId === ownerId && item.isCurrent !== false);
  if (!calculation) {
    const version = Math.max(0, ...store.commissionCalculations.filter((item) => item.month === month && item.ownerId === ownerId).map((item) => item.version || 1)) + 1;
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
      version,
      isCurrent: true,
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

function validateCommissionTiers(tierJson: string, context: z.RefinementCtx) {
  try {
    const tiers = JSON.parse(tierJson || "[]") as Array<{ from?: number; to?: number; rate?: number }>;
    if (!Array.isArray(tiers) || !tiers.length || tiers.some((tier) => Number(tier.rate) < 0 || Number(tier.rate) > 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tierJson"], message: "阶梯费率必须在 0% 到 100% 之间" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tierJson"], message: "阶梯规则格式不正确" });
  }
}

const commissionRuleBaseSchema = z.object({
  ruleType: z.enum(["rate", "fixed", "tier", "gross_profit", "none"]),
  rate: z.coerce.number().min(0).max(1).default(0),
  fixedAmount: z.coerce.number().nonnegative().default(0),
  tierJson: z.string().optional().default(""),
  grossProfitRate: z.coerce.number().min(0).max(1).default(0),
  effectiveFrom: z.string().optional().default(currentMonthValue()),
  effectiveTo: z.string().optional().default(""),
  enabled: z.coerce.boolean().default(true),
  remark: z.string().optional().default("")
});

const commissionRuleSchema = commissionRuleBaseSchema.superRefine((value, context) => {
  if (value.ruleType === "tier") validateCommissionTiers(value.tierJson, context);
});

const commissionRulePatchSchema = commissionRuleBaseSchema.partial().superRefine((value, context) => {
  if (value.ruleType === "tier") validateCommissionTiers(value.tierJson || "", context);
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
  exchangeRateDate: z.string().optional().default(""),
  exchangeRateSource: z.enum(["pending", "manual", "finance"]).default("manual"),
  settlementCurrency: z.literal("CNY").default("CNY"),
  basisType: z.enum(["deal_amount", "receipt"]).default("receipt"),
  basisDate: z.string().optional().default(""),
  status: z.enum(["draft", "confirmed"]).default("draft"),
  editNote: z.string().optional().default("")
});

export function registerCommissionRoutes(app: Express) {
  app.get("/api/commission/products", requireAuth, (req, res) => {
    const store = getStore();
    const products = visibleCommissionProducts(req.user!);
    const productIds = new Set(products.map((product) => product.id));
    res.json({
      products,
      rules: store.commissionRules.filter((rule) => productIds.has(rule.productId)),
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
    if (!product || !canManageCommissionProduct(req.user!, product)) {
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
    if (!product || !canManageCommissionProduct(req.user!, product)) {
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
    if (rule.enabled) {
      store.commissionRules.filter((item) => item.productId === product.id && item.enabled).forEach((item) => { item.enabled = false; });
    }
    store.commissionRules.unshift(rule);
    await store.persist();
    res.json({ rule });
  }));

  app.patch("/api/commission/rules/:id", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageCommissionRules(req.user)) {
      res.status(403).json({ message: "只有管理员和超级管理员可以维护提成规则" });
      return;
    }
    const body = commissionRulePatchSchema.parse(req.body);
    const store = getStore();
    const rule = store.commissionRules.find((item) => item.id === req.params.id);
    const product = rule ? store.commissionProducts.find((item) => item.id === rule.productId) : undefined;
    if (!rule || !product || !canManageCommissionProduct(req.user!, product)) {
      res.status(404).json({ message: "提成规则不存在" });
      return;
    }
    const alreadyUsed = store.commissionItems.some((item) => item.productId === rule.productId && item.ruleSnapshotJson.includes(`"id":"${rule.id}"`));
    if (alreadyUsed && Object.keys(body).some((key) => key !== "enabled")) {
      rule.enabled = false;
      const nextRule: CommissionRule = {
        ...rule,
        ...body,
        id: `cr_${Date.now()}`,
        createdBy: req.user!.id,
        createdAt: new Date().toISOString()
      };
      if (nextRule.enabled) {
        store.commissionRules.filter((item) => item.productId === rule.productId && item.id !== rule.id).forEach((item) => { item.enabled = false; });
      }
      store.commissionRules.unshift(nextRule);
      await store.persist();
      res.json({ rule: nextRule, replacedRuleId: rule.id });
      return;
    }
    if (body.enabled) {
      store.commissionRules.filter((item) => item.productId === rule.productId && item.id !== rule.id).forEach((item) => { item.enabled = false; });
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
      const product = findCommissionProduct(deal.product, req.user!);
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
        currency: deal.currency || product?.currency || "USD",
        exchangeRate: deal.currency === "CNY" ? 1 : 1,
        exchangeRateDate: "",
        exchangeRateSource: deal.currency === "CNY" ? "finance" : "pending",
        settlementCurrency: "CNY",
        settlementAmount: salesAmount,
        basisType: "deal_amount",
        basisDate: deal.archivedAt?.slice(0, 10) || "",
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
      exchangeRateDate: body.exchangeRateDate,
      exchangeRateSource: body.exchangeRateSource,
      settlementCurrency: body.settlementCurrency,
      settlementAmount: roundMoneyValue(salesAmount * body.exchangeRate),
      basisType: body.basisType,
      basisDate: body.basisDate,
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
    if (record.status === "locked" || store.commissionCalculations.some((item) => item.month === record.month && item.ownerId === record.ownerId && item.isCurrent !== false && item.status === "locked")) {
      res.status(400).json({ message: "已锁定记录不能编辑" });
      return;
    }
    const updates: Partial<MonthlySalesRecord> = {};
    const auditFields: Array<keyof MonthlySalesRecord> = ["customerName", "productName", "quantity", "unitPrice", "salesAmount", "currency", "exchangeRate", "exchangeRateDate", "exchangeRateSource", "basisType", "basisDate", "status", "productId", "customerId"];
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
      record.salesAmount = body.salesAmount !== undefined
        ? roundMoneyValue(body.salesAmount)
        : roundMoneyValue(record.quantity * record.unitPrice);
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
    if (store.commissionCalculations.some((item) =>
      item.month === record.month
      && item.ownerId === record.ownerId
      && item.isCurrent !== false
      && item.status === "locked"
    )) {
      res.status(400).json({ message: "本月提成单已锁定，请先解锁后再确认新记录" });
      return;
    }
    if (record.currency !== "CNY" && (record.exchangeRateSource === "pending" || !record.exchangeRateDate)) {
      res.status(400).json({ message: "外币记录确认前必须填写汇率日期，并将汇率来源标记为手工或财务" });
      return;
    }
    if (!record.basisDate) {
      res.status(400).json({ message: "确认前必须填写计提依据日期" });
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
    const allCalculations = getStore().commissionCalculations.filter((calculation) => {
      if (calculation.month !== month) return false;
      if (scopedOwnerId && calculation.ownerId !== scopedOwnerId) return false;
      if (!scopedOwnerId && canReviewCommission(req.user) && !allowedOwners.has(calculation.ownerId)) return false;
      return canAccessCommissionOwner(req.user!, calculation.ownerId);
    });
    const calculations = allCalculations.filter((calculation) => calculation.isCurrent !== false);
    const ids = new Set(calculations.map((item) => item.id));
    res.json({
      calculations,
      historyCalculations: allCalculations.filter((calculation) => calculation.isCurrent === false),
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
      if (calculation.status === "locked" || calculation.status === "reviewed") {
        res.status(409).json({ message: "已复核或已锁定的提成单不能覆盖重算；如需修正，请先解锁生成新版本" });
        return;
      }
      store.commissionItems = store.commissionItems.filter((item) => item.calculationId !== calculation.id || item.sourceType !== "auto");
      ownerRecords.forEach((record, index) => {
        const product = visibleCommissionProducts(req.user!).find((item) => item.id === record.productId) || findCommissionProduct(record.productName, req.user!);
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
      recordId: z.string().optional().default(""),
      remark: z.string().trim().min(2)
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
      recordId: body.recordId,
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

  app.post("/api/commission/calculations/:id/review", requireAuth, asyncRoute(async (req, res) => {
    if (!canReviewCommission(req.user)) {
      res.status(403).json({ message: "只有管理员和超级管理员可以复核提成单" });
      return;
    }
    const store = getStore();
    const calculation = store.commissionCalculations.find((item) => item.id === req.params.id && item.isCurrent !== false);
    if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
      res.status(404).json({ message: "提成计算单不存在" });
      return;
    }
    if (calculation.status !== "calculated") {
      res.status(400).json({ message: "只有已计算的提成单可以复核" });
      return;
    }
    calculation.status = "reviewed";
    calculation.reviewedBy = req.user!.id;
    calculation.reviewedAt = new Date().toISOString();
    store.monthlySalesRecords
      .filter((record) => record.month === calculation.month && record.ownerId === calculation.ownerId && record.status === "confirmed")
      .forEach((record) => { record.status = "reviewed"; record.updatedAt = new Date().toISOString(); });
    await store.persist();
    res.json({ calculation });
  }));

  app.post("/api/commission/calculations/:id/lock", requireAuth, asyncRoute(async (req, res) => {
    if (!canReviewCommission(req.user)) {
      res.status(403).json({ message: "只有管理员和超级管理员可以锁定提成单" });
      return;
    }
    const store = getStore();
    const calculation = store.commissionCalculations.find((item) => item.id === req.params.id && item.isCurrent !== false);
    if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
      res.status(404).json({ message: "提成计算单不存在" });
      return;
    }
    if (calculation.status !== "reviewed") {
      res.status(400).json({ message: "提成单必须先复核再锁定" });
      return;
    }
    calculation.status = "locked";
    calculation.lockedBy = req.user!.id;
    calculation.lockedAt = new Date().toISOString();
    store.monthlySalesRecords
      .filter((record) => record.month === calculation.month && record.ownerId === calculation.ownerId && record.status === "reviewed")
      .forEach((record) => { record.status = "locked"; record.updatedAt = new Date().toISOString(); });
    await store.persist();
    res.json({ calculation });
  }));

  app.post("/api/commission/calculations/:id/unlock", requireAuth, asyncRoute(async (req, res) => {
    if (!canReviewCommission(req.user)) {
      res.status(403).json({ message: "只有管理员和超级管理员可以解锁提成单" });
      return;
    }
    const body = z.object({ reason: z.string().trim().min(4) }).parse(req.body);
    const store = getStore();
    const calculation = store.commissionCalculations.find((item) => item.id === req.params.id && item.isCurrent !== false);
    if (!calculation || !canAccessCommissionOwner(req.user!, calculation.ownerId)) {
      res.status(404).json({ message: "提成计算单不存在" });
      return;
    }
    if (calculation.status !== "locked") {
      res.status(400).json({ message: "只有已锁定提成单可以解锁" });
      return;
    }
    calculation.isCurrent = false;
    calculation.unlockReason = `${body.reason}；操作人：${req.user!.name}；时间：${new Date().toISOString()}`;
    const nextCalculation = ensureCalculation(calculation.month, calculation.ownerId, calculation.teamId);
    store.monthlySalesRecords
      .filter((record) => record.month === calculation.month && record.ownerId === calculation.ownerId && record.status === "locked")
      .forEach((record) => { record.status = "confirmed"; record.updatedAt = new Date().toISOString(); });
    await store.persist();
    res.json({ calculation: nextCalculation, historyCalculation: calculation });
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
    const itemByRecord = new Map(store.commissionItems.filter((item) => item.recordId).map((item) => [item.recordId, item]));
    const rows = records.map((record) => {
      const calculation = calculationByOwner.get(record.ownerId);
      const commissionItem = itemByRecord.get(record.id);
      const owner = store.users.find((item) => item.id === record.ownerId);
      return {
        month: record.month,
        ownerName: owner?.name || record.ownerId,
        customerName: record.customerName,
        productName: record.productName,
        quantity: record.quantity,
        unitPrice: record.unitPrice,
        currency: record.currency,
        salesAmount: record.salesAmount,
        exchangeRate: record.exchangeRate,
        exchangeRateDate: record.exchangeRateDate,
        exchangeRateSource: record.exchangeRateSource,
        settlementCurrency: record.settlementCurrency,
        settlementAmount: record.settlementAmount,
        basisType: record.basisType,
        basisDate: record.basisDate,
        status: record.status,
        edited: record.edited,
        recordCommission: commissionItem?.finalAmount || 0,
        calculationStatus: calculation?.status || "pending",
        editNote: record.editNote
      };
    });
    const summaryRows = [...new Set(records.map((record) => record.ownerId))].map((recordOwnerId) => {
      const calculation = calculationByOwner.get(recordOwnerId);
      const owner = store.users.find((item) => item.id === recordOwnerId);
      return {
        month: body.month,
        ownerName: owner?.name || recordOwnerId,
        settlementCurrency: "CNY",
        salesAmount: calculation?.salesAmount || 0,
        autoCommission: calculation?.autoCommission || 0,
        manualAdjustment: calculation?.manualAdjustment || 0,
        finalCommission: calculation?.finalCommission || 0,
        status: calculation?.status || "pending",
        version: calculation?.version || 1
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
    res.json({ exportJob, rows, summaryRows });
  }));
}
