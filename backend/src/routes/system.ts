/**
 * 健康检查、汇率、在线更新、数据库导入/维护/备份、系统设置、公司资料路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request } from "express";
import { z } from "zod";
import { canManageAccounts, hasIamPermission, isPlatformIdentity, requireAuth } from "../auth.js";
import { type TradeDocumentOcrProvider, type TradeDocumentOcrProviderConfig } from "../trade-document-ocr.js";
import { type CompanyProfile, type SessionUser, type TeamSystemSettings } from "../types.js";
import { encryptProviderConfiguration } from "../credential-security.js";
import { assertMysqlDataImportToken, beginMysqlDataImport, cancelMysqlDataImport, completeMysqlDataImport, failMysqlDataImport, getMysqlDataImport, importMysqlDataBatch, listMysqlDataImports, mysqlDataImportEnabled, MysqlDataImportError, mysqlImportableSchema } from "../mysql-data-import.js";
import { beginDatabaseBackup, cancelDatabaseBackup, databaseBackupDownload, deleteDatabaseBackup, getDatabaseBackupJob, listDatabaseBackupJobs, mysqlLocalBackupConfig } from "../database-backup.js";
import { getStore } from "../store.js";
import { getTodayExchangeRates } from "../exchange-rates.js";
import { applyUpdate, checkForUpdate, getLastCheckResult, getMirrorConfig, getUpdateProgress, setMirrorUrl } from "../auto-updater.js";
import {
  activeProspectWorkerService,
  asyncRoute,
  companyProfileForTeam,
  ocrProviderCredentialContext,
  teamSystemSettingsForTeam,
  tradeDocumentOcrProviderForTeam
} from "../server-core.js";

const mysqlImportValueSchema = z.union([
  z.string().max(1_000_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ hex: z.string().regex(/^[0-9A-Fa-f]*$/).max(2_000_000) }).strict()
]);

function assertDatabaseImportAccess(req: Request) {
  if (!req.user || !canManageAccounts(req.user)) {
    throw new MysqlDataImportError(403, "只有管理员可以执行数据库迁移");
  }
  if (getStore().mode !== "mysql") {
    throw new MysqlDataImportError(409, "当前不是 MySQL 持久化模式");
  }
  assertMysqlDataImportToken(req.header("x-database-import-token"));
}

function canManageCompanyProfile(user: SessionUser) {
  return hasIamPermission(user, "system.settings.manage");
}

function publicTradeDocumentOcrProvider(config: TradeDocumentOcrProviderConfig) {
  return {
    provider: config.provider,
    enabled: config.enabled,
    hasApiKey: Boolean(config.apiKey),
    hasSecretKey: Boolean(config.secretKey),
    model: config.model,
    baseUrl: config.baseUrl
  };
}

export function registerSystemRoutes(app: Express) {
  app.get("/api/health", (_req, res) => {
    const workerStatus = activeProspectWorkerService?.status();
    const queueStatus = workerStatus?.queue;
    res.json({
      ok: true,
      store: getStore().mode,
      prospectQueue: queueStatus
        ? {
            mode: queueStatus.mode,
            running: queueStatus.running,
            degraded: queueStatus.degraded
          }
        : {
            mode: "mysql_polling",
            running: false,
            degraded: false
          }
    });
  });

  app.get("/api/exchange-rates/today", requireAuth, asyncRoute(async (_req, res) => {
    try {
      const rates = await getTodayExchangeRates();
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(rates);
    } catch (error) {
      res.status(503).json({
        code: "exchange_rates_unavailable",
        message: "今日参考汇率暂不可用，请稍后重试"
      });
    }
  }));

  // ── 自动更新 API ──────────────────────────────────────────────────

  // 检查更新 (需管理员权限)
  app.get("/api/admin/updates/check", requireAuth, asyncRoute(async (req, res) => {
    if (!isPlatformIdentity(req.user) || !hasIamPermission(req.user, "platform.release.manage")) {
      res.status(403).json({ message: "需要平台发布管理权限" });
      return;
    }
    const status = await checkForUpdate();
    res.json(status);
  }));

  // 应用更新 (需管理员权限)
  app.post("/api/admin/updates/apply", requireAuth, asyncRoute(async (req, res) => {
    if (!isPlatformIdentity(req.user) || !hasIamPermission(req.user, "platform.release.manage")) {
      res.status(403).json({ message: "需要平台发布管理权限" });
      return;
    }
    const result = await applyUpdate();
    if (!result.success) {
      res.status(409).json({ message: result.message });
      return;
    }
    res.status(202).json({ message: result.message });
  }));

  // 获取更新进度
  app.get("/api/admin/updates/progress", requireAuth, asyncRoute(async (req, res) => {
    if (!isPlatformIdentity(req.user) || !hasIamPermission(req.user, "platform.release.manage")) {
      res.status(403).json({ message: "需要平台发布管理权限" });
      return;
    }
    const progress = getUpdateProgress();
    const lastCheck = getLastCheckResult();
    const config = getMirrorConfig();
    res.json({ progress, lastCheck, config });
  }));

  // 配置镜像源 URL
  app.post("/api/admin/updates/mirror", requireAuth, asyncRoute(async (req, res) => {
    if (!isPlatformIdentity(req.user) || !hasIamPermission(req.user, "platform.release.manage")) {
      res.status(403).json({ message: "需要平台发布管理权限" });
      return;
    }
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== "string") {
      res.status(400).json({ message: "请提供镜像源 URL" });
      return;
    }
    setMirrorUrl(url.trim());
    res.json({ message: "镜像源已配置", url: url.trim() });
  }));

  // 获取镜像源配置
  app.get("/api/admin/updates/config", requireAuth, asyncRoute(async (req, res) => {
    if (!isPlatformIdentity(req.user) || !hasIamPermission(req.user, "platform.release.manage")) {
      res.status(403).json({ message: "需要平台发布管理权限" });
      return;
    }
    const config = getMirrorConfig();
    res.json(config);
  }));

  app.get("/api/system/database-import/status", requireAuth, (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "只有管理员可以查看数据库迁移" });
      return;
    }
    res.json({
      enabled: mysqlDataImportEnabled(),
      store: getStore().mode,
      acceptedExtensions: [".sql", ".sql.gz"],
      maxBatchRows: 100
    });
  });

  app.get("/api/system/database-maintenance/status", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "只有管理员可以查看数据库维护" });
      return;
    }
    const backup = mysqlLocalBackupConfig();
    const [imports, backups] = getStore().mode === "mysql"
      ? await Promise.all([listMysqlDataImports(1), listDatabaseBackupJobs(1)])
      : [[], []];
    const latest = [...imports.map((job) => ({ ...job, type: "migration" as const })), ...backups.map((job) => ({ ...job, type: "backup" as const }))]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    res.json({
      store: getStore().mode,
      migration: {
        enabled: mysqlDataImportEnabled() && getStore().mode === "mysql",
        sourceStoredOnServer: false,
        acceptedExtensions: [".sql", ".sql.gz"],
        maxFileSize: 500 * 1024 * 1024,
        maxBatchRows: 100
      },
      backup: {
        enabled: backup.enabled && getStore().mode === "mysql",
        retentionDays: backup.retentionDays,
        reason: backup.enabled ? "" : "服务器已禁止本地备份"
      },
      latest: latest || null
    });
  }));

  app.get("/api/system/database-maintenance/jobs", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageAccounts(req.user)) {
      res.status(403).json({ message: "只有管理员可以查看数据库维护任务" });
      return;
    }
    if (getStore().mode !== "mysql") {
      res.json({ jobs: [] });
      return;
    }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const [imports, backups] = await Promise.all([listMysqlDataImports(limit), listDatabaseBackupJobs(limit)]);
    const jobs = [
      ...imports.map((job) => ({ ...job, type: "migration" as const })),
      ...backups.map((job) => ({ ...job, type: "backup" as const }))
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
    res.json({ jobs });
  }));

  app.get("/api/system/database-import/schema", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    res.json({ tables: await mysqlImportableSchema() });
  }));

  app.post("/api/system/database-import/jobs", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    const body = z.object({
      fileName: z.string().trim().min(1).max(255),
      fileSize: z.number().int().min(1).max(500 * 1024 * 1024),
      fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
      conflictMode: z.enum(["skip", "overwrite"]).default("skip"),
      tableRows: z.record(z.number().int().min(0).max(100_000_000)).refine((value) => Object.keys(value).length <= 500).optional(),
      ignoredStatements: z.number().int().min(0).max(10_000_000).optional()
    }).parse(req.body);
    const job = await beginMysqlDataImport({ ...body, actorId: req.user!.id });
    res.status(201).json({ job });
  }));

  app.get("/api/system/database-import/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    res.json({ job: await getMysqlDataImport(req.params.id, req.user!.id) });
  }));

  app.post("/api/system/database-import/jobs/:id/batches", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    const body = z.object({
      table: z.string().regex(/^[A-Za-z0-9_]+$/).max(128),
      columns: z.array(z.string().regex(/^[A-Za-z0-9_]+$/).max(128)).min(1).max(300),
      rows: z.array(z.array(mysqlImportValueSchema).min(1).max(300)).min(1).max(100),
      tableComplete: z.boolean().optional().default(false)
    }).parse(req.body);
    const result = await importMysqlDataBatch({
      jobId: req.params.id,
      actorId: req.user!.id,
      ...body
    });
    res.json({ result, job: await getMysqlDataImport(req.params.id, req.user!.id) });
  }));

  app.post("/api/system/database-import/jobs/:id/fail", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    const body = z.object({ message: z.string().trim().min(1).max(500) }).parse(req.body);
    await failMysqlDataImport(req.params.id, req.user!.id, body.message);
    res.json({ ok: true });
  }));

  app.post("/api/system/database-import/jobs/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    res.json({ job: await cancelMysqlDataImport(req.params.id, req.user!.id) });
  }));

  app.post("/api/system/database-import/jobs/:id/complete", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    const job = await completeMysqlDataImport(req.params.id, req.user!.id);
    const restartScheduled = process.env.NODE_ENV === "production";
    res.json({ job, restartScheduled });
    if (restartScheduled) {
      res.once("finish", () => {
        const timer = setTimeout(() => process.exit(75), 750);
        timer.unref();
      });
    }
  }));

  app.post("/api/system/database-backups/jobs", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    const job = await beginDatabaseBackup({ actorId: req.user!.id });
    res.status(201).json({ job });
  }));

  app.get("/api/system/database-backups/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    res.json({ job: await getDatabaseBackupJob(req.params.id) });
  }));

  app.post("/api/system/database-backups/jobs/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    res.json({ job: await cancelDatabaseBackup(req.params.id) });
  }));

  app.get("/api/system/database-backups/jobs/:id/download", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    const { job, path } = await databaseBackupDownload(req.params.id);
    res.download(path, job.fileName);
  }));

  app.delete("/api/system/database-backups/jobs/:id", requireAuth, asyncRoute(async (req, res) => {
    assertDatabaseImportAccess(req);
    res.json(await deleteDatabaseBackup(req.params.id));
  }));

  app.get("/api/system-settings", requireAuth, (req, res) => {
    res.json({
      settings: teamSystemSettingsForTeam(req.user!.teamId),
      ocr: publicTradeDocumentOcrProvider(tradeDocumentOcrProviderForTeam(req.user!.teamId)),
      canManage: hasIamPermission(req.user!, "system.settings.manage")
    });
  });

  app.put("/api/system-settings", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user!, "system.settings.manage")) {
      res.status(403).json({ message: "当前账号没有系统设置权限" });
      return;
    }
    const body = z.object({ requireDocumentExcelApproval: z.boolean() }).parse(req.body);
    const store = getStore();
    const current = store.teamSystemSettings.find((item) => item.teamId === req.user!.teamId);
    const settings: TeamSystemSettings = {
      teamId: req.user!.teamId,
      requireDocumentExcelApproval: body.requireDocumentExcelApproval,
      productCategories: current?.productCategories || [],
      ocrProviderConfigEncrypted: current?.ocrProviderConfigEncrypted || "",
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    };
    if (current) Object.assign(current, settings);
    else store.teamSystemSettings.push(settings);
    await store.persist();
    res.json({ settings, canManage: true });
  }));

  app.put("/api/system-settings/ocr", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user!, "system.settings.manage")) {
      res.status(403).json({ message: "当前账号没有系统设置权限" });
      return;
    }
    const body = z.object({
      provider: z.enum(["none", "baidu", "siliconflow"]).default("none"),
      enabled: z.boolean().default(false),
      apiKey: z.string().max(400).optional().default(""),
      secretKey: z.string().max(400).optional().default(""),
      model: z.string().max(160).optional().default(""),
      baseUrl: z.string().max(255).optional().default("")
    }).parse(req.body);
    const current = tradeDocumentOcrProviderForTeam(req.user!.teamId);
    const apiKey = body.apiKey && !body.apiKey.includes("****") ? body.apiKey : current.apiKey;
    const secretKey = body.secretKey && !body.secretKey.includes("****") ? body.secretKey : current.secretKey;
    const model = body.model || (body.provider === "siliconflow" ? "Qwen/Qwen2.5-VL-32B-Instruct" : "");
    if (body.enabled && body.provider === "baidu" && (!apiKey || !secretKey)) {
      res.status(400).json({ message: "启用百度 OCR 前，需要同时填写 API Key 和 Secret Key" });
      return;
    }
    if (body.enabled && body.provider === "siliconflow" && !apiKey) {
      res.status(400).json({ message: "启用硅基流动 OCR 前，需要填写 API Key" });
      return;
    }
    const next: TradeDocumentOcrProviderConfig = {
      provider: body.provider as TradeDocumentOcrProvider,
      enabled: body.enabled && body.provider !== "none",
      apiKey,
      secretKey,
      model,
      baseUrl: body.provider === "siliconflow" ? "https://api.siliconflow.cn/v1" : ""
    };
    const store = getStore();
    const settings = teamSystemSettingsForTeam(req.user!.teamId);
    settings.ocrProviderConfigEncrypted = encryptProviderConfiguration(ocrProviderCredentialContext(req.user!.teamId), { apiKey: JSON.stringify(next), baseUrl: "" });
    settings.updatedBy = req.user!.id;
    settings.updatedAt = new Date().toISOString();
    if (!store.teamSystemSettings.some((item) => item.teamId === settings.teamId)) store.teamSystemSettings.push(settings);
    await store.persist();
    res.json({ ocr: publicTradeDocumentOcrProvider(next), canManage: true });
  }));

  app.get("/api/company-profile", requireAuth, (req, res) => {
    res.json({
      profile: companyProfileForTeam(req.user!.teamId),
      canManage: canManageCompanyProfile(req.user!)
    });
  });

  app.put("/api/company-profile", requireAuth, asyncRoute(async (req, res) => {
    if (!canManageCompanyProfile(req.user!)) {
      res.status(403).json({ message: "只有管理员可以维护公司资料" });
      return;
    }
    const body = z.object({
      companyName: z.string().trim().max(200).default(""),
      website: z.string().trim().max(300).default(""),
      productSummary: z.string().trim().max(2000).default(""),
      address: z.string().trim().max(1000).default(""),
      phone: z.string().trim().max(100).default(""),
      email: z.string().trim().max(180).default("")
    }).parse(req.body);
    const store = getStore();
    const current = store.companyProfiles.find((item) => item.teamId === req.user!.teamId);
    const profile: CompanyProfile = {
      teamId: req.user!.teamId,
      ...body,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString()
    };
    if (current) Object.assign(current, profile);
    else store.companyProfiles.push(profile);
    await store.persist();
    res.json({ profile, canManage: true });
  }));
}
