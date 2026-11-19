import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 文件存储层（M1）
//
// 设计约束（见 docs/FILE-STORAGE-DEV-PLAN.md）：
// - DB 只存相对 key，绝不存绝对路径；换根只改配置。
// - 字节只经 StorageDriver，业务代码不直接碰 fs。
// - 「能不能看这个文件」只有 evaluateFileAccess 一个判定口。
// - 独立表 + 独立仓库，不进 persistAll 全表重写体系（同 sender-mailbox）。
// ---------------------------------------------------------------------------

export const FILE_MAX_BYTES = 100 * 1024 * 1024;
export const FILE_PAGE_LIMIT = 100;
/** 分片大小：5MB。80MB 单证 = 16 片，弱网断了只补没到的那几片 */
export const FILE_CHUNK_BYTES = 5 * 1024 * 1024;
/** 未完成的上传会话保留 24 小时；过期由清理任务删除临时片 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 单用户同时挂起的上传会话上限，防「开一堆标签页各传一半」把盘占满 */
export const UPLOAD_SESSION_MAX_OPEN = 20;

export const FILE_STORAGE_SCHEMA_VERSION = "1.4.26-share-version-ops";

export type FileVisibility = "inherit" | "private" | "team";
export type FileStatus = "active" | "recycled";
export type FileDeriveStatus = "none" | "processing" | "ready" | "failed";

export interface StoredFile {
  id: string;
  key: string;
  tenantId: string;
  sha256: string;
  size: number;
  mime: string;
  originalName: string;
  driverGeneration: number;
  ownerId: string;
  teamId: string;
  quotaOwnerId: string;
  visibility: FileVisibility;
  tags: string[];
  remark: Record<string, unknown>;
  versionGroupId: string;
  isCurrent: boolean;
  deriveStatus: FileDeriveStatus;
  deriveError: string;
  legalHold: boolean;
  retainUntil: string;
  status: FileStatus;
  recycledAt: string;
  recycledBy: string;
  recycleReason: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileReferenceRecord {
  id: string;
  fileId: string;
  entityType: "order" | "customer" | "lead" | "kb" | "mail" | "supplier";
  entityId: string;
  kind: string;
  createdBy: string;
  createdAt: string;
}

/** 派生件种类：office → preview_pdf、heic → image_jpg、图片/PDF → thumb */
export type DeriveKind = "preview_pdf" | "image_jpg" | "thumb" | "watermarked";
export type DeriveRowStatus = "processing" | "ready" | "failed";

export interface FileDerivativeRecord {
  id: string;
  fileId: string;
  kind: DeriveKind;
  storageKey: string;
  status: DeriveRowStatus;
  error: string;
  createdAt: string;
}

/** 分享模式：preview=只让看（带水印、不给原件），download=可下载（水印烧进 PDF） */
export type ShareMode = "preview" | "download";

export interface ShareLinkRecord {
  id: string;
  token: string;
  fileId: string;
  createdBy: string;
  teamId: string;
  mode: ShareMode;
  /** 只存派生值，不存明文；空串=无密码 */
  passwordHash: string;
  expiresAt: string;
  maxViews: number;
  viewCount: number;
  watermarkText: string;
  revokedAt: string;
  createdAt: string;
}

export interface FileAccessLogRecord {
  id: number;
  fileId: string;
  userId: string;
  action: string;
  ip: string;
  userAgent: string;
  requestId: string;
  at: string;
}

export type UploadSessionStatus = "open" | "completed" | "aborted";

export interface UploadSessionRecord {
  id: string;
  clientToken: string;
  ownerId: string;
  teamId: string;
  originalName: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  received: number[];
  status: UploadSessionStatus;
  fileId: string;
  contextType: string;
  contextId: string;
  kind: string;
  sha256: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}


// ---------------------------------------------------------------------------
// 类型嗅探：按魔数认，不按扩展名（invoice.pdf.exe 必须被挡在门外）
// ---------------------------------------------------------------------------

const MAGIC_TYPES: Array<{ ext: string; mime: string; test: (buffer: Buffer) => boolean }> = [
  { ext: "pdf", mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { ext: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", test: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  { ext: "webp", mime: "image/webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "heic", mime: "image/heic", test: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && ["heic", "heix", "hevc", "mif1", "msf1"].includes(b.subarray(8, 12).toString("latin1")) },
  { ext: "zip", mime: "application/zip", test: (b) => b[0] === 0x50 && b[1] === 0x4b && [0x03, 0x05, 0x07].includes(b[2] ?? -1) }
];

/** OOXML 三种格式魔数完全一样，只能靠扩展名细分；其余按魔数认。 */
export function sniffFileType(buffer: Buffer, fileName: string): { ext: string; mime: string } | null {
  if (!buffer.length) return null;
  const declared = String(fileName || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/u)?.[1] || "";

  // OOXML（docx/xlsx/pptx）与 zip 的魔数完全一样，只能靠声明的扩展名细分；
  // 声明成非 OOXML（比如 .pdf）的 PK 文件一律记成 zip，避免「后缀是 pdf、内容是压缩包」。
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    const ooxml: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    };
    return ooxml[declared] ? { ext: declared, mime: ooxml[declared] } : { ext: "zip", mime: "application/zip" };
  }

  // OLE2 复合文档：97-2003 的 doc/xls/ppt，以及 WPS 自己的 wps/et/dps。
  // 容器本身不带类型信息，只能信声明的扩展名；不认识的声明一律返回 null，
  // 避免「改了后缀的 exe」被当成 Office 文档送进转换器。
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    const ole: Record<string, string> = {
      doc: "application/msword",
      xls: "application/vnd.ms-excel",
      ppt: "application/vnd.ms-powerpoint",
      wps: "application/x-wps",
      wpt: "application/x-wps",
      et: "application/x-wps-et",
      ett: "application/x-wps-et",
      dps: "application/x-wps-dps",
      dpt: "application/x-wps-dps"
    };
    return ole[declared] ? { ext: declared, mime: ole[declared] } : null;
  }

  for (const item of MAGIC_TYPES) {
    if (!item.test(buffer)) continue;
    return { ext: item.ext, mime: item.mime };
  }
  if (declared === "txt" || declared === "csv") {
    const text = buffer.subarray(0, Math.min(buffer.length, 2048)).toString("utf8");
    if (!/\u0000/u.test(text)) return { ext: declared, mime: declared === "csv" ? "text/csv" : "text/plain" };
  }
  return null;
}

export function isPreviewable(mime: string) {
  return mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("text/");
}

/** RFC 5987：中文文件名在 Chrome 下必须走 filename*，否则乱码成 %E4%B8... */
export function contentDisposition(originalName: string, inline = false) {
  const fallback = String(originalName || "file").replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_").slice(0, 120) || "file";
  const encoded = encodeURIComponent(String(originalName || "file")).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** 文件名清洗：Windows 非法字符、控制字符、超长（按字节截断，中文 3 字节/字） */
export function sanitizeOriginalName(value: string) {
  // Windows 路径的 \ 在 POSIX 上不算分隔符，先手动切一刀再 basename
  const leaf = String(value || "").split(/[\\/]/u).pop() || "";
  let name = path.basename(leaf).replace(/[\u0000-\u001f\u007f]/gu, "").replace(/[\\/:"*?<>|]/gu, "_").trim();
  name = name.replace(/^\.+/u, "").slice(0, 180);
  if (!name) return "file";
  while (Buffer.byteLength(name, "utf8") > 255) name = name.slice(0, -1);
  return name || "file";
}

// ---------------------------------------------------------------------------
// 权限守卫（纯函数，可单测）
// ---------------------------------------------------------------------------

export interface AccessUser {
  id: string;
  role: string;
  teamId?: string;
}

export interface ReferenceOwner {
  ownerId: string;
  teamId: string;
  label?: string;
}

export interface AccessDecision {
  ok: boolean;
  code?: 403 | 404;
  reason: string;
  /** 文件是否可见（不等于可管理） */
  visible: boolean;
  canManage: boolean;
}

export interface AccessOptions {
  isAdmin: boolean;
  /** 业务对象的可见性判定（server 侧传 canSeeOwner，测试可注入） */
  canSee: (ownerId: string, teamId: string) => boolean;
  /** 是否具备 file.manage 级别的权限（业务管理者） */
  hasManagePermission: boolean;
  action?: "preview" | "raw" | "zip" | "manage";
}

/**
 * 唯一可见性收口。
 *
 * 规则（并集）：private 仅本人；team 同团队；inherit = 引用它的业务对象中
 * 任意一个可见即可见。没有引用的文件只有上传者（管理员）能看——台账里的
 * 孤儿文件不属于任何人。
 *
 * 回收站文件对普通用户一律 404：不是「无权」，是「不存在」，避免通过 403
 * 探测别人的删除行为。
 */
export function evaluateFileAccess(
  user: AccessUser,
  file: Pick<StoredFile, "status" | "visibility" | "ownerId" | "teamId" | "createdBy" | "legalHold">,
  references: ReferenceOwner[],
  options: AccessOptions
): AccessDecision {
  const isOwner = user.id === file.ownerId || user.id === file.createdBy;
  const canManage = options.isAdmin || isOwner || options.hasManagePermission;
  const deny = (reason: string, code: 403 | 404 = 403): AccessDecision => ({ ok: false, code, reason, visible: false, canManage: false });
  const allow = (reason: string): AccessDecision => ({ ok: true, reason, visible: true, canManage });

  if (options.action === "manage") {
    return canManage ? allow("manage") : deny("没有管理这份文件的权限");
  }
  if (file.status === "recycled" && !canManage) {
    return deny("文件已进入回收站", 404);
  }
  if (options.isAdmin || isOwner) return allow("owner");
  if (file.visibility === "private") return deny("这是他人的私人文件");
  if (file.visibility === "team") {
    return user.teamId && user.teamId === file.teamId ? allow("team") : deny("不在同一团队");
  }
  const visible = references.some((reference) => options.canSee(reference.ownerId, reference.teamId));
  return visible ? allow("reference") : deny("没有可访问的关联业务");
}

// ---------------------------------------------------------------------------
// 存储驱动
// ---------------------------------------------------------------------------

export function resolveStorageRoot() {
  // 默认放仓库根目录的 storage（backend/src 与 backend/dist 都是上两级）。
  // 根目录下按 key 的首段分家：files/ 本体、将来的 derived/ 派生件，换根时整体搬走即可。
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(process.env.GOODJOB_FILE_ROOT || path.resolve(moduleDir, "..", "..", "storage"));
}

/** key 只能落在 root 之内；拒绝 .. / 绝对路径 / 软链 */
export function safeStoragePath(root: string, key: string) {
  const raw = String(key || "");
  // 绝对路径与盘符一律拒绝：调用方只该传相对 key，收下它等于把根目录判废
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(raw)) throw new Error("非法存储路径");
  const normalized = raw.replace(/\\/gu, "/").replace(/^\/+/u, "");
  if (!normalized || normalized.includes("\u0000")) throw new Error("非法存储路径");
  const target = path.resolve(root, normalized);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!target.startsWith(prefix)) throw new Error("非法存储路径");
  return target;
}

export class LocalStorageDriver {
  constructor(private readonly root = resolveStorageRoot()) {}

  getRoot() {
    return this.root;
  }

  private async ensureDir(target: string) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
  }

  /** 流式读：打包与合并必须走这个，不能把整个 zip 读进内存 */
  open(key: string) {
    return createReadStream(safeStoragePath(this.root, key));
  }

  /**
   * 落盘替换。
   * Windows 上目标文件正被下载流打开时 `rename` 会回 EPERM/EBUSY（POSIX 允许覆盖，
   * 因为已打开的是 inode 而不是路径）。派生件重生成会命中同一 key，所以必须重试几次。
   */
  private async renameInto(tmp: string, target: string) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || "";
        const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (attempt >= 3 || !retryable) {
          await fsp.rm(tmp, { force: true }).catch(() => undefined);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  }

  /** 先写临时文件再 rename，避免半截文件被当成完整文件；返回真实哈希与大小 */
  async put(key: string, buffer: Buffer) {
    const target = safeStoragePath(this.root, key);
    await this.ensureDir(target);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, buffer, { flag: "wx" });
    // 回读校验：磁盘满时 writeFile 可能只写一部分而不报错（不同内核行为不一）
    const written = await fsp.readFile(tmp);
    if (written.length !== buffer.length) {
      await fsp.rm(tmp, { force: true });
      throw Object.assign(new Error("文件写入不完整，请检查磁盘空间"), { code: "STORAGE_INCOMPLETE" });
    }
    await this.renameInto(tmp, target);
    return { sha256: createHash("sha256").update(written).digest("hex"), size: written.length };
  }

  async read(key: string) {
    return fsp.readFile(safeStoragePath(this.root, key));
  }

  async stat(key: string) {
    try {
      const target = safeStoragePath(this.root, key);
      const info = await fsp.lstat(target);
      if (info.isSymbolicLink()) throw new Error("拒绝读取软链接");
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  createReadStream(key: string, range?: { start: number; end: number }) {
    const target = safeStoragePath(this.root, key);
    return createReadStream(target, range);
  }

  async remove(key: string) {
    // maxRetries 只在 EBUSY/EPERM 这类「暂时删不掉」时生效，正是 Windows 被占用时的表现
    await fsp.rm(safeStoragePath(this.root, key), { force: true, maxRetries: 3, retryDelay: 60 });
  }

  /** 收掉派生件删完后留下的空目录；非空或不存在都当成功 */
  async removeEmptyParent(key: string) {
    const target = safeStoragePath(this.root, key);
    await fsp.rmdir(path.dirname(target)).catch(() => undefined);
  }

  /**
   * 删掉某个文件的整个派生件目录（`<key>.deriv/`）。
   *
   * 为什么不能只删 DB 里登记的 key：派生任务的写盘和「彻底删除」是两条并发路径，
   * 任务可能在 purge 之后才写完，磁盘就留下一个表里查不到的孤儿缩略图。
   */
  async removeDerivativeDir(key: string) {
    const target = `${safeStoragePath(this.root, key)}.deriv`;
    await fsp.rm(target, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // 分片上传：片只停在 tmp/ 下，未拼装成功前绝不进 files/
  // -------------------------------------------------------------------------

  private async chunkDir(uploadId: string) {
    // uploadId 来自 URL，必须收紧字符集：只要它带上 ../ 就能写到根外面
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(uploadId)) throw new Error("非法上传会话");
    const dir = safeStoragePath(this.root, `tmp/uploads/${uploadId}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  async saveChunk(uploadId: string, index: number, buffer: Buffer) {
    const dir = await this.chunkDir(uploadId);
    const target = path.join(dir, `${String(index).padStart(5, "0")}.part`);
    await fsp.writeFile(target, buffer);
    return buffer.length;
  }

  async listChunks(uploadId: string) {
    const dir = await this.chunkDir(uploadId);
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    return names
      .filter((name) => /^\d{5}\.part$/u.test(name))
      .map((name) => Number(name.slice(0, 5)))
      .sort((a, b) => a - b);
  }

  /**
   * 按序拼装并直接落到目标 key（先写 assembled.bin 再 rename，避免半截文件被当成完整文件）。
   * 边拼边算 sha256：80MB 的文件不用再读一遍。
   */
  async assembleChunks(uploadId: string, totalChunks: number, key: string) {
    const dir = await this.chunkDir(uploadId);
    const assembled = path.join(dir, "assembled.bin");
    await fsp.rm(assembled, { force: true });
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const part = path.join(dir, `${String(index).padStart(5, "0")}.part`);
        const buffer = await fsp.readFile(part);
        hash.update(buffer);
        size += buffer.length;
        await fsp.appendFile(assembled, buffer);
      }
      const target = safeStoragePath(this.root, key);
      await this.ensureDir(target);
      await this.renameInto(assembled, target);
      return { sha256: hash.digest("hex"), size };
    } catch (error) {
      await fsp.rm(assembled, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async discardChunks(uploadId: string) {
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(uploadId)) return;
    const dir = safeStoragePath(this.root, `tmp/uploads/${uploadId}`);
    await fsp.rm(dir, { recursive: true, force: true });
  }

  /** 清理过期会话留下的临时片（只扫 tmp/uploads，不碰 files/） */
  async pruneChunks(olderThanMs: number) {
    const dir = safeStoragePath(this.root, "tmp/uploads");
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(dir, entry.name);
      const stat = await fsp.stat(target).catch(() => null);
      if (stat && stat.mtimeMs >= cutoff) continue;
      await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }
}

export const fileStorageDriver = new LocalStorageDriver();

// ---------------------------------------------------------------------------
// 建表
// ---------------------------------------------------------------------------

export async function ensureFileStorageSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS files (
    id VARCHAR(64) PRIMARY KEY,
    storage_key VARCHAR(320) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
    sha256 CHAR(64) NOT NULL DEFAULT '',
    size BIGINT NOT NULL DEFAULT 0,
    mime VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
    original_name VARCHAR(255) NOT NULL DEFAULT '',
    driver_generation INT NOT NULL DEFAULT 1,
    client_token VARCHAR(64) NULL,
    owner_id VARCHAR(64) NOT NULL DEFAULT '',
    team_id VARCHAR(64) NOT NULL DEFAULT '',
    quota_owner_id VARCHAR(64) NOT NULL DEFAULT '',
    visibility VARCHAR(16) NOT NULL DEFAULT 'inherit',
    tags_json JSON NULL,
    remark_json JSON NULL,
    version_group_id VARCHAR(64) NOT NULL DEFAULT '',
    is_current TINYINT NOT NULL DEFAULT 1,
    review_status VARCHAR(16) NOT NULL DEFAULT 'none',
    legal_hold TINYINT NOT NULL DEFAULT 0,
    retain_until DATE NULL,
    derive_status VARCHAR(16) NOT NULL DEFAULT 'none',
    derive_error VARCHAR(300) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    recycled_at DATETIME(3) NULL,
    recycled_by VARCHAR(64) NOT NULL DEFAULT '',
    recycle_reason VARCHAR(40) NOT NULL DEFAULT '',
    row_version INT NOT NULL DEFAULT 0,
    created_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_files_client_token (client_token),
    INDEX idx_files_owner (owner_id),
    INDEX idx_files_team (team_id),
    INDEX idx_files_sha (sha256),
    INDEX idx_files_status (status),
    INDEX idx_files_vgroup (version_group_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS file_derivatives (
    id VARCHAR(64) PRIMARY KEY,
    file_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    storage_key VARCHAR(320) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'processing',
    error VARCHAR(300) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_file_derivative (file_id, kind),
    INDEX idx_file_derivatives_file (file_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS file_references (
    id VARCHAR(64) PRIMARY KEY,
    file_id VARCHAR(64) NOT NULL,
    entity_type VARCHAR(16) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    kind VARCHAR(30) NOT NULL DEFAULT 'other',
    pinned_file_id VARCHAR(64) NULL,
    created_by VARCHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_file_reference (file_id, entity_type, entity_id, kind),
    INDEX idx_file_references_entity (entity_type, entity_id),
    INDEX idx_file_references_file (file_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS file_access_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    file_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL DEFAULT '',
    action VARCHAR(24) NOT NULL,
    ip VARCHAR(64) NOT NULL DEFAULT '',
    user_agent VARCHAR(200) NOT NULL DEFAULT '',
    request_id VARCHAR(64) NOT NULL DEFAULT '',
    at DATETIME(3) NOT NULL,
    INDEX idx_file_access_file (file_id, at),
    INDEX idx_file_access_user (user_id, at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS share_links (
    id VARCHAR(64) PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    file_id VARCHAR(64) NOT NULL,
    created_by VARCHAR(64) NOT NULL DEFAULT '',
    team_id VARCHAR(64) NOT NULL DEFAULT '',
    mode VARCHAR(16) NOT NULL DEFAULT 'preview',
    password_hash VARCHAR(120) NOT NULL DEFAULT '',
    expires_at DATETIME(3) NULL,
    max_views INT NOT NULL DEFAULT 0,
    view_count INT NOT NULL DEFAULT 0,
    watermark_text VARCHAR(120) NOT NULL DEFAULT '',
    revoked_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_share_token (token),
    INDEX idx_share_file (file_id),
    INDEX idx_share_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS upload_sessions (
    id VARCHAR(64) PRIMARY KEY,
    client_token VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL DEFAULT '',
    team_id VARCHAR(64) NOT NULL DEFAULT '',
    original_name VARCHAR(255) NOT NULL DEFAULT '',
    size BIGINT NOT NULL DEFAULT 0,
    chunk_size INT NOT NULL DEFAULT 0,
    received_json JSON NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    expires_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_upload_client_token (client_token)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS storage_settings (
    k VARCHAR(64) PRIMARY KEY,
    v TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // 分片会话后补的列（老库上表已存在，只能 ensureColumn 补，不能改上面的 CREATE）
  await ensureFileColumn(pool, "upload_sessions", "file_id", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureFileColumn(pool, "upload_sessions", "context_type", "VARCHAR(16) NOT NULL DEFAULT ''");
  await ensureFileColumn(pool, "upload_sessions", "context_id", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureFileColumn(pool, "upload_sessions", "kind", "VARCHAR(30) NOT NULL DEFAULT 'other'");
  await ensureFileColumn(pool, "upload_sessions", "sha256", "CHAR(64) NOT NULL DEFAULT ''");
  await ensureFileColumn(pool, "upload_sessions", "total_chunks", "INT NOT NULL DEFAULT 0");
  await ensureFileColumn(pool, "upload_sessions", "updated_at", "DATETIME(3) NULL");
}

async function ensureFileColumn(pool: Pool, table: string, column: string, definition: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column]
  );
  if (Number(rows[0]?.count || 0) > 0) return;
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // 并发启动两个进程时可能同时 ALTER，1060 = 列已存在，忽略
    const code = (error as { errno?: number }).errno;
    if (code !== 1060) throw error;
  }
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------

export interface CreateFileInput {
  key: string;
  sha256: string;
  size: number;
  mime: string;
  originalName: string;
  ownerId: string;
  teamId: string;
  quotaOwnerId: string;
  createdBy: string;
  visibility?: FileVisibility;
  clientToken?: string;
  tags?: string[];
  remark?: Record<string, unknown>;
  tenantId?: string;
  versionGroupId?: string;
}

function toIso(value: unknown) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapFile(row: RowDataPacket | Record<string, unknown>): StoredFile {
  const record = row as Record<string, unknown>;
  const parseJson = <T>(value: unknown, fallback: T): T => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value as T;
    try {
      return JSON.parse(String(value)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(record.id || ""),
    key: String(record.storage_key || ""),
    tenantId: String(record.tenant_id || "default"),
    sha256: String(record.sha256 || ""),
    size: Number(record.size || 0),
    mime: String(record.mime || "application/octet-stream"),
    originalName: String(record.original_name || ""),
    driverGeneration: Number(record.driver_generation || 1),
    ownerId: String(record.owner_id || ""),
    teamId: String(record.team_id || ""),
    quotaOwnerId: String(record.quota_owner_id || ""),
    visibility: (String(record.visibility || "inherit") as FileVisibility),
    tags: parseJson<string[]>(record.tags_json, []),
    remark: parseJson<Record<string, unknown>>(record.remark_json, {}),
    versionGroupId: String(record.version_group_id || ""),
    isCurrent: Number(record.is_current ?? 1) === 1,
    deriveStatus: (String(record.derive_status || "none") as FileDeriveStatus),
    deriveError: String(record.derive_error || ""),
    legalHold: Number(record.legal_hold || 0) === 1,
    retainUntil: toIso(record.retain_until),
    status: (String(record.status || "active") as FileStatus),
    recycledAt: toIso(record.recycled_at),
    recycledBy: String(record.recycled_by || ""),
    recycleReason: String(record.recycle_reason || ""),
    createdBy: String(record.created_by || ""),
    createdAt: toIso(record.created_at),
    updatedAt: toIso(record.updated_at)
  };
}

function mapUploadSession(row: RowDataPacket | Record<string, unknown>): UploadSessionRecord {
  const record = row as Record<string, unknown>;
  let received: number[] = [];
  const raw = record.received_json;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) received = parsed.map((value) => Number(value)).filter((value) => Number.isInteger(value));
  } catch {
    received = [];
  }
  return {
    id: String(record.id || ""),
    clientToken: String(record.client_token || ""),
    ownerId: String(record.owner_id || ""),
    teamId: String(record.team_id || ""),
    originalName: String(record.original_name || ""),
    size: Number(record.size || 0),
    chunkSize: Number(record.chunk_size || 0),
    totalChunks: Number(record.total_chunks || 0),
    received,
    status: String(record.status || "open") as UploadSessionStatus,
    fileId: String(record.file_id || ""),
    contextType: String(record.context_type || ""),
    contextId: String(record.context_id || ""),
    kind: String(record.kind || "other"),
    sha256: String(record.sha256 || ""),
    expiresAt: toIso(record.expires_at),
    createdAt: toIso(record.created_at),
    updatedAt: toIso(record.updated_at)
  };
}

function mapDerivative(row: RowDataPacket | Record<string, unknown>): FileDerivativeRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id || ""),
    fileId: String(record.file_id || ""),
    kind: String(record.kind || "thumb") as DeriveKind,
    storageKey: String(record.storage_key || ""),
    status: String(record.status || "processing") as DeriveRowStatus,
    error: String(record.error || ""),
    createdAt: toIso(record.created_at)
  };
}

function mapShare(row: RowDataPacket | Record<string, unknown>): ShareLinkRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id || ""),
    token: String(record.token || ""),
    fileId: String(record.file_id || ""),
    createdBy: String(record.created_by || ""),
    teamId: String(record.team_id || ""),
    mode: (String(record.mode || "preview") as ShareMode),
    passwordHash: String(record.password_hash || ""),
    expiresAt: toIso(record.expires_at),
    maxViews: Number(record.max_views || 0),
    viewCount: Number(record.view_count || 0),
    watermarkText: String(record.watermark_text || ""),
    revokedAt: toIso(record.revoked_at),
    createdAt: toIso(record.created_at)
  };
}

function mapAccessLog(row: RowDataPacket | Record<string, unknown>): FileAccessLogRecord {
  const record = row as Record<string, unknown>;
  return {
    id: Number(record.id || 0),
    fileId: String(record.file_id || ""),
    userId: String(record.user_id || ""),
    action: String(record.action || ""),
    ip: String(record.ip || ""),
    userAgent: String(record.user_agent || ""),
    requestId: String(record.request_id || ""),
    at: toIso(record.at)
  };
}

export class MysqlFileRepository {
  constructor(private readonly pool: Pool) {}


  async createFile(input: CreateFileInput): Promise<StoredFile> {
    const now = new Date();
    const id = `file_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
    await this.pool.query(
      `INSERT INTO files (id, storage_key, tenant_id, sha256, size, mime, original_name, client_token,
        owner_id, team_id, quota_owner_id, visibility, tags_json, remark_json, version_group_id,
        status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
      [
        id, input.key, input.tenantId || "default", input.sha256, input.size, input.mime, input.originalName,
        input.clientToken || null, input.ownerId, input.teamId, input.quotaOwnerId,
        input.visibility || "inherit", JSON.stringify(input.tags || []), JSON.stringify(input.remark || {}),
        input.versionGroupId || id, input.createdBy, now, now
      ]
    );
    const created = await this.findFile(id);
    if (!created) throw new Error("文件记录写入失败");
    return created;
  }

  async findFile(id: string): Promise<StoredFile | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM files WHERE id = ? LIMIT 1", [id]);
    return rows[0] ? mapFile(rows[0]) : null;
  }

  async findByClientToken(token: string): Promise<StoredFile | null> {
    if (!token) return null;
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM files WHERE client_token = ? LIMIT 1", [token]);
    return rows[0] ? mapFile(rows[0]) : null;
  }

  async findBySha(sha256: string): Promise<StoredFile | null> {
    if (!sha256) return null;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM files WHERE sha256 = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [sha256]
    );
    return rows[0] ? mapFile(rows[0]) : null;
  }

  async countByKey(key: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM files WHERE storage_key = ?", [key]);
    return Number(rows[0]?.total || 0);
  }

  async recycle(id: string, actor: string, reason: string) {
    const [result] = await this.pool.query(
      "UPDATE files SET status='recycled', recycled_at=?, recycled_by=?, recycle_reason=?, updated_at=?, row_version=row_version+1 WHERE id=? AND status='active'",
      [new Date(), actor, reason.slice(0, 40), new Date(), id]
    );
    return Number((result as { affectedRows?: number }).affectedRows || 0) > 0;
  }

  async restore(id: string) {
    const [result] = await this.pool.query(
      "UPDATE files SET status='active', recycled_at=NULL, recycled_by='', recycle_reason='', updated_at=?, row_version=row_version+1 WHERE id=? AND status='recycled'",
      [new Date(), id]
    );
    return Number((result as { affectedRows?: number }).affectedRows || 0) > 0;
  }

  async deleteRow(id: string) {
    await this.pool.query("DELETE FROM files WHERE id = ?", [id]);
  }

  async listReferences(fileId: string): Promise<FileReferenceRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM file_references WHERE file_id = ? ORDER BY created_at ASC",
      [fileId]
    );
    return rows.map((row) => ({
      id: String(row.id),
      fileId: String(row.file_id),
      entityType: String(row.entity_type) as FileReferenceRecord["entityType"],
      entityId: String(row.entity_id),
      kind: String(row.kind || "other"),
      createdBy: String(row.created_by || ""),
      createdAt: toIso(row.created_at)
    }));
  }

  async countReferences(fileId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM file_references WHERE file_id = ?",
      [fileId]
    );
    return Number(rows[0]?.total || 0);
  }

  async addReference(input: { fileId: string; entityType: string; entityId: string; kind: string; createdBy: string }) {
    const id = `fref_${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
    try {
      await this.pool.query(
        `INSERT INTO file_references (id, file_id, entity_type, entity_id, kind, created_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [id, input.fileId, input.entityType, input.entityId, input.kind || "other", input.createdBy, new Date()]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") return { id, duplicated: true };
      throw error;
    }
    return { id, duplicated: false };
  }

  async removeReference(id: string) {
    const [result] = await this.pool.query("DELETE FROM file_references WHERE id = ?", [id]);
    return Number((result as { affectedRows?: number }).affectedRows || 0) > 0;
  }

  /**
   * 业务对象被删除时清掉它的全部引用：
   * 字节仍留在文件中心（归上传者/管理员在台账里清理），但不能留下指向空对象的死链 ——
   * 死链会让文件既查不到归属、又因为 referenceCount>0 而永远删不掉。
   */
  async removeReferencesForEntity(entityType: string, entityId: string) {
    const [result] = await this.pool.query(
      "DELETE FROM file_references WHERE entity_type = ? AND entity_id = ?",
      [entityType, entityId]
    );
    return Number((result as { affectedRows?: number }).affectedRows || 0);
  }

  async updateReferenceKind(id: string, kind: string) {
    const [result] = await this.pool.query("UPDATE file_references SET kind = ? WHERE id = ?", [kind.slice(0, 30), id]);
    return Number((result as { affectedRows?: number }).affectedRows || 0) > 0;
  }

  async referencesForEntity(entityType: string, entityId: string, limit = 200) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT f.*, r.id AS reference_id, r.kind AS reference_kind,
              r.created_by AS reference_created_by, r.created_at AS reference_created_at
       FROM file_references r JOIN files f ON f.id = r.file_id
       WHERE r.entity_type = ? AND r.entity_id = ? ORDER BY r.created_at ASC LIMIT ?`,
      [entityType, entityId, Math.max(1, Math.min(limit, 500))]
    );
    return rows.map((row) => ({
      reference: {
        id: String(row.reference_id || ""),
        fileId: String(row.id || ""),
        entityType: entityType as FileReferenceRecord["entityType"],
        entityId: String(entityId),
        kind: String(row.reference_kind || "other"),
        createdBy: String(row.reference_created_by || ""),
        createdAt: toIso(row.reference_created_at)
      } satisfies FileReferenceRecord,
      file: mapFile(row)
    }));
  }

  async ledger(input: { ownerId?: string; limit?: number; offset?: number }) {
    const limit = Math.max(1, Math.min(input.limit || 50, 200));
    const offset = Math.max(0, input.offset || 0);
    // 不能写 HAVING ref_count = 0：没有 GROUP BY 时 MySQL 对非聚合列的处理依赖 sql_mode，
    // 用 NOT EXISTS 既稳定又能吃到 (file_id) 索引。
    const where = input.ownerId
      ? "WHERE f.status='active' AND f.owner_id = ? AND NOT EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = f.id)"
      : "WHERE f.status='active' AND NOT EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = f.id)";
    const params = input.ownerId ? [input.ownerId, limit, offset] : [limit, offset];
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT f.*, 0 AS ref_count FROM files f ${where}
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    return rows.map((row) => ({ ...mapFile(row), referenceCount: 0 }));
  }

  async dashboard(ownerId?: string) {
    const scope = ownerId ? "WHERE owner_id = ?" : "";
    const params = ownerId ? [ownerId] : [];
    const [summary] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes,
        SUM(status='recycled') AS recycled,
        SUM(derive_status='failed') AS derive_failed
       FROM files ${scope}`,
      params
    );
    const [orphans] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM files f ${ownerId ? "WHERE f.owner_id = ? AND" : "WHERE"} f.status='active'
         AND NOT EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = f.id)`,
      params
    );
    const [owners] = await this.pool.query<RowDataPacket[]>(
      `SELECT owner_id, COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM files ${scope}
       GROUP BY owner_id ORDER BY bytes DESC LIMIT 10`,
      params
    );
    return {
      total: Number(summary[0]?.total || 0),
      bytes: Number(summary[0]?.bytes || 0),
      recycled: Number(summary[0]?.recycled || 0),
      deriveFailed: Number(summary[0]?.derive_failed || 0),
      orphanCount: Number(orphans[0]?.total || 0),
      topOwners: owners.map((row) => ({ ownerId: String(row.owner_id || ""), total: Number(row.total || 0), bytes: Number(row.bytes || 0) }))
    };
  }

  async logAccess(input: { fileId: string; userId: string; action: string; ip?: string; userAgent?: string; requestId?: string }) {
    try {
      await this.pool.query(
        `INSERT INTO file_access_logs (file_id, user_id, action, ip, user_agent, request_id, at)
         VALUES (?,?,?,?,?,?,?)`,
        [input.fileId, input.userId, input.action, (input.ip || "").slice(0, 64), (input.userAgent || "").slice(0, 200), (input.requestId || "").slice(0, 64), new Date()]
      );
    } catch {
      // 审计失败不能挡住下载本身
    }
  }

  /**
   * 台账查询（M4）：所有文件而不是只有孤儿。权限范围在 SQL 里先粗筛，
   * 逐行并集判定仍由 evaluateFileAccess 做（两处不重叠：这里是分页需要，那里是放行依据）。
   */
  async queryFiles(input: {
    scope?: { userId: string; teamId: string; isAdmin: boolean };
    status?: FileStatus | "all";
    ownerId?: string;
    entityType?: string;
    entityId?: string;
    q?: string;
    onlyOrphans?: boolean;
    /** 只看转换失败：台账「转换失败 N」指标卡点进来要能落到具体文件 */
    deriveFailed?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.max(1, Math.min(input.limit || 50, 200));
    const offset = Math.max(0, input.offset || 0);
    const where: string[] = ["1=1"];
    const params: unknown[] = [];
    if (input.scope && !input.scope.isAdmin) {
      where.push("(f.owner_id = ? OR f.team_id = ? OR f.created_by = ?)");
      params.push(input.scope.userId, input.scope.teamId, input.scope.userId);
    }
    if (input.status && input.status !== "all") {
      where.push("f.status = ?");
      params.push(input.status);
    }
    if (input.ownerId) {
      where.push("f.owner_id = ?");
      params.push(input.ownerId);
    }
    if (input.entityType && input.entityId) {
      where.push("EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = f.id AND r.entity_type = ? AND r.entity_id = ?)");
      params.push(input.entityType, input.entityId);
    }
    if (input.onlyOrphans) {
      where.push("NOT EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = f.id)");
    }
    if (input.deriveFailed) {
      where.push("f.derive_status = 'failed'");
    }
    const keyword = String(input.q || "").trim();
    if (keyword) {
      where.push("(f.original_name LIKE ? OR f.id = ?)");
      params.push(`%${keyword.slice(0, 60)}%`, keyword);
    }
    const clause = where.join(" AND ");
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT f.*, (SELECT COUNT(*) FROM file_references r WHERE r.file_id = f.id) AS ref_count
       FROM files f WHERE ${clause} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [counted] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM files f WHERE ${clause}`,
      params
    );
    return {
      items: rows.map((row) => ({ ...mapFile(row), referenceCount: Number(row.ref_count || 0) })),
      total: Number(counted[0]?.total || 0),
      limit,
      offset
    };
  }

  /**
   * 审计日志表里只有 file_id。列表要显示文件名，逐条查就是 N+1，
   * 这里一次 IN 查回来。已彻底删除的文件查不到，调用方回退显示 id。
   */
  async namesByIds(ids: string[]): Promise<Map<string, string>> {
    const unique = Array.from(new Set(ids.filter((id) => Boolean(id))));
    const names = new Map<string, string>();
    if (!unique.length) return names;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT id, original_name FROM files WHERE id IN (?)",
      [unique]
    );
    rows.forEach((row) => names.set(String(row.id), String(row.original_name || "")));
    return names;
  }

  async accessLogs(input: { fileId?: string; userId?: string; action?: string; limit?: number; offset?: number; since?: Date }) {
    const limit = Math.max(1, Math.min(input.limit || 50, 200));
    const offset = Math.max(0, input.offset || 0);
    const where: string[] = ["1=1"];
    const params: unknown[] = [];
    if (input.fileId) {
      where.push("file_id = ?");
      params.push(input.fileId);
    }
    if (input.userId) {
      where.push("user_id = ?");
      params.push(input.userId);
    }
    if (input.action) {
      where.push("action = ?");
      params.push(input.action);
    }
    if (input.since) {
      where.push("at >= ?");
      params.push(input.since);
    }
    const clause = where.join(" AND ");
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM file_access_logs WHERE ${clause} ORDER BY at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [counted] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM file_access_logs WHERE ${clause}`,
      params
    );
    return { items: rows.map(mapAccessLog), total: Number(counted[0]?.total || 0), limit, offset };
  }

  // -------------------------------------------------------------------------
  // 分享链接（M3）
  // -------------------------------------------------------------------------

  async createShare(input: {
    fileId: string;
    token: string;
    createdBy: string;
    teamId: string;
    mode: ShareMode;
    passwordHash?: string;
    expiresAt?: Date | null;
    maxViews?: number;
    watermarkText?: string;
  }): Promise<ShareLinkRecord> {
    const id = `shr_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
    await this.pool.query(
      `INSERT INTO share_links (id, token, file_id, created_by, team_id, mode, password_hash, expires_at, max_views, view_count, watermark_text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
      [
        id, input.token, input.fileId, input.createdBy, input.teamId, input.mode,
        input.passwordHash || "", input.expiresAt || null, Math.max(0, input.maxViews || 0),
        (input.watermarkText || "").slice(0, 120), new Date()
      ]
    );
    const created = await this.findShareById(id);
    if (!created) throw new Error("分享链接创建失败");
    return created;
  }

  async findShareById(id: string): Promise<ShareLinkRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM share_links WHERE id = ? LIMIT 1", [id]);
    return rows[0] ? mapShare(rows[0]) : null;
  }

  async findShareByToken(token: string): Promise<ShareLinkRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM share_links WHERE token = ? LIMIT 1", [token]);
    return rows[0] ? mapShare(rows[0]) : null;
  }

  async listShares(fileId: string): Promise<ShareLinkRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM share_links WHERE file_id = ? ORDER BY created_at DESC LIMIT 100",
      [fileId]
    );
    return rows.map(mapShare);
  }

  /** 分享管理列表：按文件归属范围取，避免普通用户看到别人的分享 */
  async listSharesInScope(scope: { userId: string; teamId: string; isAdmin: boolean }, limit = 100) {
    const where = scope.isAdmin ? "1=1" : "(s.created_by = ? OR s.team_id = ?)";
    const params = scope.isAdmin ? [limit] : [scope.userId, scope.teamId, limit];
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT s.*, f.original_name, f.mime, f.status AS file_status FROM share_links s
       LEFT JOIN files f ON f.id = s.file_id
       WHERE ${where} ORDER BY s.created_at DESC LIMIT ?`,
      params
    );
    return rows.map((row) => ({
      ...mapShare(row),
      fileName: String(row.original_name || ""),
      mime: String(row.mime || ""),
      // 文件被删/回收后 LEFT JOIN 回来是空串：列表不能继续显示「有效」，
      // 外链点开其实是 410，状态必须跟真实可用性一致
      fileStatus: String(row.file_status || "")
    }));
  }

  /**
   * 原子计数：把「次数用尽」和「并发访问」交给数据库判定，
   * 否则两个请求同时读到 view_count=9 会都放行，超发一次。
   * 返回 false = 这一票没抢到（已超次数）。
   */
  async consumeShareView(id: string) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE share_links SET view_count = view_count + 1
       WHERE id = ? AND revoked_at IS NULL AND (max_views = 0 OR view_count < max_views)`,
      [id]
    );
    return result.affectedRows > 0;
  }

  async revokeShare(id: string) {
    await this.pool.query("UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [new Date(), id]);
  }

  // -------------------------------------------------------------------------
  // 版本（M3）
  // -------------------------------------------------------------------------

  async versionsOf(groupId: string): Promise<StoredFile[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM files WHERE version_group_id = ? AND status <> 'deleted' ORDER BY created_at DESC LIMIT 100",
      [groupId]
    );
    return rows.map(mapFile);
  }

  /** 新版进来时把同组其它版本降级；is_current 只有一行为 1 */
  async setCurrentVersion(groupId: string, fileId: string) {
    await this.pool.query(
      "UPDATE files SET is_current = 0, updated_at = ?, row_version = row_version + 1 WHERE version_group_id = ? AND id <> ? AND is_current = 1",
      [new Date(), groupId, fileId]
    );
    await this.pool.query(
      "UPDATE files SET is_current = 1, updated_at = ?, row_version = row_version + 1 WHERE id = ?",
      [new Date(), fileId]
    );
  }

  /** 把指向旧版本的业务引用整体换到新版本（「让订单改用新版」） */
  async migrateReferences(fromFileId: string, toFileId: string) {
    // 同一实体可能已经有指向新版本的引用，先删会撞唯一键的那部分
    await this.pool.query(
      `DELETE r FROM file_references r
       JOIN file_references keep
         ON keep.entity_type = r.entity_type AND keep.entity_id = r.entity_id AND keep.kind = r.kind AND keep.file_id = ?
       WHERE r.file_id = ?`,
      [toFileId, fromFileId]
    );
    const [result] = await this.pool.query<ResultSetHeader>(
      "UPDATE file_references SET file_id = ? WHERE file_id = ?",
      [toFileId, fromFileId]
    );
    return result.affectedRows;
  }

  // -------------------------------------------------------------------------
  // 合规与归属（M4）
  // -------------------------------------------------------------------------

  async setLegalHold(id: string, hold: boolean, retainUntil?: Date | null) {
    await this.pool.query(
      "UPDATE files SET legal_hold = ?, retain_until = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?",
      [hold ? 1 : 0, retainUntil || null, new Date(), id]
    );
  }

  async transferOwner(fromUserId: string, toUserId: string, toTeamId: string) {
    const [result] = await this.pool.query<ResultSetHeader>(
      "UPDATE files SET owner_id = ?, team_id = ?, updated_at = ?, row_version = row_version + 1 WHERE owner_id = ?",
      [toUserId, toTeamId, new Date(), fromUserId]
    );
    return result.affectedRows;
  }

  /** 巡检取样：只取 active 的行，全表游标推进，避免每次只查前 N 条 */
  async sampleForVerify(input: { limit?: number; afterId?: string }) {
    const limit = Math.max(1, Math.min(input.limit || 50, 200));
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, storage_key, sha256, size, original_name FROM files
       WHERE status='active' AND id > ? ORDER BY id ASC LIMIT ?`,
      [input.afterId || "", limit]
    );
    return rows.map((row) => ({
      id: String(row.id),
      key: String(row.storage_key),
      sha256: String(row.sha256 || ""),
      size: Number(row.size || 0),
      originalName: String(row.original_name || "")
    }));
  }

  async getSetting(key: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT v FROM storage_settings WHERE k = ? LIMIT 1", [key]);
    return rows[0] ? String(rows[0].v || "") : "";
  }

  async setSetting(key: string, value: string) {
    await this.pool.query(
      "INSERT INTO storage_settings (k, v) VALUES (?,?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [key, value]
    );
  }

  async listSettings() {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT k, v FROM storage_settings");
    return Object.fromEntries(rows.map((row) => [String(row.k), String(row.v || "")]));
  }

  async allFilesMissingReferences(limit = 100) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT f.id, f.storage_key FROM files f WHERE f.status='active'
        AND NOT EXISTS (SELECT 1 FROM file_references r WHERE r.file_id = f.id)
        ORDER BY f.created_at ASC LIMIT ?`,
      [Math.max(1, Math.min(limit, 500))]
    );
    return rows.map((row) => ({ id: String(row.id), key: String(row.storage_key) }));
  }

  // -------------------------------------------------------------------------
  // 分片上传会话
  // -------------------------------------------------------------------------

  /** 彻底删除前先取走派生件 key：删了行就再也找不到盘上那些字节了 */
  async deleteDerivatives(fileId: string): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT storage_key FROM file_derivatives WHERE file_id = ?",
      [fileId]
    );
    const keys = rows.map((row) => String(row.storage_key || "")).filter(Boolean);
    await this.pool.query("DELETE FROM file_derivatives WHERE file_id = ?", [fileId]);
    return keys;
  }

  async createUploadSession(input: {
    clientToken: string;
    ownerId: string;
    teamId: string;
    originalName: string;
    size: number;
    chunkSize: number;
    contextType?: string;
    contextId?: string;
    kind?: string;
    sha256?: string;
    expiresAt: Date;
  }): Promise<UploadSessionRecord | null> {
    const id = `upl_${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
    const totalChunks = Math.max(1, Math.ceil(input.size / Math.max(1, input.chunkSize)));
    try {
      await this.pool.query(
        `INSERT INTO upload_sessions
          (id, client_token, owner_id, team_id, original_name, size, chunk_size, total_chunks,
           received_json, status, file_id, context_type, context_id, kind, sha256, expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.clientToken,
          input.ownerId,
          input.teamId,
          input.originalName,
          input.size,
          input.chunkSize,
          totalChunks,
          JSON.stringify([]),
          "open",
          "",
          input.contextType || "",
          input.contextId || "",
          input.kind || "other",
          input.sha256 || "",
          input.expiresAt,
          new Date(),
          new Date()
        ]
      );
    } catch (error) {
      // 同一个 clientToken 重复开会话 = 断网重试，把原会话还给客户端即可
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") return this.findUploadSessionByToken(input.clientToken);
      throw error;
    }
    return this.findUploadSession(id);
  }

  async findUploadSession(id: string): Promise<UploadSessionRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM upload_sessions WHERE id = ? LIMIT 1", [id]);
    return rows[0] ? mapUploadSession(rows[0]) : null;
  }

  async findUploadSessionByToken(token: string): Promise<UploadSessionRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM upload_sessions WHERE client_token = ? LIMIT 1",
      [token]
    );
    return rows[0] ? mapUploadSession(rows[0]) : null;
  }

  async countOpenUploadSessions(ownerId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM upload_sessions WHERE owner_id = ? AND status = 'open'",
      [ownerId]
    );
    return Number(rows[0]?.total || 0);
  }

  async touchUploadSession(id: string, received: number[]) {
    const sorted = [...new Set(received)].sort((a, b) => a - b);
    await this.pool.query("UPDATE upload_sessions SET received_json = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(sorted),
      new Date(),
      id
    ]);
    return sorted;
  }

  async finishUploadSession(id: string, fileId: string) {
    await this.pool.query("UPDATE upload_sessions SET status = 'completed', file_id = ?, updated_at = ? WHERE id = ?", [
      fileId,
      new Date(),
      id
    ]);
  }

  async abortUploadSession(id: string) {
    await this.pool.query("UPDATE upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?", [new Date(), id]);
  }

  async expiredUploadSessions(limit = 50) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM upload_sessions WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ? ORDER BY created_at ASC LIMIT ?",
      [new Date(), Math.max(1, Math.min(limit, 200))]
    );
    return rows.map(mapUploadSession);
  }

  // -------------------------------------------------------------------------
  // 派生件（office→pdf / heic→jpg / 缩略图）
  // -------------------------------------------------------------------------

  async upsertDerivative(input: {
    fileId: string;
    kind: DeriveKind;
    status: DeriveRowStatus;
    storageKey?: string;
    error?: string;
  }) {
    const id = `fdrv_${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
    await this.pool.query(
      `INSERT INTO file_derivatives (id, file_id, kind, storage_key, status, error, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), storage_key = VALUES(storage_key), error = VALUES(error)`,
      [id, input.fileId, input.kind, input.storageKey || "", input.status, (input.error || "").slice(0, 300), new Date()]
    );
  }

  async findDerivative(fileId: string, kind: DeriveKind): Promise<FileDerivativeRecord | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM file_derivatives WHERE file_id = ? AND kind = ? LIMIT 1",
      [fileId, kind]
    );
    return rows[0] ? mapDerivative(rows[0]) : null;
  }

  async derivativesFor(fileId: string): Promise<FileDerivativeRecord[]> {    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM file_derivatives WHERE file_id = ? ORDER BY created_at ASC",
      [fileId]
    );
    return rows.map(mapDerivative);
  }

  async markDeriveStatus(fileId: string, status: FileDeriveStatus, error = "") {
    await this.pool.query("UPDATE files SET derive_status = ?, derive_error = ?, updated_at = ? WHERE id = ?", [
      status,
      (error || "").slice(0, 300),
      new Date(),
      fileId
    ]);
  }

  /**
   * 进程重启自愈：processing 行是队列的真相源，重启后没人接着跑，必须先落成 failed 再重排。
   * 只重排「重启中断」这一类，真失败（比如没装 LibreOffice）不该每次重启都重试一遍。
   */
  async resetInterruptedDerivations(reason: string) {
    await this.pool.query("UPDATE file_derivatives SET status = 'failed', error = ? WHERE status = 'processing'", [reason]);
    const [result] = await this.pool.query(
      "UPDATE files SET derive_status = 'failed', derive_error = ?, updated_at = ? WHERE derive_status = 'processing'",
      [reason, new Date()]
    );
    return Number((result as { affectedRows?: number }).affectedRows || 0);
  }

  async filesWithDeriveStatus(status: FileDeriveStatus, limit = 200) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM files WHERE derive_status = ? AND status = 'active' ORDER BY created_at ASC LIMIT ?",
      [status, Math.max(1, Math.min(limit, 500))]
    );
    return rows.map(mapFile);
  }
}

let repository: MysqlFileRepository | null = null;

export function setFileRepository(next: MysqlFileRepository | null) {
  repository = next;
}

export function getFileRepository() {
  return repository;
}
