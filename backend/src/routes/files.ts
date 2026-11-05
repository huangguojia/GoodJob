/**
 * 文件中心、存储、分享路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import express, { type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hasIamPermission, requireAuth } from "../auth.js";
import { getSupplierRepository } from "../supplier-repository.js";
import { contentDisposition, FILE_CHUNK_BYTES, FILE_MAX_BYTES, getFileRepository, isPreviewable, LocalStorageDriver, type MysqlFileRepository, sanitizeOriginalName, sniffFileType, type StoredFile, UPLOAD_SESSION_MAX_OPEN, UPLOAD_SESSION_TTL_MS } from "../file-storage.js";
import { deriveQueue, isHeicFile, isOfficeFile, previewCapabilityIssue, probeDeriveCapabilities, retryDerivation } from "../file-derive.js";
import { buildWatermarkText, createShareToken, hashSharePassword, SHARE_BLOCK_TEXT, shareBlockReason, shareCookieMatches, shareCookieName, shareCookieValue, sharePageHtml, verifySharePassword, watermarkPdf } from "../file-share.js";
import { buildZipStream, mergePdfs } from "../file-bundle.js";
import { type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { asyncRoute, enforceIamTenantPermission, fileIsAdmin, loadAccessibleFile, orderVisible } from "../server-core.js";

// ---------------------------------------------------------------------------
// 文件存储（M1）：上传 / 元数据 / 预览 / 下载（Range）/ 回收站 / 台账 / 仪表盘
//
// 这一层与 knowledge_assets（链接制）并存：旧资料仍然是「外链资料」，
// 新上传的才是真文件。订单详情双读两套数据，见 GET /api/orders/:id。
// ---------------------------------------------------------------------------

const fileDriver = new LocalStorageDriver();

function fileClientView(file: StoredFile | null) {
  if (!file) return null;
  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    mime: file.mime,
    sha256: file.sha256,
    visibility: file.visibility,
    status: file.status,
    ownerId: file.ownerId,
    teamId: file.teamId,
    createdAt: file.createdAt,
    deriveStatus: file.deriveStatus,
    deriveError: file.deriveError,
    legalHold: file.legalHold,
    previewable: isPreviewable(file.mime) || isOfficeFile(file.mime, file.originalName) || isHeicFile(file.mime, file.originalName)
  };
}

async function sendStoredFile(req: Request, res: Response, file: StoredFile) {
  const stat = await fileDriver.stat(file.key);
  if (!stat) {
    res.status(410).json({ message: "文件本体已丢失，请联系管理员从备份恢复" });
    return;
  }
  const total = stat.size || file.size;
  const etag = `"${(file.sha256 || "").slice(0, 16)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  let start = 0;
  let end = Math.max(0, total - 1);
  let status = 200;
  const rangeHeader = String(req.headers.range || "").trim();
  if (rangeHeader) {
    const matched = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
    const suffix = matched && !matched[1] && matched[2];
    if (!matched || (!matched[1] && !matched[2])) {
      res.setHeader("Content-Range", `bytes */${total}`);
      res.status(416).end();
      return;
    }
    if (suffix) {
      const length = Math.min(Number(matched[2]), total);
      start = Math.max(0, total - length);
      end = total - 1;
    } else {
      start = Number(matched[1]);
      end = matched[2] ? Math.min(Number(matched[2]), total - 1) : total - 1;
      if (start > end || start >= total) {
        res.setHeader("Content-Range", `bytes */${total}`);
        res.status(416).end();
        return;
      }
    }
    status = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  }
  // text/* 必须显式带 charset：不带的话 Chrome 按本地编码解码，中文 txt/csv 预览会整篇乱码
  const baseType = file.mime || "application/octet-stream";
  res.setHeader("Content-Type", baseType.startsWith("text/") ? `${baseType}; charset=utf-8` : baseType);
  res.setHeader("Content-Length", String(end - start + 1));
  res.status(status);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fileDriver.createReadStream(file.key, { start, end });
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).json({ message: "读取文件失败" });
    else res.destroy();
  });
  stream.pipe(res);
}

// --- 上传落库（直传与分片共用）-----------------------------------------------

function newStorageKey(ext: string) {
  const now = new Date();
  return `files/default/${String(now.getFullYear()).slice(2)}/${String(now.getMonth() + 1).padStart(2, "0")}/${randomUUID()}.${ext}`;
}

type UploadContextResult =
  | {
    ok: true;
    ownerId: string;
    teamId: string;
    order: ReturnType<typeof getStore>["orders"][number] | null;
    supplier: { id: string; company: string; ownerId: string; teamId: string; code: string } | null;
  }
  | { ok: false; status: number; message: string };

/**
 * 归属继承业务对象（订单 / 供应商），不是上传者：销售离职后文件不该变成孤儿。
 * 供应商是团队共享资产，所以按团队查（find 自带 team 过滤），并要求 supplier.update 才能加附件。
 */
async function resolveUploadContext(user: SessionUser, contextType: string, contextId: string): Promise<UploadContextResult> {
  const store = getStore();
  if (!contextType) return { ok: true, ownerId: user.id, teamId: user.teamId, order: null, supplier: null };
  if (contextType === "supplier") {
    const repository = getSupplierRepository();
    if (!repository) return { ok: false, status: 503, message: "供应商库不可用" };
    const supplier = await repository.find(user.teamId, contextId);
    if (!supplier) return { ok: false, status: 404, message: "供应商不存在或无权上传" };
    if (!hasIamPermission(user, "supplier.update")) {
      return { ok: false, status: 403, message: "没有维护该供应商的权限" };
    }
    return {
      ok: true,
      ownerId: supplier.ownerId || user.id,
      teamId: supplier.teamId || user.teamId,
      order: null,
      supplier: { id: supplier.id, company: supplier.company, ownerId: supplier.ownerId, teamId: supplier.teamId, code: supplier.code }
    };
  }
  if (contextType !== "order") return { ok: false, status: 400, message: "不支持的关联对象" };
  const order = store.orders.find((item) => item.id === contextId) || null;
  if (!order || !orderVisible(user, order)) return { ok: false, status: 404, message: "订单不存在或无权上传" };
  if (!hasIamPermission(user, "order.manage")) return { ok: false, status: 403, message: "没有维护该订单的权限" };
  return { ok: true, ownerId: order.ownerId, teamId: order.teamId, order, supplier: null };
}

/** 建文件行 + 建关联 + 写订单事件。字节已经落盘，这一步失败由调用方负责删字节。 */
async function registerUploadedFile(input: {
  repository: MysqlFileRepository;
  user: SessionUser;
  key: string;
  sha256: string;
  size: number;
  mime: string;
  originalName: string;
  clientToken: string;
  context: Extract<UploadContextResult, { ok: true }>;
  kind: string;
  /** 传了就是把这份挂到已有版本组里当新版本（M3） */
  versionGroupId?: string;
}) {
  const store = getStore();
  const scanned = previewCapabilityIssue({ mime: input.mime, originalName: input.originalName }) || undefined;
  const remark: Record<string, unknown> = input.context.order
    ? { contextType: "order", contextId: input.context.order.id, kind: input.kind, scanned }
    : input.context.supplier
      ? { contextType: "supplier", contextId: input.context.supplier.id, kind: input.kind, scanned }
      : {};
  const file = await input.repository.createFile({
    key: input.key,
    sha256: input.sha256,
    size: input.size,
    mime: input.mime,
    originalName: input.originalName,
    ownerId: input.context.ownerId,
    teamId: input.context.teamId,
    quotaOwnerId: input.user.id,
    createdBy: input.user.id,
    clientToken: input.clientToken || undefined,
    versionGroupId: input.versionGroupId,
    remark
  });
  if (input.versionGroupId) {
    // 新版本成为 current，旧版本保留可回看；已锁定的订单引用不受影响（引用指向具体文件行）
    await input.repository.setCurrentVersion(input.versionGroupId, file.id);
  }
  let referenceId = "";
  const order = input.context.order;
  if (order) {
    const reference = await input.repository.addReference({
      fileId: file.id,
      entityType: "order",
      entityId: order.id,
      kind: input.kind,
      createdBy: input.user.id
    });
    referenceId = reference.id;
    store.orderEvents.push({
      id: `orde_${order.id}_${Date.now()}_upload`,
      orderId: order.id,
      type: "file",
      content: `上传文件《${input.originalName}》`,
      operatorId: input.user.id,
      refType: "file",
      refId: file.id,
      createdAt: new Date().toISOString()
    });
    order.updatedAt = new Date().toISOString();
    await store.persist();
  }
  const supplier = input.context.supplier;
  if (supplier) {
    // 供应商是独立表（不进 persistAll），这里只补关联行，不动供应商本体字段
    const reference = await input.repository.addReference({
      fileId: file.id,
      entityType: "supplier",
      entityId: supplier.id,
      kind: input.kind,
      createdBy: input.user.id
    });
    referenceId = reference.id;
  }
  // 需要转换的格式入队：派生失败不影响下载，但预览要等它
  if (isOfficeFile(file.mime, file.originalName) || isHeicFile(file.mime, file.originalName) || file.mime === "application/pdf" || file.mime.startsWith("image/")) {
    deriveQueue.enqueue(file.id);
  }
  return { file, referenceId };
}

// --- 分片上传：弱网/展会现场续传 ---------------------------------------------

function uploadSessionView(session: {
  id: string;
  originalName: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  received: number[];
  status: string;
  fileId: string;
  contextType: string;
  contextId: string;
  kind: string;
  expiresAt: string;
}) {
  return {
    id: session.id,
    name: session.originalName,
    size: session.size,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    received: session.received,
    status: session.status,
    fileId: session.fileId,
    contextType: session.contextType,
    contextId: session.contextId,
    kind: session.kind,
    expiresAt: session.expiresAt
  };
}

// ---------------------------------------------------------------------------
// M4：台账 / 批量 / 审计 / 合规保留 / 转归属
// ---------------------------------------------------------------------------

type FileActor = Parameters<typeof loadAccessibleFile>[0];

/** 把单个文件移入回收站；批量与单条共用，避免两套判定漂移 */
async function recycleFileFor(user: FileActor, fileId: string, reason: string) {
  const loaded = await loadAccessibleFile(user, fileId, "manage");
  if (!loaded.ok) return { ok: false, id: fileId, message: loaded.error.message };
  if (loaded.file.legalHold) return { ok: false, id: fileId, message: "处于合规保留期，不能删除" };
  const changed = await loaded.repository.recycle(loaded.file.id, user.id, reason);
  if (!changed) return { ok: false, id: fileId, message: "文件状态已变化，请刷新后重试" };
  await loaded.repository.logAccess({ fileId, userId: user.id, action: "recycle" });
  return { ok: true, id: fileId, message: "" };
}

async function restoreFileFor(user: FileActor, fileId: string) {
  const loaded = await loadAccessibleFile(user, fileId, "manage");
  if (!loaded.ok) return { ok: false, id: fileId, message: loaded.error.message };
  const changed = await loaded.repository.restore(loaded.file.id);
  if (!changed) return { ok: false, id: fileId, message: "文件不在回收站里" };
  await loaded.repository.logAccess({ fileId, userId: user.id, action: "restore" });
  return { ok: true, id: fileId, message: "" };
}

async function purgeFileFor(user: FileActor, fileId: string) {
  const loaded = await loadAccessibleFile(user, fileId, "manage");
  if (!loaded.ok) return { ok: false, id: fileId, message: loaded.error.message };
  if (loaded.file.legalHold) return { ok: false, id: fileId, message: "处于合规保留期，不能删除" };
  const references = await loaded.repository.countReferences(loaded.file.id);
  if (references > 0) return { ok: false, id: fileId, message: `还有 ${references} 处引用` };
  if (loaded.file.status !== "recycled") return { ok: false, id: fileId, message: "请先移入回收站" };
  await loaded.repository.deleteRow(loaded.file.id);
  const derivativeKeys = await loaded.repository.deleteDerivatives(loaded.file.id);
  for (const key of derivativeKeys) {
    await fileDriver.remove(key).catch(() => undefined);
    await fileDriver.removeEmptyParent(key);
  }
  const remaining = await loaded.repository.countByKey(loaded.file.key);
  if (remaining === 0) {
    await fileDriver.remove(loaded.file.key).catch(() => undefined);
    // 派生件目录整目录清掉：DB 可能漏登记（派生写盘与本次删除是并发路径）
    await fileDriver.removeDerivativeDir(loaded.file.key).catch(() => undefined);
  }
  await loaded.repository.logAccess({ fileId, userId: user.id, action: "purge" });
  return { ok: true, id: fileId, message: "" };
}

// ---------------------------------------------------------------------------
// M3：分享链接 / 水印 / 版本
// ---------------------------------------------------------------------------

function shareBaseUrl(req: express.Request) {
  const configured = String(process.env.GOODJOB_PUBLIC_BASE_URL || "").trim().replace(/\/+$/u, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host") || "127.0.0.1"}`;
}

function shareClientView(share: { id: string; token: string; fileId: string; mode: string; expiresAt: string; maxViews: number; viewCount: number; watermarkText: string; revokedAt: string; createdAt: string; passwordHash: string }, base: string) {
  return {
    id: share.id,
    fileId: share.fileId,
    mode: share.mode,
    url: `${base}/api/share/${share.token}`,
    expiresAt: share.expiresAt,
    maxViews: share.maxViews,
    viewCount: share.viewCount,
    remainingViews: share.maxViews > 0 ? Math.max(0, share.maxViews - share.viewCount) : 0,
    watermarkText: share.watermarkText,
    hasPassword: Boolean(share.passwordHash),
    revokedAt: share.revokedAt,
    createdAt: share.createdAt
  };
}

// ---------------------------------------------------------------------------
// M3 公开分享（无账号访问）
//
// 这是全项目唯一「不要求登录」的文件出口，所以每一层都要自己判：
// 撤销/过期/次数/密码/文件是否还在。少判一层就是裸奔。
// ---------------------------------------------------------------------------

function readRequestCookie(req: { headers: { cookie?: string } }, name: string) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

/** 带水印的 PDF 缓存：同一份文件同一段水印不重复生成（pdf-lib 一次几百毫秒） */
const shareWatermarkCache = new Map<string, Buffer>();

const SHARE_WATERMARK_CACHE_MAX = 24;

async function watermarkedPdfBytes(file: StoredFile, text: string) {
  const cacheKey = `${file.id}|${file.sha256}|${text}`;
  const hit = shareWatermarkCache.get(cacheKey);
  if (hit) return hit;
  const raw = await fileDriver.read(file.key);
  const out = await watermarkPdf(raw, text);
  if (shareWatermarkCache.size >= SHARE_WATERMARK_CACHE_MAX) {
    const oldest = shareWatermarkCache.keys().next().value;
    if (oldest) shareWatermarkCache.delete(oldest);
  }
  shareWatermarkCache.set(cacheKey, out);
  return out;
}

async function resolveShareTarget(token: string) {
  const repository = getFileRepository();
  if (!repository) return { ok: false as const, status: 503, text: "文件存储未就绪" };
  const share = await repository.findShareByToken(token);
  if (!share) return { ok: false as const, status: 404, text: "分享链接不存在" };
  const blocked = shareBlockReason(share);
  if (blocked) return { ok: false as const, status: 410, text: SHARE_BLOCK_TEXT[blocked], share, repository };
  const file = await repository.findFile(share.fileId);
  if (!file || file.status !== "active") {
    return { ok: false as const, status: 410, text: "文件已被删除或移入回收站", share, repository };
  }
  return { ok: true as const, share, file, repository };
}

export function registerFilesRoutes(app: Express) {
  app.post("/api/files", express.raw({ type: "application/octet-stream", limit: FILE_MAX_BYTES }), asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    let rawName = "";
    try {
      rawName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
    } catch {
      res.status(400).json({ message: "文件名编码无效" });
      return;
    }
    const originalName = sanitizeOriginalName(rawName);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) {
      res.status(400).json({ message: "文件内容为空，请重新选择" });
      return;
    }
    if (buffer.length > FILE_MAX_BYTES) {
      res.status(413).json({ message: "单个文件不能超过 100MB" });
      return;
    }
    const sniffed = sniffFileType(buffer, originalName);
    if (!sniffed) {
      res.status(415).json({ message: "不支持该文件类型；可上传 PDF、Office 文档、图片、ZIP 或文本" });
      return;
    }

    const clientToken = String(req.headers["x-client-token"] || "").trim().slice(0, 64);
    if (clientToken) {
      const existing = await repository.findByClientToken(clientToken);
      // 弱网重试：同一个 clientToken 直接返回上次的结果，不产生第二份文件
      if (existing) {
        res.json({ file: fileClientView(existing), duplicated: true });
        return;
      }
    }

    const contextType = String(req.query.contextType || "").trim().slice(0, 16);
    const contextId = String(req.query.contextId || "").trim().slice(0, 64);
    const context = await resolveUploadContext(req.user!, contextType, contextId);
    if (!context.ok) {
      res.status(context.status).json({ message: context.message });
      return;
    }
    const kind = String(req.query.kind || "other").slice(0, 20);

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const duplicate = await repository.findBySha(sha256);
    const key = newStorageKey(sniffed.ext);
    let written: { sha256: string; size: number };
    try {
      written = await fileDriver.put(key, buffer);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOSPC" || code === "STORAGE_INCOMPLETE") {
        res.status(507).json({ message: "存储空间不足，文件未保存" });
        return;
      }
      throw error;
    }

    let file: StoredFile;
    let referenceId = "";
    try {
      const registered = await registerUploadedFile({
        repository,
        user: req.user!,
        key,
        sha256: written.sha256,
        size: written.size,
        mime: sniffed.mime,
        originalName,
        clientToken,
        context,
        kind
      });
      file = registered.file;
      referenceId = registered.referenceId;
    } catch (error) {
      // 落库失败就把刚写的字节删掉，避免盘上留下无主文件
      await fileDriver.remove(key).catch(() => undefined);
      if ((error as { code?: string }).code === "ER_DUP_ENTRY" && clientToken) {
        const existing = await repository.findByClientToken(clientToken);
        if (existing) {
          res.json({ file: fileClientView(existing), duplicated: true });
          return;
        }
      }
      throw error;
    }

    res.status(201).json({
      file: fileClientView(file),
      referenceId,
      duplicateOf: duplicate ? { id: duplicate.id, name: duplicate.originalName } : null
    });
  }));

  app.post("/api/files/uploads", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z
      .object({
        fileName: z.string().trim().min(1).max(255),
        size: z.number().int().positive().max(FILE_MAX_BYTES),
        sha256: z.string().trim().regex(/^[a-f0-9]{64}$/u).optional(),
        clientToken: z.string().trim().min(8).max(64),
        contextType: z.string().trim().max(16).optional().default(""),
        contextId: z.string().trim().max(64).optional().default(""),
        kind: z.string().trim().max(20).optional().default("other")
      })
      .safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "上传参数不完整" });
      return;
    }
    const originalName = sanitizeOriginalName(parsed.data.fileName);
    // 同一个 clientToken 复用旧会话：断网重连不该从头再传一遍
    const existing = await repository.findUploadSessionByToken(parsed.data.clientToken);
    if (existing && existing.status !== "aborted") {
      if (existing.status === "completed" && existing.fileId) {
        const file = await repository.findFile(existing.fileId);
        if (file) {
          res.json({ session: uploadSessionView(existing), file: fileClientView(file) });
          return;
        }
      }
      res.json({ session: uploadSessionView(existing) });
      return;
    }
    if ((await repository.countOpenUploadSessions(req.user!.id)) >= UPLOAD_SESSION_MAX_OPEN) {
      res.status(429).json({ message: `同时进行的上传不能超过 ${UPLOAD_SESSION_MAX_OPEN} 个，请先完成或取消其它上传` });
      return;
    }
    const context = await resolveUploadContext(req.user!, parsed.data.contextType, parsed.data.contextId);
    if (!context.ok) {
      res.status(context.status).json({ message: context.message });
      return;
    }
    const session = await repository.createUploadSession({
      clientToken: parsed.data.clientToken,
      ownerId: req.user!.id,
      teamId: req.user!.teamId,
      originalName,
      size: parsed.data.size,
      chunkSize: FILE_CHUNK_BYTES,
      contextType: parsed.data.contextType,
      contextId: parsed.data.contextId,
      kind: parsed.data.kind,
      sha256: parsed.data.sha256,
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS)
    });
    if (!session) {
      res.status(409).json({ message: "上传会话创建失败，请重试" });
      return;
    }
    res.status(201).json({ session: uploadSessionView(session) });
  }));

  app.get("/api/files/uploads/:id", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const session = await repository.findUploadSession(String(req.params.id || ""));
    if (!session) {
      res.status(404).json({ message: "上传会话不存在或已过期" });
      return;
    }
    if (session.ownerId !== req.user!.id && !fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "不能查看他人的上传会话" });
      return;
    }
    res.json({ session: uploadSessionView(session) });
  }));

  app.put(
    "/api/files/uploads/:id/chunks/:index",
    express.raw({ type: "application/octet-stream", limit: FILE_CHUNK_BYTES + 64 * 1024 }),
    asyncRoute(async (req, res) => {
      const repository = getFileRepository();
      if (!repository) {
        res.status(503).json({ message: "文件存储未就绪" });
        return;
      }
      const session = await repository.findUploadSession(String(req.params.id || ""));
      if (!session) {
        res.status(404).json({ message: "上传会话不存在或已过期" });
        return;
      }
      if (session.ownerId !== req.user!.id) {
        res.status(403).json({ message: "不能往他人的上传会话里写分片" });
        return;
      }
      if (session.status === "completed") {
        res.status(409).json({ message: "该上传已完成", fileId: session.fileId });
        return;
      }
      if (session.status !== "open") {
        res.status(409).json({ message: "上传会话已结束" });
        return;
      }
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
        res.status(416).json({ message: `分片序号超出范围（0-${session.totalChunks - 1}）` });
        return;
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buffer.length) {
        res.status(400).json({ message: "分片内容为空" });
        return;
      }
      // 除了最后一片，其它片必须刚好一片大小；否则拼出来的文件是错的
      const expected = index === session.totalChunks - 1 ? session.size - session.chunkSize * index : session.chunkSize;
      if (buffer.length > expected) {
        res.status(413).json({ message: "分片比声明的尺寸大，请检查分片逻辑" });
        return;
      }
      await fileDriver.saveChunk(session.id, index, buffer);
      const received = await repository.touchUploadSession(session.id, [...session.received, index]);
      res.json({ received, totalChunks: session.totalChunks });
    })
  );

  app.post("/api/files/uploads/:id/complete", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const session = await repository.findUploadSession(String(req.params.id || ""));
    if (!session) {
      res.status(404).json({ message: "上传会话不存在或已过期" });
      return;
    }
    if (session.ownerId !== req.user!.id) {
      res.status(403).json({ message: "不能完成他人的上传" });
      return;
    }
    if (session.status === "completed") {
      const file = session.fileId ? await repository.findFile(session.fileId) : null;
      if (file) {
        res.json({ file: fileClientView(file), duplicated: true, referenceId: "" });
        return;
      }
    }
    if (session.status !== "open") {
      res.status(409).json({ message: "上传会话已结束，请重新上传" });
      return;
    }
    const chunks = await fileDriver.listChunks(session.id);
    const missing: number[] = [];
    for (let index = 0; index < session.totalChunks; index += 1) {
      if (!chunks.includes(index)) missing.push(index);
    }
    if (missing.length) {
      res.status(409).json({ message: `还有 ${missing.length} 个分片没到`, missing, received: chunks });
      return;
    }
    // 先把第一片当头部嗅探类型：分片本身没有扩展名信息，靠魔数定
    const head = await fileDriver.read(`tmp/uploads/${session.id}/00000.part`);
    const sniffed = head ? sniffFileType(head.subarray(0, Math.min(head.length, 4096)), session.originalName) : null;
    if (!sniffed) {
      await fileDriver.discardChunks(session.id).catch(() => undefined);
      await repository.abortUploadSession(session.id);
      res.status(415).json({ message: "不支持该文件类型；可上传 PDF、Office 文档、图片、ZIP 或文本" });
      return;
    }
    const context = await resolveUploadContext(req.user!, session.contextType, session.contextId);
    if (!context.ok) {
      res.status(context.status).json({ message: context.message });
      return;
    }
    const key = newStorageKey(sniffed.ext);
    let assembled: { sha256: string; size: number };
    try {
      assembled = await fileDriver.assembleChunks(session.id, session.totalChunks, key);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOSPC") {
        res.status(507).json({ message: "存储空间不足，文件未保存" });
        return;
      }
      throw error;
    }
    if (assembled.size !== session.size || (session.sha256 && session.sha256 !== assembled.sha256)) {
      // 分片都到齐了对不上：不是缺片就是传坏了，删掉让它重传（片留着也没意义）
      await fileDriver.remove(key).catch(() => undefined);
      await fileDriver.discardChunks(session.id).catch(() => undefined);
      await repository.touchUploadSession(session.id, []);
      res.status(422).json({
        message:
          assembled.size !== session.size
            ? `拼装后大小 ${assembled.size} 与声明的 ${session.size} 不一致，请重新上传`
            : "文件校验失败（sha256 不一致），请重新上传",
        missing: []
      });
      return;
    }
    let file: StoredFile;
    let referenceId = "";
    try {
      const registered = await registerUploadedFile({
        repository,
        user: req.user!,
        key,
        sha256: assembled.sha256,
        size: assembled.size,
        mime: sniffed.mime,
        originalName: session.originalName,
        clientToken: session.clientToken,
        context,
        kind: session.kind
      });
      file = registered.file;
      referenceId = registered.referenceId;
    } catch (error) {
      await fileDriver.remove(key).catch(() => undefined);
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        const existing = await repository.findByClientToken(session.clientToken);
        if (existing) {
          await repository.finishUploadSession(session.id, existing.id);
          await fileDriver.discardChunks(session.id).catch(() => undefined);
          res.json({ file: fileClientView(existing), duplicated: true, referenceId: "" });
          return;
        }
      }
      throw error;
    }
    await repository.finishUploadSession(session.id, file.id);
    await fileDriver.discardChunks(session.id).catch(() => undefined);
    res.status(201).json({ file: fileClientView(file), referenceId, duplicated: false });
  }));

  app.delete("/api/files/uploads/:id", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const session = await repository.findUploadSession(String(req.params.id || ""));
    if (!session) {
      res.status(404).json({ message: "上传会话不存在或已过期" });
      return;
    }
    if (session.ownerId !== req.user!.id && !fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "不能取消他人的上传" });
      return;
    }
    if (session.status === "completed") {
      res.status(409).json({ message: "该上传已完成，不能取消" });
      return;
    }
    await repository.abortUploadSession(session.id);
    await fileDriver.discardChunks(session.id).catch(() => undefined);
    res.json({ ok: true });
  }));

  /** 重试转换：manage 权限。真正的执行进队列，不在这里同步跑（60s 转换不该占着 HTTP 连接） */
  app.post("/api/files/:id/derive", asyncRoute(async (req, res) => {
    const loaded = await loadAccessibleFile(req.user!, String(req.params.id || ""), "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const caps = probeDeriveCapabilities();
    await loaded.repository.markDeriveStatus(loaded.file.id, "processing");
    retryDerivation(loaded.file.id);
    res.json({
      ok: true,
      queued: true,
      capabilities: caps,
      issue: previewCapabilityIssue(loaded.file)
    });
  }));

  app.get("/api/files/:id/meta", asyncRoute(async (req, res) => {
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "preview");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const derivatives = await loaded.repository.derivativesFor(loaded.file.id);
    res.json({
      file: fileClientView(loaded.file),
      canManage: loaded.decision.canManage,
      derivatives: derivatives.map((item) => ({
        kind: item.kind,
        status: item.status,
        error: item.error,
        // 只给「能不能看」，不外泄存储 key
        available: item.status === "ready" && Boolean(item.storageKey)
      })),
      previewIssue: previewCapabilityIssue(loaded.file),
      references: loaded.references.map((reference) => ({
        id: reference.id,
        entityType: reference.entityType,
        entityId: reference.entityId,
        kind: reference.kind
      }))
    });
  }));

  app.get("/api/files/:id/preview", asyncRoute(async (req, res) => {
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "preview");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const file = loaded.file;
    // HEIC 浏览器不认，Office 浏览器也不认：这两种必须走派生件。
    // 注意 HEIC 的 mime 是 image/*，会骗过 isPreviewable，所以要先判。
    const deriveKind = isOfficeFile(file.mime, file.originalName)
      ? "preview_pdf"
      : isHeicFile(file.mime, file.originalName)
        ? "image_jpg"
        : null;
    let target: StoredFile = file;
    if (deriveKind) {
      const derivative = await loaded.repository.findDerivative(file.id, deriveKind);
      if (derivative?.status === "ready" && derivative.storageKey) {
        target = {
          ...file,
          key: derivative.storageKey,
          mime: deriveKind === "preview_pdf" ? "application/pdf" : "image/jpeg",
          originalName: file.originalName.replace(/\.[a-z0-9]{1,8}$/iu, "") + (deriveKind === "preview_pdf" ? ".pdf" : ".jpg"),
          // ETag 必须跟着派生件走，否则原文件没变、派生件重生成后浏览器还拿旧缓存
          sha256: derivative.id
        };
      } else if (derivative?.status === "failed" || (file.deriveStatus === "failed" && derivative?.status !== "processing")) {
        res.status(409).json({
          status: "failed",
          message: derivative?.error || file.deriveError || "转换失败，可下载原文件查看",
          canRetry: loaded.decision.canManage
        });
        return;
      } else {
        // 没转换过 / 正在排队：这里顺手入队，避免「没人点重试就永远不转」
        deriveQueue.enqueue(file.id);
        res.status(425).json({
          status: "processing",
          message: "文件正在转换为可预览格式，请稍候",
          capabilities: probeDeriveCapabilities()
        });
        return;
      }
    } else if (!isPreviewable(file.mime)) {
      res.status(415).json({ message: "该格式暂不支持在线预览，请下载后查看" });
      return;
    }
    await loaded.repository.logAccess({
      fileId: file.id,
      userId: req.user!.id,
      action: "preview",
      ip: req.ip || "",
      userAgent: String(req.headers["user-agent"] || ""),
      requestId: String(req.headers["x-request-id"] || "")
    });
    res.setHeader("Content-Disposition", contentDisposition(target.originalName, true));
    // 预览也要防嵌入式脚本执行
    res.setHeader("Content-Security-Policy", "sandbox");
    await sendStoredFile(req, res, target);
  }));

  app.get("/api/files/:id/raw", asyncRoute(async (req, res) => {
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "raw");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    await loaded.repository.logAccess({
      fileId: loaded.file.id,
      userId: req.user!.id,
      action: "raw",
      ip: req.ip || "",
      userAgent: String(req.headers["user-agent"] || ""),
      requestId: String(req.headers["x-request-id"] || "")
    });
    res.setHeader("Content-Disposition", contentDisposition(loaded.file.originalName, false));
    await sendStoredFile(req, res, loaded.file);
  }));

  app.post("/api/files/:id/recycle", asyncRoute(async (req, res) => {
    const parsed = z.object({ reason: z.string().trim().max(40).optional().default("") }).safeParse(req.body || {});
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    if (loaded.file.legalHold) {
      res.status(423).json({ message: "该文件处于合规保留期，不能删除" });
      return;
    }
    const ok = await loaded.repository.recycle(loaded.file.id, req.user!.id, parsed.success ? parsed.data.reason : "");
    if (!ok) {
      res.status(409).json({ message: "文件状态已变化，请刷新后重试" });
      return;
    }
    res.json({ ok: true });
  }));

  app.post("/api/files/:id/restore", asyncRoute(async (req, res) => {
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const ok = await loaded.repository.restore(loaded.file.id);
    if (!ok) {
      res.status(409).json({ message: "文件不在回收站里" });
      return;
    }
    res.json({ ok: true });
  }));

  app.delete("/api/files/:id", asyncRoute(async (req, res) => {
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    if (loaded.file.legalHold) {
      res.status(423).json({ message: "该文件处于合规保留期，不能删除" });
      return;
    }
    const referenceCount = await loaded.repository.countReferences(loaded.file.id);
    if (referenceCount > 0) {
      res.status(409).json({ message: `还有 ${referenceCount} 处引用，请先解除关联` });
      return;
    }
    if (loaded.file.status !== "recycled") {
      res.status(409).json({ message: "请先把文件移入回收站，再彻底删除" });
      return;
    }
    await loaded.repository.deleteRow(loaded.file.id);
    // 派生件也是文件内容的一部分：只删本体等于把预览用的 PDF/缩略图留在盘上
    const derivativeKeys = await loaded.repository.deleteDerivatives(loaded.file.id);
    for (const key of derivativeKeys) {
      await fileDriver.remove(key).catch(() => undefined);
      // 顺手把空的 <key>.deriv 目录收掉，否则删一万个文件留一万个空目录
      await fileDriver.removeEmptyParent(key);
    }
    // 同一个物理 key 可能被多行复用（内容去重）：只有最后一行删掉才删字节
    const remaining = await loaded.repository.countByKey(loaded.file.key);
    if (remaining === 0) {
      await fileDriver.remove(loaded.file.key).catch(() => undefined);
      // 派生件目录整目录清掉：DB 可能漏登记（派生写盘与本次删除是并发路径）
      await fileDriver.removeDerivativeDir(loaded.file.key).catch(() => undefined);
    }
    await loaded.repository.logAccess({ fileId: loaded.file.id, userId: req.user!.id, action: "purge", ip: req.ip || "" });
    res.json({ ok: true });
  }));

  app.get("/api/files/ledger", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const admin = fileIsAdmin(req.user!);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await repository.ledger({ ownerId: admin ? undefined : req.user!.id, limit, offset });
    const store = getStore();
    res.json({
      scope: admin ? "all" : "self",
      total: rows.length,
      items: rows.map((file) => ({
        id: file.id,
        name: file.originalName,
        size: file.size,
        mime: file.mime,
        createdAt: file.createdAt,
        ownerId: file.ownerId,
        ownerName: store.users.find((user) => user.id === file.ownerId)?.name || "",
        remark: file.remark,
        status: file.status,
        legalHold: file.legalHold
      }))
    });
  }));

  app.get("/api/storage/dashboard", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const admin = fileIsAdmin(req.user!);
    const summary = await repository.dashboard(admin ? undefined : req.user!.id);
    const root = fileDriver.getRoot();
    let disk: { total: number; free: number } | null = null;
    try {
      const info = await statfs(root);
      disk = { total: Number(info.blocks) * Number(info.bsize), free: Number(info.bavail) * Number(info.bsize) };
    } catch {
      disk = null;
    }
    const settings = await repository.listSettings();
    res.json({
      scope: admin ? "all" : "self",
      summary,
      disk,
      root,
      // 转换组件与队列健康：管理员一眼看出「Office 预览为什么全失败」
      derive: { ...deriveQueue.status(), timeoutMs: 60_000 },
      autoPurgeEnabled: String(settings.auto_purge_enabled || "0") === "1"
    });
  }));

  app.post("/api/storage/settings", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z.object({
      autoPurgeEnabled: z.boolean().optional(),
      rootUri: z.string().trim().max(500).optional()
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "存储设置参数不合法" });
      return;
    }
    if (parsed.data.rootUri) {
      const target = path.resolve(parsed.data.rootUri);
      if (!path.isAbsolute(target)) {
        res.status(400).json({ message: "存储根目录必须是绝对路径" });
        return;
      }
      try {
        await mkdir(target, { recursive: true });
        await stat(target);
      } catch {
        res.status(400).json({ message: "存储根目录不可写" });
        return;
      }
      // 只改配置不动存量：读取时会先查新根，再回落到 legacy_root_uri（M1 暂未做搬迁）
      await repository.setSetting("legacy_root_uri", await repository.getSetting("root_uri"));
      await repository.setSetting("root_uri", target);
    }
    if (parsed.data.autoPurgeEnabled !== undefined) {
      await repository.setSetting("auto_purge_enabled", parsed.data.autoPurgeEnabled ? "1" : "0");
    }
    res.json({ settings: await repository.listSettings() });
  }));

  app.get("/api/files", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const user = req.user!;
    const status = String(req.query.status || "active") as "active" | "recycled" | "all";
    const page = await repository.queryFiles({
      scope: { userId: user.id, teamId: user.teamId, isAdmin: fileIsAdmin(user) },
      status: ["active", "recycled", "all"].includes(status) ? status : "active",
      ownerId: String(req.query.ownerId || "").trim() || undefined,
      entityType: String(req.query.entityType || "").trim() || undefined,
      entityId: String(req.query.entityId || "").trim() || undefined,
      q: String(req.query.q || "").trim() || undefined,
      onlyOrphans: String(req.query.orphans || "") === "1",
      deriveFailed: String(req.query.deriveFailed || "") === "1",
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0
    });
    const store = getStore();
    res.json({
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      items: page.items.map((file) => ({
        ...fileClientView(file),
        ownerName: store.users.find((item) => item.id === file.ownerId)?.name || "",
        referenceCount: (file as StoredFile & { referenceCount?: number }).referenceCount ?? 0,
        isCurrent: file.isCurrent,
        versionGroupId: file.versionGroupId
      }))
    });
  }));

  app.post("/api/files/batch", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z.object({
      action: z.enum(["recycle", "restore", "delete", "hold", "unhold"]),
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
      reason: z.string().trim().max(40).optional().default("")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "批量参数不合法（一次最多 50 个文件）" });
      return;
    }
    const ids = [...new Set(parsed.data.ids)];
    if (parsed.data.action === "hold" || parsed.data.action === "unhold") {
      if (!fileIsAdmin(req.user!)) {
        res.status(403).json({ message: "只有管理员能设置合规保留" });
        return;
      }
      let okCount = 0;
      for (const id of ids) {
        const loaded = await loadAccessibleFile(req.user!, id, "manage");
        if (!loaded.ok) continue;
        await loaded.repository.setLegalHold(loaded.file.id, parsed.data.action === "hold");
        await loaded.repository.logAccess({ fileId: id, userId: req.user!.id, action: parsed.data.action });
        okCount += 1;
      }
      res.json({ okCount, failCount: ids.length - okCount, results: [] });
      return;
    }

    // 先全部预检：宁可一条都不做，也不要「50 条里成功 37 条」这种半截状态
    const precheck = await Promise.all(ids.map(async (id) => {
      const loaded = await loadAccessibleFile(req.user!, id, "manage");
      if (!loaded.ok) return { id, ok: false, message: loaded.error.message };
      if (parsed.data.action !== "restore" && loaded.file.legalHold) {
        return { id, ok: false, message: "处于合规保留期" };
      }
      if (parsed.data.action === "delete") {
        if (loaded.file.status !== "recycled") return { id, ok: false, message: "请先移入回收站" };
        const references = await loaded.repository.countReferences(loaded.file.id);
        if (references > 0) return { id, ok: false, message: `还有 ${references} 处引用` };
      }
      return { id, ok: true, message: "" };
    }));
    const blocked = precheck.filter((item) => !item.ok);
    if (blocked.length) {
      res.status(409).json({
        message: `有 ${blocked.length} 个文件不能${parsed.data.action === "delete" ? "彻底删除" : "操作"}，本次没有执行任何操作`,
        results: blocked
      });
      return;
    }

    const results: Array<{ id: string; ok: boolean; message: string }> = [];
    for (const id of ids) {
      try {
        if (parsed.data.action === "recycle") results.push(await recycleFileFor(req.user!, id, parsed.data.reason));
        else if (parsed.data.action === "restore") results.push(await restoreFileFor(req.user!, id));
        else results.push(await purgeFileFor(req.user!, id));
      } catch (error) {
        results.push({ id, ok: false, message: (error as Error).message || "操作失败" });
      }
    }
    res.json({
      okCount: results.filter((item) => item.ok).length,
      failCount: results.filter((item) => !item.ok).length,
      results
    });
  }));

  app.get("/api/files/audit", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    if (!fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "只有管理员能查看全量访问日志" });
      return;
    }
    const page = await repository.accessLogs({
      fileId: String(req.query.fileId || "").trim() || undefined,
      userId: String(req.query.userId || "").trim() || undefined,
      action: String(req.query.action || "").trim() || undefined,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0
    });
    const store = getStore();
    const names = await repository.namesByIds(page.items.map((log) => log.fileId).filter(Boolean) as string[]);
    res.json({
      total: page.total,
      items: page.items.map((log) => ({
        ...log,
        userName: store.users.find((user) => user.id === log.userId)?.name || "",
        // 文件已被彻底删除时 names 里没有，前端回退显示 id
        fileName: log.fileId ? names.get(log.fileId) || "" : ""
      }))
    });
  }));

  app.post("/api/files/:id/hold", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    if (!fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "只有管理员能设置合规保留" });
      return;
    }
    const parsed = z.object({
      hold: z.boolean(),
      retainUntil: z.string().trim().max(20).optional().default("")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "参数不合法" });
      return;
    }
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const until = parsed.data.retainUntil ? new Date(parsed.data.retainUntil) : null;
    await loaded.repository.setLegalHold(loaded.file.id, parsed.data.hold, until && !Number.isNaN(until.getTime()) ? until : null);
    await loaded.repository.logAccess({ fileId: loaded.file.id, userId: req.user!.id, action: parsed.data.hold ? "hold" : "unhold" });
    res.json({ ok: true, legalHold: parsed.data.hold, retainUntil: until ? until.toISOString() : "" });
  }));

  app.post("/api/files/transfer-owner", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    if (!fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "只有管理员能转移文件归属" });
      return;
    }
    const parsed = z.object({
      fromUserId: z.string().trim().min(1).max(64),
      toUserId: z.string().trim().min(1).max(64)
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "参数不合法" });
      return;
    }
    const store = getStore();
    const target = store.users.find((user) => user.id === parsed.data.toUserId);
    if (!target) {
      res.status(404).json({ message: "接收人不存在" });
      return;
    }
    if (target.status === "disabled") {
      res.status(400).json({ message: "接收人已停用，文件会再次变成孤儿" });
      return;
    }
    const moved = await repository.transferOwner(parsed.data.fromUserId, target.id, target.teamId || "");
    res.json({ ok: true, moved });
  }));

  app.post("/api/files/:id/shares", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z.object({
      mode: z.enum(["preview", "download"]).default("preview"),
      expiresInHours: z.number().int().min(1).max(24 * 90).optional(),
      maxViews: z.number().int().min(0).max(10000).optional(),
      password: z.string().trim().max(64).optional().default(""),
      watermarkText: z.string().trim().max(120).optional().default("")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "分享参数不合法" });
      return;
    }
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    if (loaded.file.status !== "active") {
      res.status(409).json({ message: "回收站里的文件不能分享" });
      return;
    }
    if (loaded.file.legalHold && parsed.data.mode === "download") {
      res.status(423).json({ message: "处于合规保留期，只能分享预览（带水印）" });
      return;
    }
    const expiresAt = parsed.data.expiresInHours
      ? new Date(Date.now() + parsed.data.expiresInHours * 3600 * 1000)
      : null;
    const watermark = parsed.data.watermarkText || buildWatermarkText({
      customerName: String(loaded.file.remark?.customerName || "") || undefined,
      token: "share"
    });
    const share = await repository.createShare({
      fileId: loaded.file.id,
      token: createShareToken(),
      createdBy: req.user!.id,
      teamId: req.user!.teamId || "",
      mode: parsed.data.mode,
      passwordHash: parsed.data.password ? hashSharePassword(parsed.data.password) : "",
      expiresAt,
      maxViews: parsed.data.maxViews || 0,
      watermarkText: watermark
    });
    await repository.logAccess({ fileId: loaded.file.id, userId: req.user!.id, action: "share" });
    res.status(201).json({ share: shareClientView(share, shareBaseUrl(req)) });
  }));

  app.get("/api/files/:id/shares", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const base = shareBaseUrl(req);
    const shares = await repository.listShares(loaded.file.id);
    res.json({ items: shares.map((share) => shareClientView(share, base)) });
  }));

  // 注意：这两个路由不在 `/api/files` 前缀下，不能靠那个中间件鉴权，
  // 必须各自显式挂 requireAuth —— 否则 req.user 是 undefined，撤销分享会 500，
  // 而且等于把「谁把文件分享出去了」的清单公开给未登录访问。
  app.get("/api/shares", requireAuth, asyncRoute(async (req, res, next) => {
    await enforceIamTenantPermission(req, res, next, "training.read");
  }), asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const base = shareBaseUrl(req);
    const shares = await repository.listSharesInScope(
      { userId: req.user!.id, teamId: req.user!.teamId || "", isAdmin: fileIsAdmin(req.user!) },
      200
    );
    res.json({ items: shares.map((share) => ({ ...shareClientView(share, base), fileName: share.fileName, mime: share.mime })) });
  }));

  app.delete("/api/share-links/:id", requireAuth, asyncRoute(async (req, res, next) => {
    await enforceIamTenantPermission(req, res, next, "document.manage");
  }), asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const share = await repository.findShareById(req.params.id);
    if (!share) {
      res.status(404).json({ message: "分享链接不存在" });
      return;
    }
    const owner = await loadAccessibleFile(req.user!, share.fileId, "manage");
    if (!owner.ok && share.createdBy !== req.user!.id) {
      res.status(403).json({ message: "没有撤销该分享的权限" });
      return;
    }
    await repository.revokeShare(share.id);
    await repository.logAccess({ fileId: share.fileId, userId: req.user!.id, action: "unshare" });
    res.json({ ok: true });
  }));

  app.get("/api/files/:id/versions", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "preview");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const versions = await repository.versionsOf(loaded.file.versionGroupId || loaded.file.id);
    res.json({
      currentId: versions.find((item) => item.isCurrent)?.id || loaded.file.id,
      items: versions.map((file) => ({
        id: file.id,
        name: file.originalName,
        size: file.size,
        mime: file.mime,
        isCurrent: file.isCurrent,
        createdAt: file.createdAt,
        createdBy: file.createdBy,
        deriveStatus: file.deriveStatus,
        status: file.status
      }))
    });
  }));

  app.post("/api/files/:id/versions", express.raw({ type: "application/octet-stream", limit: FILE_MAX_BYTES }), asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    let rawName = "";
    try {
      rawName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
    } catch {
      res.status(400).json({ message: "文件名编码无效" });
      return;
    }
    const originalName = sanitizeOriginalName(rawName || loaded.file.originalName);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) {
      res.status(400).json({ message: "文件内容为空" });
      return;
    }
    const sniffed = sniffFileType(buffer, originalName);
    if (!sniffed) {
      res.status(415).json({ message: "不支持该文件类型" });
      return;
    }
    const key = newStorageKey(sniffed.ext);
    const written = await fileDriver.put(key, buffer).catch(async (error) => {
      if ((error as { code?: string }).code === "ENOSPC") throw error;
      throw error;
    });
    let file: StoredFile;
    try {
      file = await repository.createFile({
        key,
        sha256: written.sha256,
        size: written.size,
        mime: sniffed.mime,
        originalName,
        ownerId: loaded.file.ownerId,
        teamId: loaded.file.teamId,
        quotaOwnerId: loaded.file.quotaOwnerId || req.user!.id,
        createdBy: req.user!.id,
        versionGroupId: loaded.file.versionGroupId || loaded.file.id,
        remark: loaded.file.remark
      });
    } catch (error) {
      await fileDriver.remove(key).catch(() => undefined);
      throw error;
    }
    await repository.setCurrentVersion(loaded.file.versionGroupId || loaded.file.id, file.id);
    await repository.logAccess({ fileId: file.id, userId: req.user!.id, action: "version" });
    if (isOfficeFile(file.mime, file.originalName) || isHeicFile(file.mime, file.originalName) || file.mime === "application/pdf" || file.mime.startsWith("image/")) {
      deriveQueue.enqueue(file.id);
    }
    res.status(201).json({
      file: fileClientView(file),
      // 引用不会自动跟着新版走：正在用的订单不该因为「传了个新 PI」就换了单证
      note: "新版本已上传并设为当前；要让已关联的订单改用新版，请点「改用此版本」。"
    });
  }));

  app.post("/api/files/:id/versions/:versionId/promote", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z.object({ migrateReferences: z.boolean().optional().default(false) }).safeParse(req.body || {});
    const loaded = await loadAccessibleFile(req.user!, req.params.id, "manage");
    if (!loaded.ok) {
      res.status(loaded.error.status).json({ message: loaded.error.message });
      return;
    }
    const groupId = loaded.file.versionGroupId || loaded.file.id;
    const target = await repository.findFile(req.params.versionId);
    if (!target || (target.versionGroupId || target.id) !== groupId) {
      res.status(404).json({ message: "版本不存在或不属于这个文件" });
      return;
    }
    // 先记下「切换前谁是当前版本」：setCurrentVersion 会把 is_current 清掉，
    // 切完再查就永远为空，引用迁移会静默变成 0 条。
    const previousCurrent = (await repository.versionsOf(groupId)).filter((item) => item.isCurrent && item.id !== target.id);
    await repository.setCurrentVersion(groupId, target.id);
    let migrated = 0;
    if (parsed.success && parsed.data.migrateReferences) {
      for (const file of previousCurrent) migrated += await repository.migrateReferences(file.id, target.id);
    }
    await repository.logAccess({ fileId: target.id, userId: req.user!.id, action: "promote" });
    res.json({ ok: true, currentId: target.id, migrated });
  }));

  // ---------------------------------------------------------------------------
  // M5：流式打包 / 合并 PDF / 完整性巡检
  // ---------------------------------------------------------------------------

  app.post("/api/files/zip", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z.object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
      name: z.string().trim().max(80).optional().default("")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "打包参数不合法（一次最多 50 个文件）" });
      return;
    }
    const entries: Array<{ name: string; size: number; open: () => ReturnType<typeof fileDriver.open> }> = [];
    const skipped: Array<{ id: string; message: string }> = [];
    for (const id of [...new Set(parsed.data.ids)]) {
      const loaded = await loadAccessibleFile(req.user!, id, "preview");
      if (!loaded.ok) {
        skipped.push({ id, message: loaded.error.message });
        continue;
      }
      const file = loaded.file;
      entries.push({ name: file.originalName, size: file.size, open: () => fileDriver.open(file.key) });
    }
    if (!entries.length) {
      res.status(404).json({ message: "没有可打包的文件", skipped });
      return;
    }
    const zipName = sanitizeOriginalName(parsed.data.name || `GoodJob-文件包-${new Date().toISOString().slice(0, 10)}.zip`);
    const finalName = zipName.toLowerCase().endsWith(".zip") ? zipName : `${zipName}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", contentDisposition(finalName, false));
    res.setHeader("X-Skipped-Count", String(skipped.length));
    const failed: string[] = [];
    const stream = buildZipStream(entries, (name, error) => failed.push(`${name}: ${error.message}`));
    stream.on("error", () => {
      // header 已经发出去了，不能再改状态码；只能断流，让客户端感知失败
      res.destroy();
    });
    res.on("close", () => {
      void repository.logAccess({
        fileId: entries.length === 1 ? parsed.data.ids[0] : "",
        userId: req.user!.id,
        action: "zip",
        ip: req.ip || ""
      });
    });
    stream.pipe(res);
  }));

  app.post("/api/files/merge-pdf", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    const parsed = z.object({
      ids: z.array(z.string().trim().min(1).max(64)).min(2).max(20),
      name: z.string().trim().max(80).optional().default("")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "合并参数不合法（需要 2–20 个 PDF，按数组顺序合并）" });
      return;
    }
    const buffers: Buffer[] = [];
    for (const id of parsed.data.ids) {
      const loaded = await loadAccessibleFile(req.user!, id, "preview");
      if (!loaded.ok) {
        res.status(loaded.error.status).json({ message: loaded.error.message });
        return;
      }
      const isPdf = loaded.file.mime === "application/pdf" || /\.pdf$/iu.test(loaded.file.originalName);
      if (!isPdf) {
        res.status(415).json({ message: `《${loaded.file.originalName}》不是 PDF，不能合并` });
        return;
      }
      buffers.push(await fileDriver.read(loaded.file.key));
    }
    let merged: Buffer;
    try {
      merged = await mergePdfs(buffers);
    } catch (error) {
      res.status(422).json({ message: (error as Error).message || "合并失败" });
      return;
    }
    const name = sanitizeOriginalName(parsed.data.name || `合并文件-${new Date().toISOString().slice(0, 10)}.pdf`);
    const finalName = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
    await repository.logAccess({ fileId: parsed.data.ids[0], userId: req.user!.id, action: "merge", ip: req.ip || "" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", contentDisposition(finalName, false));
    res.send(merged);
  }));

  app.post("/api/storage/verify", asyncRoute(async (req, res) => {
    const repository = getFileRepository();
    if (!repository) {
      res.status(503).json({ message: "文件存储未就绪" });
      return;
    }
    if (!fileIsAdmin(req.user!)) {
      res.status(403).json({ message: "只有管理员能执行完整性巡检" });
      return;
    }
    const parsed = z.object({
      limit: z.number().int().min(1).max(200).optional().default(50),
      afterId: z.string().trim().max(64).optional().default("")
    }).safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: "巡检参数不合法" });
      return;
    }
    const rows = await repository.sampleForVerify({ limit: parsed.data.limit, afterId: parsed.data.afterId });
    const problems: Array<{ id: string; name: string; problem: string }> = [];
    let checked = 0;
    for (const row of rows) {
      checked += 1;
      try {
        const info = await fileDriver.stat(row.key);
        if (!info) {
          problems.push({ id: row.id, name: row.originalName, problem: "磁盘上不存在" });
          continue;
        }
        if (Number(info.size) !== row.size) {
          problems.push({ id: row.id, name: row.originalName, problem: `大小不一致（库 ${row.size} / 盘 ${info.size}）` });
          continue;
        }
        // 20MB 以上只比大小：巡检要能随时跑完，不能把磁盘读满
        if (row.size <= 20 * 1024 * 1024 && row.sha256) {
          const bytes = await fileDriver.read(row.key);
          const actual = createHash("sha256").update(bytes).digest("hex");
          if (actual !== row.sha256) {
            problems.push({ id: row.id, name: row.originalName, problem: "内容被改动（SHA256 不一致）" });
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        problems.push({ id: row.id, name: row.originalName, problem: code === "ENOENT" ? "磁盘上不存在" : `读取失败：${(error as Error).message}` });
      }
    }
    res.json({
      checked,
      problems,
      ok: problems.length === 0,
      nextAfterId: rows.length ? rows[rows.length - 1].id : ""
    });
  }));

  app.get("/api/share/:token", asyncRoute(async (req, res) => {
    const token = String(req.params.token || "").slice(0, 64);
    const target = await resolveShareTarget(token);
    const common = { token, title: "文件分享 · GoodJob" };
    if (!target.ok) {
      res.status(target.status).type("html").send(sharePageHtml({
        ...common,
        watermark: "",
        fileName: "",
        mime: "",
        mode: "preview",
        behind: false,
        blockText: target.status === 404 ? "链接无效" : target.text
      }));
      return;
    }
    const cookie = readRequestCookie(req, shareCookieName(token));
    const unlocked = !target.share.passwordHash || shareCookieMatches(target.share, cookie);
    res.type("html").send(sharePageHtml({
      ...common,
      title: `${target.file.originalName} · GoodJob`,
      watermark: target.share.watermarkText || buildWatermarkText({ token }),
      fileName: target.file.originalName,
      mime: target.file.mime,
      mode: target.share.mode,
      behind: false,
      needsPassword: !unlocked,
      remainingViews: target.share.maxViews > 0 ? Math.max(0, target.share.maxViews - target.share.viewCount) : undefined
    }));
  }));

  app.post("/api/share/:token/unlock", express.urlencoded({ extended: false, limit: "8kb" }), asyncRoute(async (req, res) => {
    const token = String(req.params.token || "").slice(0, 64);
    const target = await resolveShareTarget(token);
    if (!target.ok) {
      res.redirect(303, `/api/share/${encodeURIComponent(token)}`);
      return;
    }
    const password = String((req.body as { password?: string })?.password || "");
    if (!verifySharePassword(password, target.share.passwordHash)) {
      res.status(401).type("html").send(sharePageHtml({
        token,
        title: "需要密码 · GoodJob",
        watermark: "",
        fileName: "",
        mime: "",
        mode: "preview",
        behind: false,
        needsPassword: true,
        passwordError: "密码不正确，请向发送方确认"
      }));
      return;
    }
    // httpOnly：前端脚本拿不到；2 小时够看完一份单证，过期要重新输密码
    res.setHeader("Set-Cookie", `${shareCookieName(token)}=${shareCookieValue(target.share)}; Path=/api/share/${token}; Max-Age=7200; HttpOnly; SameSite=Lax`);
    res.redirect(303, `/api/share/${encodeURIComponent(token)}`);
  }));

  app.get("/api/share/:token/content", asyncRoute(async (req, res) => {
    const token = String(req.params.token || "").slice(0, 64);
    const target = await resolveShareTarget(token);
    if (!target.ok) {
      res.status(target.status).json({ message: target.text });
      return;
    }
    const { share, file, repository } = target;
    if (share.passwordHash) {
      const cookie = readRequestCookie(req, shareCookieName(token));
      if (!shareCookieMatches(share, cookie)) {
        res.status(401).json({ message: "需要密码", needsPassword: true });
        return;
      }
    }
    // 先扣次数再取字节：反过来的话，并发请求都能读到文件后才扣，次数形同虚设
    if (!(await repository.consumeShareView(share.id))) {
      res.status(403).json({ message: SHARE_BLOCK_TEXT.exhausted });
      return;
    }

    const wantsDownload = share.mode === "download" && String(req.query.download || "") === "1";
    const watermark = share.watermarkText || buildWatermarkText({ token });
    const isPdf = file.mime === "application/pdf" || /\.pdf$/iu.test(file.originalName);
    const isImage = file.mime.startsWith("image/");

    let bytes: Buffer | null = null;
    let mime = file.mime;
    if (isPdf) {
      bytes = await watermarkedPdfBytes(file, watermark);
    } else if (!wantsDownload) {
      // 预览：Office 用转出来的 PDF（同样烧水印），图片给原图、水印靠页面叠层
      const preview = await repository.findDerivative(file.id, "preview_pdf");
      if (preview?.status === "ready" && preview.storageKey) {
        bytes = await watermarkedPdfBytes({ ...file, key: preview.storageKey, sha256: `${file.sha256}-pdf` }, watermark);
        mime = "application/pdf";
      } else if (isImage) {
        bytes = await fileDriver.read(file.key);
      }
    } else {
      bytes = await fileDriver.read(file.key);
    }

    if (!bytes) {
      res.status(415).json({ message: "该格式暂不支持在线查看，请联系发送方提供 PDF" });
      return;
    }
    await repository.logAccess({
      fileId: file.id,
      userId: "",
      action: wantsDownload ? "share_download" : "share_view",
      ip: req.ip || "",
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200)
    });
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", contentDisposition(file.originalName, !wantsDownload));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    if (!wantsDownload) res.setHeader("Content-Security-Policy", "sandbox");
    res.send(bytes);
  }));
}
