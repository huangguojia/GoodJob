/**
 * 名片 OCR、AI 配置、产品与类目、发货、操作日志、/uploads 静态目录路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canSeeOwner, canSeePersonalData, hasIamPermission, isPlatformIdentity, requireAuth } from "../auth.js";
import { assertAiBaseUrlAllowed } from "../ai-http-security.js";
import { buildTrackingUpdate, getTrackingProvider, isSyncable } from "../tracking-provider.js";
import { callAiModel, callAiModelWithWebSearch } from "../ai-model-runtime.js";
import { aiWebSearchPolicy } from "../ai-web-search-policy.js";
import { type AiModelConfig, type LogEntry, type OcrJob, type Order, type Product, type SessionUser, type Shipment, type ShipmentItem, type TeamSystemSettings } from "../types.js";
import { getStore } from "../store.js";
import { providerErrorFromUnknown } from "../provider-contract.js";
import { syncOrderFulfillment } from "../order-service.js";
import { recognizeTrackingCode } from "../shipment-ocr.js";
import {
  asyncRoute,
  businessCardRecognizer,
  createLeadFromSource,
  documentAssetUrlForLocalFile,
  getAiConfig,
  getAiConfigs,
  teamSystemSettingsForTeam,
  uploadsDir
} from "../server-core.js";

function userCurrentOcrId(user: SessionUser) {
  return `ocr_${user.id}`;
}

function defaultOcrFields() {
  return {
    company: "",
    contact: "",
    title: "",
    email: "",
    whatsapp: "",
    wechat: "",
    phone: "",
    country: "",
    city: ""
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
  const legacyPersonal = store.ocrJobs.find((job) => job.id === "ocr1" && canSeePersonalData(user, job.ownerId));
  if (legacyPersonal) return legacyPersonal;
  if (!createIfMissing) return null;
  const job: OcrJob = {
    id: personalId,
    status: "waiting",
    confidence: 0,
    fields: defaultOcrFields(),
    createdAt: new Date().toISOString(),
    ownerId: user.id,
    teamId: user.teamId
  };
  store.ocrJobs.unshift(job);
  return job;
}

const OCR_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

type OcrImageMime = typeof OCR_IMAGE_MIMES[number];

function ocrPrivateDir() {
  return path.join(uploadsDir, ".ocr-private");
}

function ocrImageBaseName(job: OcrJob) {
  return `card-${createHash("sha256").update(job.id).digest("hex").slice(0, 32)}`;
}

function ocrImageCandidates(job: OcrJob) {
  const base = ocrImageBaseName(job);
  return [
    { path: path.join(ocrPrivateDir(), `${base}.png`), mime: "image/png" as const },
    { path: path.join(ocrPrivateDir(), `${base}.jpg`), mime: "image/jpeg" as const },
    { path: path.join(ocrPrivateDir(), `${base}.webp`), mime: "image/webp" as const }
  ];
}

function findOcrImage(job: OcrJob) {
  return ocrImageCandidates(job).find((candidate) => existsSync(candidate.path)) || null;
}

function publicOcrJob(job: OcrJob) {
  const image = findOcrImage(job);
  const hasFields = Object.values(job.fields).some((value) => String(value || "").trim());
  return {
    ...job,
    status: !image && !hasFields ? "waiting" : job.status,
    hasImage: Boolean(image),
    imageUrl: image ? `/api/tools/ocr/jobs/${encodeURIComponent(job.id)}/image` : ""
  };
}

function decodeVerifiedOcrImage(image: string, declaredMime: OcrImageMime) {
  const encoded = image.includes(",") ? image.slice(image.indexOf(",") + 1) : image;
  if (!encoded || !/^[A-Za-z0-9+/=\r\n]+$/u.test(encoded)) {
    throw new Error("名片图片 Base64 格式无效");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
    throw new Error("名片图片大小必须在 2 MB 以内");
  }
  const png = buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff;
  const webp = buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const actualMime: OcrImageMime | "" = png
    ? "image/png"
    : jpeg
      ? "image/jpeg"
      : webp
        ? "image/webp"
        : "";
  if (!actualMime || actualMime !== declaredMime) {
    throw new Error("图片内容与声明格式不一致，仅支持真实 PNG、JPEG 或 WebP");
  }
  return {
    buffer,
    mime: actualMime,
    extension: actualMime === "image/png" ? "png" : actualMime === "image/webp" ? "webp" : "jpg"
  };
}

function ocrBatchJobsForUser(user: SessionUser, batchId = "") {
  return getStore().ocrJobs
    .filter((job) => job.ownerId === user.id && Boolean(job.batchId) && (!batchId || job.batchId === batchId))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function normalizeProductCategoryName(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function productCategoriesForUser(user: SessionUser) {
  const configured = teamSystemSettingsForTeam(user.teamId).productCategories || [];
  const fromProducts = getStore().products
    .filter((item) => canSeeOwner(user, item.ownerId, item.teamId))
    .map((item) => item.category);
  const names = new Map<string, string>();
  [...configured, ...fromProducts].forEach((value) => {
    const name = normalizeProductCategoryName(value);
    if (name) names.set(name.toLocaleLowerCase(), name);
  });
  return [...names.values()].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function saveTeamProductCategoryConfig(user: SessionUser, categories: string[]) {
  const store = getStore();
  const current = store.teamSystemSettings.find((item) => item.teamId === user.teamId);
  const settings: TeamSystemSettings = {
    teamId: user.teamId,
    requireDocumentExcelApproval: current?.requireDocumentExcelApproval || false,
    productCategories: categories,
    updatedBy: user.id,
    updatedAt: new Date().toISOString()
  };
  if (current) Object.assign(current, settings);
  else store.teamSystemSettings.push(settings);
}

function coerceShipmentItems(input: unknown): ShipmentItem[] {
  if (!Array.isArray(input)) return [];
  return input.map((raw, index) => {
    const item = (raw || {}) as Record<string, unknown>;
    const num = (value: unknown) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      id: typeof item.id === "string" && item.id ? item.id : `si_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      orderItemId: typeof item.orderItemId === "string" ? item.orderItemId.slice(0, 64) : undefined,
      productName: String(item.productName || "").slice(0, 200),
      model: String(item.model || "").slice(0, 200),
      hsCode: String(item.hsCode || "").slice(0, 40),
      quantity: num(item.quantity),
      unit: String(item.unit || "pcs").slice(0, 20),
      netWeight: num(item.netWeight),
      grossWeight: num(item.grossWeight),
      length: num(item.length),
      width: num(item.width),
      height: num(item.height),
      volume: num(item.volume),
      note: String(item.note || "").slice(0, 500)
    };
  });
}

/**
 * 发货 / 单证这类「非订单路由」里判断能否挂到某张订单。
 * 不能复用 canSeeOwner：那些路由不会为 order.read 填充 iamDataScope，
 * 有 iamPermissions 但没有数据范围时会一律判 false（实测发货单 404）。
 * 这里用权限码 + 团队 + 归属三者显式判断。
 */
function ordCanLink(user: SessionUser, order: Order): boolean {
  if (isPlatformIdentity(user)) return false;
  if (order.teamId !== user.teamId) return false;
  if (user.role === "super_admin" || user.role === "admin" || user.role === "manager") return true;
  const scopes = user.iamPermissions?.["order.read"];
  if (scopes?.length) {
    return scopes.includes("tenant")
      || scopes.includes("org_subtree")
      || order.ownerId === user.id;
  }
  return order.ownerId === user.id;
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
    webSearchStatus: config.webSearchStatus || "untested",
    webSearchTestAt: config.webSearchTestAt || "",
    webSearchTestMessage: config.webSearchTestMessage || "",
    webSearchCitationCount: config.webSearchCitationCount || 0,
    ownerId: config.ownerId,
    teamId: config.teamId,
    updatedAt: config.updatedAt
  };
}

async function testAiConfig(config: AiModelConfig) {
  let ordinaryMessage = "";
  try {
    const content = await callAiModel(config, "只返回 JSON：{\"ok\":true}", 1200);
    const ok = /ok|true/i.test(content);
    ordinaryMessage = ok
      ? `${providerLabel(config.provider)} 普通 AI 调用通过`
      : "模型已响应，但返回内容不符合测试格式";
    if (!ok) {
      return {
        ok: false,
        message: ordinaryMessage,
        webSearchStatus: "failed" as const,
        webSearchMessage: "普通 AI 调用未通过，尚未执行 Web Search 测试。",
        webSearchCitationCount: 0
      };
    }
  } catch (error) {
    const failure = providerErrorFromUnknown(error, "search");
    return {
      ok: false,
      message: `AI 连接失败：${failure.publicMessage}`,
      webSearchStatus: "failed" as const,
      webSearchMessage: "普通 AI 调用失败，尚未执行 Web Search 测试。",
      webSearchCitationCount: 0
    };
  }
  if (!config.useLeadFinder) {
    return {
      ok: true,
      message: `${ordinaryMessage}；当前未启用自动获客，未要求 Web Search。`,
      webSearchStatus: "untested" as const,
      webSearchMessage: "当前配置未勾选自动获客，因此未执行官网联网测试。",
      webSearchCitationCount: 0
    };
  }
  const policy = aiWebSearchPolicy(config);
  if (!policy.supported) {
    return {
      ok: true,
      message: `${ordinaryMessage}；当前模型不支持 OpenAI Web Search。自动搜客时请配置 Brave、Serper、SerpApi 或 Google Places，官网将由搜索 API 补查，模型猜测的网址不会保存。`,
      webSearchStatus: "unsupported" as const,
      webSearchMessage: "当前模型不支持原生 Web Search；配置官网搜索 API 后仍可用于生成企业候选。",
      webSearchCitationCount: 0
    };
  }
  try {
    const webResult = await callAiModelWithWebSearch(
      config,
      "搜索 OpenAI 官方网站，并只返回一句简短确认；必须实际执行 Web Search 并返回引用。",
      1_200,
      undefined,
      45_000
    );
    if (!webResult.usedSearch || !webResult.citations.length) {
      const message = "普通 AI 调用通过，但模型没有返回 Web Search 引用，无法用于确认官网。请检查 Responses API Web Search 权限或更换配置。";
      return {
        ok: false,
        message,
        webSearchStatus: "failed" as const,
        webSearchMessage: message,
        webSearchCitationCount: webResult.citations.length
      };
    }
    const message = `${ordinaryMessage}；Web Search 已启用，返回 ${webResult.citations.length} 条引用，可用于官网发现。`;
    return {
      ok: true,
      message,
      webSearchStatus: "passed" as const,
      webSearchMessage: message,
      webSearchCitationCount: webResult.citations.length
    };
  } catch (error) {
    const failure = providerErrorFromUnknown(error, "search");
    const message = `${ordinaryMessage}，但 Web Search 测试失败：${failure.publicMessage}。自动搜客不会采信模型猜测的官网。`;
    return {
      ok: false,
      message,
      webSearchStatus: "failed" as const,
      webSearchMessage: message,
      webSearchCitationCount: 0
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

export function registerToolsRoutes(app: Express) {
  app.get("/api/tools/ocr/batches/current", requireAuth, (req, res) => {
    const jobs = ocrBatchJobsForUser(req.user!);
    const batchId = jobs.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0]?.batchId || "";
    res.setHeader("Cache-Control", "no-store");
    res.json({ batchId, jobs: batchId ? jobs.filter((job) => job.batchId === batchId).map(publicOcrJob) : [] });
  });

  app.post("/api/tools/ocr/batches", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      files: z.array(z.object({
        name: z.string().trim().min(1).max(255),
        size: z.number().int().min(1).max(2 * 1024 * 1024),
        mime: z.enum(OCR_IMAGE_MIMES)
      })).min(1).max(50)
    }).parse(req.body);
    const store = getStore();
    const batchId = `ocrb_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const jobs = body.files.map((file, index): OcrJob => ({
      id: `ocr_${randomUUID()}`,
      status: "waiting",
      confidence: 0,
      fields: defaultOcrFields(),
      batchId,
      sourceFileName: file.name,
      errorMessage: "",
      createdAt: new Date(Date.parse(createdAt) + index).toISOString(),
      ownerId: req.user!.id,
      teamId: req.user!.teamId
    }));
    store.ocrJobs.unshift(...jobs);
    await store.persist();
    res.status(201).json({ batchId, jobs: jobs.map(publicOcrJob) });
  }));

  app.delete("/api/tools/ocr/batches/:batchId", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const jobs = ocrBatchJobsForUser(req.user!, req.params.batchId);
    if (!jobs.length) {
      res.status(404).json({ message: "名片批次不存在" });
      return;
    }
    await Promise.all(jobs.flatMap((job) => ocrImageCandidates(job).map((candidate) => rm(candidate.path, { force: true }))));
    const ids = new Set(jobs.map((job) => job.id));
    store.ocrJobs = store.ocrJobs.filter((job) => !ids.has(job.id));
    await store.persist();
    res.json({ deleted: jobs.length });
  }));

  app.get("/api/tools/ocr/jobs/:id", requireAuth, (req, res) => {
    const job = resolveOcrJob(req.user!, req.params.id, true);
    if (!job) {
      res.status(404).json({ message: "OCR 任务不存在" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ job: publicOcrJob(job) });
  });

  app.get("/api/tools/ocr/jobs/:id/image", requireAuth, asyncRoute(async (req, res) => {
    const job = resolveOcrJob(req.user!, req.params.id, false);
    const image = job ? findOcrImage(job) : null;
    if (!job || !image) {
      res.status(404).json({ message: "名片图片不存在或无权访问" });
      return;
    }
    const buffer = await readFile(image.path);
    res.setHeader("Content-Type", image.mime);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  }));

  app.post("/api/tools/ocr/jobs/:id/image", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      image: z.string().min(1, "请选择名片图片").max(3_000_000),
      mime: z.enum(OCR_IMAGE_MIMES),
      fileName: z.string().trim().max(255).default("")
    }).parse(req.body);
    const job = resolveOcrJob(req.user!, req.params.id, true);
    if (!job) {
      res.status(404).json({ message: "OCR 任务不存在" });
      return;
    }
    let image: ReturnType<typeof decodeVerifiedOcrImage>;
    try {
      image = decodeVerifiedOcrImage(body.image, body.mime);
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "名片图片无效" });
      return;
    }
    await mkdir(ocrPrivateDir(), { recursive: true });
    await Promise.all(ocrImageCandidates(job).map((candidate) => rm(candidate.path, { force: true })));
    const target = path.join(ocrPrivateDir(), `${ocrImageBaseName(job)}.${image.extension}`);
    await writeFile(target, image.buffer, { flag: "wx" });
    job.status = "uploaded";
    job.confidence = 0;
    job.fields = defaultOcrFields();
    job.sourceFileName ||= body.fileName;
    job.errorMessage = "";
    await getStore().persist();
    res.status(201).json({
      job: publicOcrJob(job),
      fileName: body.fileName,
      message: "名片已安全加载，正在识别"
    });
  }));

  app.delete("/api/tools/ocr/jobs/:id/image", requireAuth, asyncRoute(async (req, res) => {
    const job = resolveOcrJob(req.user!, req.params.id, false);
    if (!job) {
      res.status(404).json({ message: "OCR 任务不存在" });
      return;
    }
    await Promise.all(ocrImageCandidates(job).map((candidate) => rm(candidate.path, { force: true })));
    job.status = "waiting";
    job.confidence = 0;
    job.fields = defaultOcrFields();
    await getStore().persist();
    res.json({ job: publicOcrJob(job) });
  }));

  app.post("/api/tools/ocr/jobs/:id/recognize-image", requireAuth, asyncRoute(async (req, res) => {
    const job = resolveOcrJob(req.user!, req.params.id, false);
    const image = job ? findOcrImage(job) : null;
    if (!job || !image) {
      res.status(400).json({ message: "请先加载一张名片图片" });
      return;
    }
    const config = getAiConfig(req.user!);
    if (!config || !config.enabled || !config.apiKey || !config.baseUrl || !config.model) {
      res.status(422).json({ message: "未配置可用的 AI 视觉模型，可先人工填写字段，或前往 AI 配置后重新识别" });
      return;
    }
    try {
      const buffer = await readFile(image.path);
      const recognition = await businessCardRecognizer(
        `data:${image.mime};base64,${buffer.toString("base64")}`,
        image.mime,
        config
      );
      job.status = "recognized";
      job.confidence = recognition.confidence;
      job.fields = { ...defaultOcrFields(), ...recognition.fields };
      job.errorMessage = "";
      await getStore().persist();
      res.json({ job: publicOcrJob(job) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "名片识别失败";
      job.status = "failed";
      job.errorMessage = detail;
      await getStore().persist();
      res.status(422).json({
        message: detail.includes("图片") || detail.includes("名片") || detail.includes("模型")
          ? detail
          : `名片识别失败：${detail}`
      });
    }
  }));

  app.post("/api/tools/ocr/jobs/:id/recognize", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      confidence: z.coerce.number().min(0).max(100).optional(),
      company: z.string().trim().max(200).optional(),
      contact: z.string().trim().max(120).optional(),
      title: z.string().trim().max(120).optional(),
      email: z.string().trim().max(254).optional(),
      whatsapp: z.string().trim().max(60).optional(),
      wechat: z.string().trim().max(80).optional(),
      phone: z.string().trim().max(60).optional(),
      country: z.string().trim().max(80).optional(),
      city: z.string().trim().max(120).optional()
    }).parse(req.body);
    const store = getStore();
    const job = resolveOcrJob(req.user!, req.params.id, true);
    if (!job) {
      res.status(404).json({ message: "OCR 任务不存在" });
      return;
    }
    job.status = "recognized";
    job.errorMessage = "";
    job.confidence = body.confidence ?? job.confidence;
    job.fields = {
      ...job.fields,
      company: body.company ?? job.fields.company,
      contact: body.contact ?? job.fields.contact,
      title: body.title ?? job.fields.title,
      email: body.email ?? job.fields.email,
      whatsapp: body.whatsapp ?? job.fields.whatsapp,
      wechat: body.wechat ?? job.fields.wechat,
      phone: body.phone ?? job.fields.phone,
      country: body.country ?? job.fields.country,
      city: body.city ?? job.fields.city
    };
    await store.persist();
    res.json({ job: publicOcrJob(job) });
  }));

  app.post("/api/tools/ocr/jobs/:id/sync-lead", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const job = resolveOcrJob(req.user!, req.params.id, false);
    if (!job) {
      res.status(404).json({ message: "OCR 任务不存在" });
      return;
    }
    if (!job.fields.company.trim()) {
      res.status(400).json({ message: "请先确认公司名，再同步到线索" });
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
      inquiryContent: "",
      rawPayload: job.fields
    });
    job.status = "synced";
    job.errorMessage = "";
    await store.persist();
    res.json({ ...result, job: publicOcrJob(job) });
  }));

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
    let baseUrl = "";
    try {
      baseUrl = assertAiBaseUrlAllowed(body.baseUrl);
    } catch {
      res.status(400).json({ message: "AI Base URL 必须是公网 HTTPS 标准端口地址，且不能包含账号、查询参数或片段" });
      return;
    }
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
      baseUrl,
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
      webSearchStatus: existing
        && existing.provider === body.provider
        && existing.protocol === body.protocol
        && existing.baseUrl === baseUrl
        && existing.model === body.model
        && existing.apiKey === apiKey
        ? existing.webSearchStatus || "untested"
        : "untested",
      webSearchTestAt: existing?.webSearchTestAt,
      webSearchTestMessage: existing?.webSearchTestMessage || "",
      webSearchCitationCount: existing?.webSearchCitationCount || 0,
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
    const config = getAiConfig(req.user!);
    res.json({ config: config ? publicAiConfig(config) : null, configs: getAiConfigs(req.user!).map(publicAiConfig) });
    // 持久化在后台进行，不阻塞删除响应（全量快照写入较慢）
    void store.persist().catch((err) => console.error("ai-config delete persist failed:", err));
  }));

  app.get("/api/tools/products", requireAuth, (req, res) => {
    const store = getStore();
    const products = store.products
      .filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    res.json({ products, categories: productCategoriesForUser(req.user!) });
  });

  app.post("/api/tools/product-categories", requireAuth, asyncRoute(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1, "分类名称不能为空").max(80) }).parse(req.body);
    const category = normalizeProductCategoryName(name);
    const categories = productCategoriesForUser(req.user!);
    if (categories.some((item) => item.toLocaleLowerCase() === category.toLocaleLowerCase())) {
      res.status(409).json({ message: "该产品分类已存在" });
      return;
    }
    saveTeamProductCategoryConfig(req.user!, [...categories, category]);
    await getStore().persist();
    res.status(201).json({ categories: productCategoriesForUser(req.user!) });
  }));

  app.patch("/api/tools/product-categories", requireAuth, asyncRoute(async (req, res) => {
    const body = z.object({
      currentName: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1, "分类名称不能为空").max(80)
    }).parse(req.body);
    const currentName = normalizeProductCategoryName(body.currentName);
    const name = normalizeProductCategoryName(body.name);
    const categories = productCategoriesForUser(req.user!);
    if (!categories.some((item) => item.toLocaleLowerCase() === currentName.toLocaleLowerCase())) {
      res.status(404).json({ message: "产品分类不存在" });
      return;
    }
    if (categories.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase() && item.toLocaleLowerCase() !== currentName.toLocaleLowerCase())) {
      res.status(409).json({ message: "目标分类名称已存在" });
      return;
    }
    const store = getStore();
    store.products.forEach((item) => {
      if (item.teamId === req.user!.teamId && item.category.toLocaleLowerCase() === currentName.toLocaleLowerCase()) {
        item.category = name;
        item.updatedAt = new Date().toISOString();
      }
    });
    saveTeamProductCategoryConfig(req.user!, categories.map((item) => item.toLocaleLowerCase() === currentName.toLocaleLowerCase() ? name : item));
    await store.persist();
    res.json({
      categories: productCategoriesForUser(req.user!),
      products: store.products.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
    });
  }));

  app.delete("/api/tools/product-categories/:name", requireAuth, asyncRoute(async (req, res) => {
    const name = normalizeProductCategoryName(req.params.name);
    if (!name) {
      res.status(400).json({ message: "分类名称不能为空" });
      return;
    }
    const categories = productCategoriesForUser(req.user!);
    if (!categories.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      res.status(404).json({ message: "产品分类不存在" });
      return;
    }
    const store = getStore();
    store.products.forEach((item) => {
      if (item.teamId === req.user!.teamId && item.category.toLocaleLowerCase() === name.toLocaleLowerCase()) {
        item.category = "";
        item.updatedAt = new Date().toISOString();
      }
    });
    saveTeamProductCategoryConfig(req.user!, categories.filter((item) => item.toLocaleLowerCase() !== name.toLocaleLowerCase()));
    await store.persist();
    res.json({
      categories: productCategoriesForUser(req.user!),
      products: store.products.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId))
    });
  }));

  app.post("/api/tools/products", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      id: z.string().min(1).max(64).optional(),
      nameZh: z.string().min(1, "中文品名必填").max(200),
      nameEn: z.string().max(200).default(""),
      model: z.string().max(200).default(""),
      category: z.string().max(80).default(""),
      unit: z.string().max(20).default("pcs"),
      price: z.number().min(0).default(0),
      currency: z.string().max(10).default("USD"),
      hsCode: z.string().max(40).default(""),
      descriptionZh: z.string().max(4000).default(""),
      descriptionEn: z.string().max(4000).default(""),
      tags: z.array(z.string().max(60)).max(30).default([]),
      imageUrl: z.string().max(512).default(""),
      packLength: z.number().min(0).optional(),
      packWidth: z.number().min(0).optional(),
      packHeight: z.number().min(0).optional(),
      packWeight: z.number().min(0).optional()
    });
    let body;
    try {
      body = schema.parse(req.body);
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : "产品参数不合法" });
      return;
    }
    const store = getStore();
    const existing = body.id
      ? store.products.find((item) => item.id === body.id && canSeeOwner(req.user!, item.ownerId, item.teamId))
      : undefined;
    const product: Product = {
      id: existing?.id || body.id || `prod_${req.user!.id}_${Date.now()}`,
      nameZh: body.nameZh,
      nameEn: body.nameEn,
      model: body.model,
      category: body.category,
      unit: body.unit,
      price: body.price,
      currency: body.currency,
      hsCode: body.hsCode,
      descriptionZh: body.descriptionZh,
      descriptionEn: body.descriptionEn,
      tags: body.tags,
      imageUrl: documentAssetUrlForLocalFile(body.imageUrl) || body.imageUrl,
      packLength: body.packLength,
      packWidth: body.packWidth,
      packHeight: body.packHeight,
      packWeight: body.packWeight,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, product);
    else store.products.unshift(product);
    // 轻量级、同步落库：仅写 products 表，毫秒级完成，避免全量快照的卡顿，同时保证刷新不丢数据
    await store.persistProducts().catch((err) => console.error("products persist failed:", err));
    res.json({ product, products: store.products.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId)), categories: productCategoriesForUser(req.user!) });
  }));

  app.delete("/api/tools/products/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.products.findIndex((item) => item.id === req.params.id && canSeeOwner(req.user!, item.ownerId, item.teamId));
    if (index < 0) {
      res.status(404).json({ message: "产品不存在或无权删除" });
      return;
    }
    const removed = store.products[index];
    store.products.splice(index, 1);
    await store.persistProducts().catch((err) => console.error("products delete persist failed:", err));
    res.json({ product: removed, products: store.products.filter((item) => canSeeOwner(req.user!, item.ownerId, item.teamId)), categories: productCategoriesForUser(req.user!) });
  }));

  app.use("/uploads", express.static(uploadsDir));

  app.get("/api/tools/shipments", requireAuth, (req, res) => {
    const store = getStore();
    const shipments = store.shipments
      .filter((item) => item.ownerId === req.user!.id)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    res.json({ shipments });
  });

  app.post("/api/tools/shipments", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      id: z.string().min(1).max(64).optional(),
      shipmentNo: z.string().max(80).default(""),
      dealId: z.string().max(64).default(""),
      /** 关联订单：发完自动回写进度与状态，未关联则保持原有独立发货流程。 */
      orderId: z.string().max(64).default(""),
      dealTitle: z.string().max(200).default(""),
      customerName: z.string().max(200).default(""),
      destinationCountry: z.string().max(120).default(""),
      destinationPort: z.string().max(160).default(""),
      destinationAddress: z.string().max(2000).default(""),
      courier: z.string().max(40).default(""),
      trackingCode: z.string().max(120).default(""),
      trackingImageUrl: z.string().max(512).default(""),
      status: z.enum(["draft", "shipped", "in_transit", "delivered", "exception"]).default("draft"),
      statusSource: z.enum(["local", "carrier"]).optional(),
      lastSyncedAt: z.string().max(40).optional(),
      syncError: z.string().max(500).optional(),
      trackingEvents: z.array(z.any()).max(200).optional(),
      shippedAt: z.string().max(40).default(""),
      estimatedArrival: z.string().max(40).default(""),
      note: z.string().max(4000).default(""),
      items: z.array(z.any()).max(100).default([])
    });
    let body;
    try {
      body = schema.parse(req.body);
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : "发货单参数不合法" });
      return;
    }
    const store = getStore();
    const existing = body.id
      ? store.shipments.find((item) => item.id === body.id && item.ownerId === req.user!.id)
      : undefined;
    const linkedOrder = body.orderId
      ? store.orders.find((item) => item.id === body.orderId && ordCanLink(req.user!, item))
      : undefined;
    if (body.orderId && !linkedOrder) {
      res.status(404).json({ message: "关联订单不存在或无权访问" });
      return;
    }
    if (linkedOrder && ["pending", "cancelled", "completed"].includes(linkedOrder.status)) {
      res.status(409).json({
        message: linkedOrder.status === "pending"
          ? "订单尚未确认，不能建发货单"
          : "已取消/已完成的订单不能再建发货单"
      });
      return;
    }
    const shipment: Shipment = {
      id: existing?.id || body.id || `ship_${req.user!.id}_${Date.now()}`,
      shipmentNo: body.shipmentNo,
      dealId: body.dealId || linkedOrder?.dealId || "",
      dealTitle: body.dealTitle,
      customerName: body.customerName || linkedOrder?.customerName || "",
      destinationCountry: body.destinationCountry,
      destinationPort: body.destinationPort,
      destinationAddress: body.destinationAddress,
      courier: body.courier,
      trackingCode: body.trackingCode,
      trackingImageUrl: body.trackingImageUrl,
      status: body.status,
      statusSource: body.statusSource ?? existing?.statusSource ?? "local",
      lastSyncedAt: body.lastSyncedAt ?? existing?.lastSyncedAt ?? undefined,
      syncError: body.syncError ?? existing?.syncError ?? "",
      trackingEvents: body.trackingEvents ?? existing?.trackingEvents ?? [],
      shippedAt: body.shippedAt,
      estimatedArrival: body.estimatedArrival,
      note: body.note,
      items: coerceShipmentItems(body.items),
      orderId: body.orderId || existing?.orderId || "",
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, shipment);
    else store.shipments.unshift(shipment);
    // 轻量级、同步落库：仅写 shipments 表，毫秒级完成，保证刷新不丢数据
    await store.persistShipments().catch((err) => console.error("shipments persist failed:", err));
    // 关联订单时再同步一次订单进度：这里必须走 store.persist()，因为
    // persistShipments 只写 shipments 表，订单的 shipped_qty 不会落库。
    if (shipment.orderId) {
      syncOrderFulfillment({ store, orderId: shipment.orderId, operatorId: req.user!.id });
      await store.persist().catch((err) => console.error("order progress persist failed:", err));
    }
    res.json({ shipment, shipments: store.shipments.filter((item) => item.ownerId === req.user!.id) });
  }));

  app.delete("/api/tools/shipments/:id", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const index = store.shipments.findIndex((item) => item.id === req.params.id && item.ownerId === req.user!.id);
    if (index < 0) {
      res.status(404).json({ message: "发货单不存在或无权删除" });
      return;
    }
    const removed = store.shipments[index];
    store.shipments.splice(index, 1);
    await store.persistShipments().catch((err) => console.error("shipments delete persist failed:", err));
    // 删除发货单要允许进度回退：否则订单会永久停在「已发货」，而货其实没发。
    if (removed.orderId) {
      syncOrderFulfillment({ store, orderId: removed.orderId, operatorId: req.user!.id });
      await store.persist().catch((err) => console.error("order progress rollback failed:", err));
    }
    res.json({ shipment: removed, shipments: store.shipments.filter((item) => item.ownerId === req.user!.id) });
  }));

  // 单条发货单物流同步：交运后状态以承运商官网为准
  app.post("/api/tools/shipments/:id/sync", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const shipment = store.shipments.find((item) => item.id === req.params.id && item.ownerId === req.user!.id);
    if (!shipment) {
      res.status(404).json({ message: "发货单不存在或无权访问" });
      return;
    }
    // 无运单号无法查询；只要已有运单号，草稿也允许用户手动触发真实查询。
    if (!isSyncable(shipment.status, shipment.trackingCode)) {
      res.json({
        shipment,
        shipments: store.shipments.filter((item) => item.ownerId === req.user!.id),
        synced: false,
        reason: shipment.status === "draft" ? "草稿状态无需同步" : !shipment.trackingCode ? "未录入运单号，无法查询官网" : "该状态无需同步"
      });
      return;
    }
    // 已签收为终态，手动标记优先，官网不再回退
    if (shipment.status === "delivered") {
      res.json({
        shipment,
        shipments: store.shipments.filter((item) => item.ownerId === req.user!.id),
        synced: false,
        reason: "已签收为终态，保留本地状态"
      });
      return;
    }
    const provider = getTrackingProvider(shipment.courier);
    let snapshot;
    try {
      snapshot = await provider.query({
        courier: shipment.courier,
        trackingCode: shipment.trackingCode.trim(),
        shippedAt: shipment.shippedAt,
        destination: shipment.destinationAddress || shipment.destinationCountry || ""
      });
    } catch (err) {
      // 查询失败也落库，便于前端看到 Token、网络或运单异常的具体原因。
      const reason = err instanceof Error ? err.message : "承运商查询失败";
      shipment.syncError = reason.slice(0, 500);
      shipment.updatedAt = new Date().toISOString();
      await store.persistShipments().catch((persistError) => console.error("shipment sync error persist failed:", persistError));
      res.json({
        shipment,
        shipments: store.shipments.filter((item) => item.ownerId === req.user!.id),
        synced: false,
        reason
      });
      return;
    }
    const update = buildTrackingUpdate(shipment, snapshot);
    Object.assign(shipment, update);
    shipment.updatedAt = new Date().toISOString();
    await store.persistShipments().catch((err) => console.error("shipments sync persist failed:", err));
    res.json({
      shipment,
      shipments: store.shipments.filter((item) => item.ownerId === req.user!.id),
      synced: true,
      snapshot
    });
  }));

  // 批量同步当前用户所有在途发货单（视图打开时自动调用）
  app.post("/api/tools/shipments/sync-all", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const mine = store.shipments.filter((item) => item.ownerId === req.user!.id);
    const targets = mine.filter((s) => isSyncable(s.status, s.trackingCode) && s.status !== "delivered");
    let updated = 0;
    for (const shipment of targets) {
      try {
        const provider = getTrackingProvider(shipment.courier);
        const snapshot = await provider.query({
          courier: shipment.courier,
          trackingCode: shipment.trackingCode.trim(),
          shippedAt: shipment.shippedAt
        });
        const update = buildTrackingUpdate(shipment, snapshot);
        Object.assign(shipment, update);
        shipment.updatedAt = new Date().toISOString();
        updated += 1;
      } catch (err) {
        shipment.syncError = err instanceof Error ? err.message : "同步失败";
      }
    }
    await store.persistShipments().catch((err) => console.error("shipments sync-all persist failed:", err));
    res.json({
      updated,
      total: targets.length,
      shipments: store.shipments.filter((item) => item.ownerId === req.user!.id)
    });
  }));

  app.get("/api/tools/logs", requireAuth, asyncRoute(async (req, res) => {
    const store = getStore();
    const level = typeof req.query.level === "string" ? req.query.level : "";
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim().toLowerCase() : "";
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const u = req.user!;
    if (isPlatformIdentity(u) || !hasIamPermission(u, "audit.read")) {
      res.status(403).json({ message: "当前账号没有操作审计查看权限" });
      return;
    }
    if (store.resolveIamDataScope) {
      u.iamDataScope = { permissionCode: "audit.read", ...await store.resolveIamDataScope(u, "audit.read") };
    }
    let logs = store.logs;
    const scope = u.iamDataScope;
    if (scope?.tenantWide) {
      logs = logs.filter((item) => (item.teamId || "") === u.teamId);
    } else {
      const ownerIds = new Set(scope?.ownerIds?.length ? scope.ownerIds : [u.id]);
      logs = logs.filter((item) => (item.teamId || "") === u.teamId && ownerIds.has(item.ownerId));
    }
    if (level) logs = logs.filter((item) => item.level === level);
    if (category) logs = logs.filter((item) => item.category === category);
    if (keyword) {
      logs = logs.filter((item) =>
        (item.message || "").toLowerCase().includes(keyword) ||
        (item.actorName || "").toLowerCase().includes(keyword) ||
        (item.action || "").toLowerCase().includes(keyword)
      );
    }
    logs = logs
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
    res.json({ logs });
  }));

  app.post("/api/tools/logs", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      id: z.string().min(1).max(64).optional(),
      level: z.enum(["info", "success", "warning", "error"]).default("info"),
      category: z.enum(["auth", "product", "shipment", "system"]).default("system"),
      action: z.string().max(60).default(""),
      message: z.string().max(800).default(""),
      actorId: z.string().max(64).default(""),
      actorName: z.string().max(120).default(""),
      meta: z.record(z.unknown()).default({}),
      createdAt: z.string().max(40).default("")
    });
    let body;
    try {
      body = schema.parse(req.body);
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : "日志参数不合法" });
      return;
    }
    const store = getStore();
    const log: LogEntry = {
      id: body.id || `log_${req.user!.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      level: body.level,
      category: body.category,
      action: body.action,
      message: body.message,
      actorId: body.actorId || req.user!.id,
      actorName: body.actorName || req.user!.name,
      meta: body.meta,
      createdAt: body.createdAt || new Date().toISOString(),
      ownerId: req.user!.id,
      teamId: req.user!.teamId
    };
    store.logs.unshift(log);
    await store.persistLogs().catch((err) => console.error("logs persist failed:", err));
    res.json({ log, logs: store.logs.filter((item) => item.ownerId === req.user!.id) });
  }));

  app.post("/api/tools/shipments/ocr", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      image: z.string().min(1, "请先上传运单号图片"),
      mime: z.string().max(80).default("image/png")
    });
    let body;
    try {
      body = schema.parse(req.body);
    } catch (err) {
      res.status(400).json({ ok: false, message: err instanceof Error ? err.message : "参数不合法" });
      return;
    }
    const config = getAiConfig(req.user!);
    if (!config || !config.enabled || !config.apiKey || !config.baseUrl || !config.model) {
      res.status(422).json({ ok: false, message: "未配置可用的 AI 视觉模型，请手动填写运单号" });
      return;
    }
    const mime = body.mime.includes("png") ? "image/png" : "image/jpeg";
    const ext = mime === "image/png" ? "png" : "jpg";
    const fileId = `ship_ocr_${req.user!.id}_${Date.now()}`;
    let imageUrl = "";
    try {
      await mkdir(uploadsDir, { recursive: true });
      const base64 = body.image.includes(",") ? body.image.split(",")[1] : body.image;
      await writeFile(path.join(uploadsDir, `${fileId}.${ext}`), Buffer.from(base64, "base64"));
      imageUrl = `/uploads/${fileId}.${ext}`;
    } catch (err) {
      console.error("shipment ocr image save failed:", err);
    }
    try {
      const trackingCode = await recognizeTrackingCode(body.image, mime, config);
      res.json({ ok: true, trackingCode, imageUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI 识别运单号失败";
      res.status(422).json({ ok: false, message, imageUrl });
    }
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
    const testedAt = new Date().toISOString();
    config.lastTestAt = testedAt;
    config.lastTestStatus = result.ok ? "passed" : "failed";
    config.lastTestMessage = result.message;
    config.webSearchStatus = result.webSearchStatus;
    config.webSearchTestAt = testedAt;
    config.webSearchTestMessage = result.webSearchMessage;
    config.webSearchCitationCount = result.webSearchCitationCount;
    config.updatedAt = new Date().toISOString();
    await getStore().persist();
    res.json({ ok: result.ok, message: result.message, config: publicAiConfig(config), configs: getAiConfigs(req.user!).map(publicAiConfig) });
  }));
}
