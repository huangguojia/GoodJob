/**
 * 查重查询路由。
 *
 * 只查当前账号本人名下的客户 / 线索：同事已录的同一家不算重复，也不会挡住本人创建。
 * 与 POST /api/customers、POST /api/leads 的重复拦截共用 entity-duplicates.ts 的口径，
 * 保证「查得到 = 建不进，建得进 = 查不到」。
 */
import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { entityDuplicateKey, ownedDuplicates } from "../entity-duplicates.js";
import { asyncRoute } from "../server-core.js";
import { getStore } from "../store.js";

const duplicateCheckSchema = z.object({
  company: z.string().trim().min(1, "公司名不能为空").max(255),
  country: z.string().trim().max(120).optional().default(""),
  includeCustomers: z.boolean().optional().default(true),
  includeLeads: z.boolean().optional().default(true),
  excludeId: z.string().trim().max(120).optional().default("")
});

export function registerDuplicateRoutes(app: Express) {
  app.post("/api/duplicates/check", requireAuth, asyncRoute(async (req, res) => {
    const body = duplicateCheckSchema.parse(req.body);
    const store = getStore();
    const matches = ownedDuplicates(
      { customers: store.customers, leads: store.leads },
      req.user!.id,
      body.company,
      body.country,
      {
        excludeId: body.excludeId,
        includeCustomers: body.includeCustomers,
        includeLeads: body.includeLeads
      }
    );
    res.json({
      scope: "self",
      ownerId: req.user!.id,
      company: body.company,
      country: body.country,
      key: entityDuplicateKey(body.company, body.country),
      duplicate: matches.length > 0,
      matches
    });
  }));
}
