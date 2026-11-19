/**
 * 企业身份冲突、企业关系、官网机会、官网抓取路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Response } from "express";
import { z } from "zod";
import { canSeeOwner, requireAuth } from "../auth.js";
import { type Lead, type LeadSourceEvent, type SessionUser, type WebsiteOpportunity } from "../types.js";
import { getStore } from "../store.js";
import { expireContactEnrichmentAttempt } from "../prospect-contact-enrichment.js";
import { PROSPECT_LEAD_SOURCE_CHANNEL } from "../prospect-lead-conversion.js";
import { evaluateProspectEmailOutreachEligibility } from "../prospect-outreach-eligibility.js";
import { migrateProspectFollowUpTodos } from "../prospect-outreach.js";
import { linkProcurementContextToLead } from "../procurement-signals.js";
import { canonicalOrganizationId, listOrganizationIdentityConflicts, organizationIdentityConflictListQuerySchema, organizationIdentityConflictReviewBodySchema, OrganizationIdentityConflictReviewError, reviewOrganizationIdentityConflict } from "../organization-identity-conflict-review.js";
import { organizationAliasBodySchema, organizationIdentityProfile, organizationRelationBodySchema, OrganizationRelationError, recordOrganizationAlias, recordOrganizationRelation } from "../organization-relations.js";
import { companyNameFromWebsiteReference, ensureProspectVerificationReport, normalizeWebsiteReference, withProspectVerificationReport } from "../prospect-verification.js";
import { refreshProspectScorecard } from "../prospect-scorecard.js";
import {
  asyncRoute,
  createLeadFromSource,
  engineJobRepositoryOrNull,
  notifyNewLead,
  persistCandidateChanges,
  persistProviderOpportunities,
  prospectSearchReport
} from "../server-core.js";

function sendOrganizationIdentityConflictReviewError(
  res: Response,
  error: unknown
) {
  if (!(error instanceof OrganizationIdentityConflictReviewError)) {
    return false;
  }
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function sendOrganizationRelationError(
  res: Response,
  error: unknown
) {
  if (!(error instanceof OrganizationRelationError)) return false;
  res.status(error.status).json({
    message: error.message,
    errorCode: error.code
  });
  return true;
}

function parseWebsiteOpportunity(
  rawUrl: string,
  index: number,
  user: SessionUser
): WebsiteOpportunity {
  const website = normalizeWebsiteReference(rawUrl);
  const createdAt = new Date().toISOString();
  return withProspectVerificationReport({
    id: `web_${Date.now()}_${index}`,
    company: companyNameFromWebsiteReference(website),
    business: "待人工核实",
    country: "待人工核实",
    website,
    contact: "待人工核实",
    contactInfo: "",
    description: "仅登记官网链接，公开资料尚待补全。",
    ownerId: user.id,
    teamId: user.teamId,
    status: "preview",
    createdAt,
    parseMode: "reference",
    source: "website-reference",
    sourceLabel: "官网链接登记",
    sourceEvidence: []
  }, createdAt);
}

export function registerOrganizationsRoutes(app: Express) {
  app.get("/api/organization-identity-conflicts", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    try {
      const query = organizationIdentityConflictListQuerySchema.parse(req.query);
      await store.reloadOrganizationIdentityConflictReviewTeam?.(
        req.user!.teamId
      );
      const conflicts = listOrganizationIdentityConflicts(
        store,
        req.user!,
        query.status
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ conflicts });
    } catch (error) {
      if (sendOrganizationIdentityConflictReviewError(res, error)) return;
      throw error;
    }
  }));

  app.post("/api/organization-identity-conflicts/:id/review", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    try {
      const body = organizationIdentityConflictReviewBodySchema.parse(req.body);
      const result = await reviewOrganizationIdentityConflict(store, {
        user: req.user!,
        conflictId: req.params.id,
        ifMatch: req.header("If-Match") || "",
        body
      });
      res.setHeader("ETag", result.etag);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch (error) {
      if (sendOrganizationIdentityConflictReviewError(res, error)) return;
      throw error;
    }
  }));

  app.get("/api/organizations/:id/identity-profile", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    try {
      await store.reloadOrganizationIdentityTeam?.(req.user!.teamId);
      await store.reloadOrganizationIdentityConflictReviewTeam?.(
        req.user!.teamId
      );
      await store.reloadOrganizationRelationsTeam?.(req.user!.teamId);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        profile: organizationIdentityProfile(
          store,
          req.user!,
          req.params.id
        )
      });
    } catch (error) {
      if (sendOrganizationRelationError(res, error)) return;
      throw error;
    }
  }));

  app.post("/api/organizations/:id/aliases", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    try {
      const body = organizationAliasBodySchema.parse(req.body);
      const result = await recordOrganizationAlias(store, {
        user: req.user!,
        organizationId: req.params.id,
        body
      });
      res.setHeader(
        "Idempotency-Replayed",
        result.replayed ? "true" : "false"
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (sendOrganizationRelationError(res, error)) return;
      throw error;
    }
  }));

  app.post("/api/organization-relations", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    try {
      const body = organizationRelationBodySchema.parse(req.body);
      const result = await recordOrganizationRelation(store, {
        user: req.user!,
        body
      });
      res.setHeader(
        "Idempotency-Replayed",
        result.replayed ? "true" : "false"
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (sendOrganizationRelationError(res, error)) return;
      throw error;
    }
  }));

  app.get("/api/tools/website-opportunities", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    await store.reloadProspectCandidates?.();
    const expiredCandidates = store.websiteOpportunities.filter((item) => {
      if (!canSeeOwner(req.user!, item.ownerId, item.teamId)) return false;
      const attempt = item.contactEnrichmentAttempts?.[0];
      return attempt ? expireContactEnrichmentAttempt(item, attempt) : false;
    });
    if (expiredCandidates.length) {
      await persistCandidateChanges(store, expiredCandidates, false);
    }
    // 正在执行中的 CLI 背调实体集合：所有列表（候选/搜客清单/任务详情）据此亮「背调中」动画
    const engineJobsRepo = engineJobRepositoryOrNull();
    let runningResearchIds: string[] = [];
    if (engineJobsRepo) {
      try {
        runningResearchIds = await engineJobsRepo.listRunningEntityIds(req.user!.teamId, "research");
      } catch {
        runningResearchIds = [];
      }
    }
    const runningResearchSet = new Set(runningResearchIds);
    const scoped = store.websiteOpportunities
      .filter((item) =>
        canSeeOwner(req.user!, item.ownerId, item.teamId)
      )
      .map((item) => {
        const scored = refreshProspectScorecard(store, { ...item });
        const verified = ensureProspectVerificationReport(scored);
        return {
        ...verified,
        researchRunning: runningResearchSet.has(item.id),
        verificationReport: verified.verificationReport,
        searchReport: prospectSearchReport(verified),
        // 发信资格灯：可发信 / 缺邮箱 / 已抑制（附原因），供清单行直接渲染，不抛错。
        emailEligibility: evaluateProspectEmailOutreachEligibility(store, verified),
        organizationId: scored.organizationId
          ? canonicalOrganizationId(
              store,
              scored.teamId,
              scored.organizationId
            )
          : scored.organizationId
        };
      });
    res.json({ opportunities: scoped });
  }));

  app.post("/api/tools/website-scrape/preview", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      urls: z.array(z.string().min(3)).min(1).max(12),
      useAi: z.boolean().optional()
    });
    const body = schema.parse(req.body);
    if (body.useAi) {
      res.status(400).json({
        message: "官网链接登记仅保存链接；公开资料将在后续核验流程中补全"
      });
      return;
    }
    const store = getStore();
    const parsed = body.urls.map((url, index) =>
      parseWebsiteOpportunity(url, index, req.user!)
    );
    await store.reloadProspectCandidates?.();
    const persistence = persistProviderOpportunities(parsed, {
      rawCount: parsed.length,
      deduplicatedCount: 0
    });
    await persistCandidateChanges(
      store,
      persistence.opportunities,
      true
    );
    res.json({
      opportunities: persistence.opportunities,
      incrementalStats: persistence.incrementalStats
    });
  }));

  app.post("/api/tools/website-scrape/sync-opportunities", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      requestId: z.string().trim().min(8).max(120),
      opportunities: z.array(z.object({
        id: z.string().min(1),
        company: z.string().min(1),
        business: z.string().default("待维护"),
        country: z.string().default("未知"),
        website: z.string().min(3),
        contact: z.string().default("待维护"),
        contactInfo: z.string().default(""),
        description: z.string().default(""),
        source: z.string().max(40).optional().default(""),
        sourceLabel: z.string().max(80).optional().default("")
      })).min(1).max(100)
    }).superRefine((value, context) => {
      const seen = new Set<string>();
      value.opportunities.forEach((item, index) => {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          return;
        }
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["opportunities", index, "id"],
          message: "同一批次不能重复提交相同候选"
        });
      });
    });
    const body = schema.parse(req.body);
    const store = getStore();
    await store.reloadProspectCandidates?.();
    await store.reloadProspectQualificationTeam?.(req.user!.teamId);
    if (!store.convertProspectToLead) {
      res.status(503).json({
        message: "候选转线索服务暂不可用",
        errorCode: "PROSPECT_LEAD_CONVERSION_UNAVAILABLE"
      });
      return;
    }
    type SyncResult = {
      lead: Lead;
      sourceEvent: LeadSourceEvent;
      opportunity: WebsiteOpportunity;
      duplicate: boolean;
    };
    const resultByCandidateId = new Map<string, SyncResult>();
    const convertedAt = new Date().toISOString();
    for (const source of body.opportunities) {
      const stored = store.websiteOpportunities.find((item) =>
        item.id === source.id
        && canSeeOwner(req.user!, item.ownerId, item.teamId)
      );
      if (!stored) {
        res.status(404).json({ message: "搜客线索不存在或无权访问" });
        return;
      }
      if (stored.ownerId !== req.user!.id) {
        res.status(403).json({ message: "候选归属其他业务员，请先分配后再加入线索" });
        return;
      }
      refreshProspectScorecard(store, stored);
      if (stored.status === "synced" && stored.leadId) {
        const existingLead = store.leads.find((item) =>
          item.id === stored.leadId
          && item.ownerId === req.user!.id
          && item.teamId === req.user!.teamId
        );
        const existingEvent = existingLead
          ? store.leadSourceEvents.find((item) =>
              item.leadId === existingLead.id
              && item.channel === PROSPECT_LEAD_SOURCE_CHANNEL)
          : undefined;
        if (existingLead && existingEvent) {
          resultByCandidateId.set(stored.id, {
            lead: existingLead,
            sourceEvent: existingEvent,
            opportunity: stored,
            duplicate: true
          });
          continue;
        }
      }
      // 资格审核链已按需求移除（2026-09-13）：不再要求企业身份归一、VQA 资格审核
      // 与人工可联系批准 —— 候选直接转为线索，血缘通过 leadSourceEvent 保留。
      const candidateEmail = (stored.contactInfo || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]
        || (stored.extractedContacts || []).flatMap((item) => item.emails || [])[0]
        || "";
      const conversion = createLeadFromSource(req.user!, {
        company: stored.company,
        contact: stored.contact,
        country: stored.country,
        email: candidateEmail,
        phone: "",
        wechat: "",
        source: "智能获客人工确认",
        intent: "中",
        stage: "新线索",
        estimatedAmount: 0,
        nextFollowAt: "",
        remark: [stored.business, stored.description]
          .filter(Boolean).join("；"),
        inquiryContent: "",
        sourceType: "outbound",
        sourceChannel: PROSPECT_LEAD_SOURCE_CHANNEL,
        sourceCampaign: (stored.sourceLabel || "").slice(0, 120),
        externalId: stored.id,
        sourceUrl: (stored.website || "").slice(0, 500),
        occurredAt: convertedAt,
        rawPayload: {
          candidateId: stored.id,
          tenantProspectId: stored.tenantProspectId || "",
          organizationId: stored.organizationId || "",
          convertedAt,
          sourceEvidence: structuredClone(stored.sourceEvidence || [])
        }
      });
      Object.assign(stored, {
        status: "synced",
        leadId: conversion.lead.id,
        statusChangedAt: convertedAt,
        excludedReason: ""
      });
      migrateProspectFollowUpTodos(
        store,
        stored,
        conversion.lead.id
      );
      linkProcurementContextToLead(
        store,
        stored,
        conversion.lead.id
      );
      resultByCandidateId.set(stored.id, {
        lead: conversion.lead,
        sourceEvent: conversion.sourceEvent,
        opportunity: stored,
        duplicate: conversion.duplicate
      });
    }
    const touchedOpportunities = [...resultByCandidateId.values()]
      .map((item) => item.opportunity);
    if (touchedOpportunities.length) {
      await persistCandidateChanges(
        store,
        touchedOpportunities,
        true
      );
    }
    const newlyCreatedLeads = [...resultByCandidateId.values()]
      .filter((item) => !item.duplicate)
      .map((item) => item.lead);
    if (newlyCreatedLeads.length) {
      newlyCreatedLeads.forEach((lead) => notifyNewLead(lead));
      await store.persist();
    }
    const created = body.opportunities.map((item) =>
      resultByCandidateId.get(item.id)
    ).filter(Boolean) as SyncResult[];
    res.json({ created });
  }));
}
