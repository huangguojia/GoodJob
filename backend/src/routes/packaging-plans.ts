import type { Express } from "express";
import { z } from "zod";
import { asyncRoute } from "../server-core.js";
import {
  getPackagingPlanRepository, normalizePackagingPlanItems, type PackagingPlanInput
} from "../packaging-plan-repository.js";
import { requireAuth } from "../auth.js";

// ---------------------------------------------------------------------------
// 包装方案 CRUD
//
// 权限：GET 走 packaging.read；写走 packaging.create / update；
// bulk-delete 走 packaging.delete（主管及以上）。
// 方案是团队共享资产（和供应商一致）：一律按 teamId 取，不按 ownerId 过滤 ——
// 否则录入人调岗后，他建的方案会从所有人的下拉里整批消失。
// ---------------------------------------------------------------------------

const planItemSchema = z.object({
  id: z.string().trim().max(80).optional().default(""),
  label: z.string().trim().max(120).optional().default(""),
  contents: z.string().trim().max(300).optional().default(""),
  model: z.string().trim().max(120).optional().default(""),
  lengthCm: z.coerce.number().nonnegative().max(1000).optional().default(0),
  widthCm: z.coerce.number().nonnegative().max(1000).optional().default(0),
  heightCm: z.coerce.number().nonnegative().max(1000).optional().default(0),
  netWeightKg: z.coerce.number().nonnegative().max(100000).optional().default(0),
  grossWeightKg: z.coerce.number().nonnegative().max(100000).optional().default(0)
});

const planBodySchema = z.object({
  code: z.string().trim().max(40).optional().default(""),
  name: z.string().trim().min(1).max(200),
  scope: z.enum(["general", "product"]).optional().default("general"),
  productId: z.string().trim().max(80).optional().default(""),
  productName: z.string().trim().max(200).optional().default(""),
  productModel: z.string().trim().max(120).optional().default(""),
  summary: z.string().trim().max(300).optional().default(""),
  remark: z.string().trim().max(2000).optional().default(""),
  items: z.array(planItemSchema).max(60).optional().default([])
});

function codeConflict(error: unknown) {
  return error instanceof Error && (error as Error & { errorCode?: string }).errorCode === "PACKAGING_PLAN_CODE_CONFLICT";
}

export function registerPackagingPlanRoutes(app: Express) {
  app.get("/api/packaging-plans", requireAuth, asyncRoute(async (req, res) => {
    const repository = getPackagingPlanRepository();
    if (!repository) { res.status(503).json({ message: "包装方案库不可用" }); return; }
    const query = z.object({
      scope: z.enum(["general", "product"]).optional(),
      productId: z.string().trim().max(80).optional(),
      q: z.string().trim().max(120).optional()
    }).parse(req.query);
    let plans = await repository.list(req.user!.teamId);
    if (query.scope) plans = plans.filter((plan) => plan.scope === query.scope);
    if (query.productId) plans = plans.filter((plan) => plan.productId === query.productId);
    if (query.q) {
      const keyword = query.q.toLowerCase();
      plans = plans.filter((plan) => [
        plan.code, plan.name, plan.productName, plan.productModel, plan.summary, plan.remark
      ].filter(Boolean).join(" ").toLowerCase().includes(keyword));
    }
    res.json({ plans });
  }));

  app.post("/api/packaging-plans", requireAuth, asyncRoute(async (req, res) => {
    const repository = getPackagingPlanRepository();
    if (!repository) { res.status(503).json({ message: "包装方案库不可用" }); return; }
    const body = planBodySchema.parse(req.body);
    try {
      const plan = await repository.create(req.user!.id, req.user!.teamId, {
        ...body,
        items: normalizePackagingPlanItems(body.items)
      } satisfies PackagingPlanInput);
      res.json({ plan });
    } catch (error) {
      if (!codeConflict(error)) throw error;
      res.status(409).json({ message: (error as Error).message, errorCode: "PACKAGING_PLAN_CODE_CONFLICT" });
    }
  }));

  app.patch("/api/packaging-plans/:id", requireAuth, asyncRoute(async (req, res) => {
    const repository = getPackagingPlanRepository();
    if (!repository) { res.status(503).json({ message: "包装方案库不可用" }); return; }
    const body = planBodySchema.partial().parse(req.body);
    try {
      const plan = await repository.update(req.user!.teamId, req.params.id, body as PackagingPlanInput);
      if (!plan) { res.status(404).json({ message: "包装方案不存在或无权访问" }); return; }
      res.json({ plan });
    } catch (error) {
      if (!codeConflict(error)) throw error;
      res.status(409).json({ message: (error as Error).message, errorCode: "PACKAGING_PLAN_CODE_CONFLICT" });
    }
  }));

  app.post("/api/packaging-plans/bulk-delete", requireAuth, asyncRoute(async (req, res) => {
    const repository = getPackagingPlanRepository();
    if (!repository) { res.status(503).json({ message: "包装方案库不可用" }); return; }
    const body = z.object({ ids: z.array(z.string().trim().min(1)).min(1).max(200) }).parse(req.body);
    const deleted = await repository.removeMany(req.user!.teamId, body.ids);
    if (!deleted.length) { res.status(404).json({ message: "未找到可删除的包装方案" }); return; }
    res.json({ deleted, plans: await repository.list(req.user!.teamId) });
  }));
}
