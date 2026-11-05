import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fileStorageDriver,
  getFileRepository,
  LocalStorageDriver,
  type DeriveKind,
  type MysqlFileRepository,
  type StoredFile
} from "./file-storage.js";

// ---------------------------------------------------------------------------
// 派生管道（M2）
//
// 设计约束（见 docs/FILE-STORAGE-DEV-PLAN.md §6）：
// - 队列的真相源是 DB：derive_status='processing'；进程重启先把它落成 failed 再重排，
//   否则重启后这些行永远卡在「转换中」。
// - 串行并发 1：LibreOffice 并发会互相踩内存/锁 profile。
// - 单任务 60s 超时，杀**进程组**（soffice 会 fork，只杀父进程留一堆孤儿）。
// - 派生失败永不阻塞下载：下载走原文件，预览才依赖派生件。
// - 派生 key 挂在本体旁 `.deriv/`，随时可重生成；备份只搬本体。
// ---------------------------------------------------------------------------

/** soffice 会 fork 子进程，且要独占 profile，所以超时必须杀整组 */
export const DERIVE_TIMEOUT_MS = 60_000;
export const DERIVE_MAX_PENDING_PER_USER = 20;
export const DERIVE_THUMB_SIZE = 900;

const OFFICE_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // WPS Office 专有格式：扩展名是主要判据，这里补 mime 只是因为上传时的探测会给出这三个值
  "application/x-wps",
  "application/x-wps-et",
  "application/x-wps-dps"
]);

// WPS 专有格式（.wps/.et/.dps 等）也在这里：客户用 WPS 做单很常见。
// 注意 .wps 有歧义——既可能是 WPS Office 也可能是 Microsoft Works，两者 LibreOffice 都有导入器，
// 但排版保真度不高，所以失败文案要引导用户「另存为 docx」而不是只说失败。
const OFFICE_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  "wps", "wpt", "et", "ett", "dps", "dpt"
]);

/** WPS 自己的二进制格式：LibreOffice 能试，但保真度低，失败时要给出可操作建议 */
const WPS_NATIVE_EXTS = new Set(["wps", "wpt", "et", "ett", "dps", "dpt"]);

export function fileExt(name: string) {
  return String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/u)?.[1] || "";
}

export function isWpsNativeFile(name: string) {
  return WPS_NATIVE_EXTS.has(fileExt(name));
}

const WPS_NATIVE_HINT =
  "这是 WPS 专有格式，转换后版式可能失真；建议在 WPS 里「另存为 .docx/.xlsx/.pptx」后重新上传，或下载原件查看";

/**
 * 转换器只看文件后缀，所以临时文件的后缀必须和真实内容一致。
 * - OLE2（D0 CF）＝ 97-2003 二进制或 WPS 原生格式，保留原后缀；
 * - ZIP（PK）＝ OOXML 容器，无论用户把它叫 .doc/.wps/.et，都要改回 .docx/.xlsx/.pptx。
 */
export function conversionExtension(buffer: Buffer, name: string) {
  const ext = fileExt(name);
  const fallback = ext ? `.${ext}` : "";
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!isZip) return fallback;
  if (["docx", "doc", "wps", "wpt", "odt"].includes(ext)) return ".docx";
  if (["xlsx", "xls", "et", "ett", "ods"].includes(ext)) return ".xlsx";
  if (["pptx", "ppt", "dps", "dpt", "odp"].includes(ext)) return ".pptx";
  return fallback;
}

export interface DeriveCapabilities {
  /** 运行平台：设置页要据此给出不同的安装指引（brew / winget / apt） */
  platform: NodeJS.Platform;
  /** LibreOffice 可执行文件；空 = 没装，Office 文档只能下载不能在线预览 */
  libreoffice: string;
  /** 图像编解码：macOS 用 sips，其它平台用 ImageMagick（可选，装了才能出缩略图/解 HEIC） */
  sips: string;
  magick: string;
  qlmanage: string;
  pdftoppm: string;
}

let cachedCapabilities: DeriveCapabilities | null = null;

function firstExisting(candidates: string[]) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function envPath(name: string) {
  const value = String(process.env[name] || "").trim();
  return value;
}

/**
 * LibreOffice 候选路径（按平台）。
 *
 * Windows 有一个必须踩对的坑：`soffice.exe` 是 GUI 入口，命令行调用会**立刻返回 0**，
 * 而转换还在后台跑，于是我们读不到产物就判失败；`soffice.com` 是同一目录下的控制台壳，
 * 会等转换结束并回真实退出码。所以 Windows 上 .com 必须排在 .exe 前面。
 */
export function libreOfficeCandidates(): string[] {
  const list: string[] = [envPath("LIBREOFFICE_BIN"), envPath("GOODJOB_SOFFICE_BIN")];
  if (process.platform === "win32") {
    const programFiles = envPath("ProgramFiles") || "C:\\Program Files";
    const programFilesX86 = envPath("ProgramFiles(x86)") || "C:\\Program Files (x86)";
    const localAppData = envPath("LOCALAPPDATA");
    const bases = [programFiles, programFilesX86, localAppData ? path.join(localAppData, "Programs") : ""];
    for (const base of bases) {
      if (!base) continue;
      list.push(path.join(base, "LibreOffice", "program", "soffice.com"));
      list.push(path.join(base, "LibreOffice", "program", "soffice.exe"));
    }
    return list;
  }
  if (process.platform === "darwin") {
    list.push(
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      // 免管理员密码的装法：解压到用户目录，install 脚本会走这里
      path.join(os.homedir(), "Applications/LibreOffice.app/Contents/MacOS/soffice"),
      "/opt/homebrew/bin/soffice",
      "/usr/local/bin/soffice"
    );
  }
  list.push("/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/lib/libreoffice/program/soffice", "/snap/bin/libreoffice");
  return list;
}

/**
 * 能力探测：只认绝对路径，不走 `which`（避免 PATH 被服务环境改掉时探测结果飘）。
 * 结果缓存：装机后要重启服务才生效，这与「重启后重排中断队列」是同一个动作。
 */
export function probeDeriveCapabilities(force = false): DeriveCapabilities {
  if (cachedCapabilities && !force) return cachedCapabilities;
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  cachedCapabilities = {
    platform: process.platform,
    libreoffice: firstExisting(libreOfficeCandidates()),
    // sips / qlmanage 是 macOS 专属。别的平台一律留空，改走 ImageMagick / pdftoppm，
    // 千万不要把 `convert` 塞进 sips 字段——参数语法不同（-s format 是 sips 独有的），
    // 会变成「探测到了能力、每次调用都失败」。
    sips: isMac ? firstExisting(["/usr/bin/sips"]) : "",
    qlmanage: isMac ? firstExisting(["/usr/bin/qlmanage"]) : "",
    magick: isMac
      ? ""
      : firstExisting([
        envPath("GOODJOB_MAGICK_BIN"),
        "/usr/bin/magick",
        "/usr/local/bin/magick",
        "/opt/homebrew/bin/magick",
        "/usr/bin/convert",
        isWin ? path.join(envPath("ProgramFiles") || "C:\\Program Files", "ImageMagick-7.1.1-Q16-HDRI", "magick.exe") : ""
      ]),
    pdftoppm: firstExisting([
      envPath("GOODJOB_PDFTOPPM"),
      "/opt/homebrew/bin/pdftoppm",
      "/usr/local/bin/pdftoppm",
      "/usr/bin/pdftoppm",
      isWin ? path.join(envPath("ProgramFiles") || "C:\\Program Files", "poppler", "Library", "bin", "pdftoppm.exe") : "",
      isWin ? path.join(envPath("ProgramFiles") || "C:\\Program Files", "poppler", "bin", "pdftoppm.exe") : "",
      isWin && envPath("LOCALAPPDATA") ? path.join(envPath("LOCALAPPDATA"), "poppler", "bin", "pdftoppm.exe") : ""
    ])
  };
  return cachedCapabilities;
}

export interface ImageDecoder {
  kind: "sips" | "magick";
  bin: string;
}

/** 当前平台上可用的图片编解码器；null = 只能下载原图 */
export function imageDecoder(caps: DeriveCapabilities = probeDeriveCapabilities()): ImageDecoder | null {
  if (caps.sips) return { kind: "sips", bin: caps.sips };
  if (caps.magick) return { kind: "magick", bin: caps.magick };
  return null;
}

/**
 * 挑选 fontconfig 配置文件。
 * Windows 不需要也不该注入：LibreOffice 在 Windows 上走 GDI/DirectWrite 取系统字体，
 * 系统自带宋体/黑体/微软雅黑，中文本来就能渲染；塞一个 fontconfig 反而可能把字体源换空。
 * macOS 需要（LO 只认自己 bundle 里的 128 个字体，无 CJK）；Linux 需要但目录不同，
 * 所以两份配置分开放——用错平台的那份等于告诉 LO「系统里没有字体」。
 */
export function fontConfigFile(): string {
  if (process.platform === "win32") return "";
  const filename = process.platform === "darwin" ? "fonts.conf" : "fonts.linux.conf";
  const candidates = [
    envPath("GOODJOB_FONTCONFIG_FILE"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "fontconfig", filename)
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

/**
 * 把仓库里的 fontconfig 喂给 soffice 子进程。
 *
 * 不注入的后果很隐蔽：LibreOffice 在 macOS 上只认自己 bundle 里的字体（无中文字形），
 * 转出来的 PDF「转换成功」，但中文整段消失、只剩数字和英文。
 * 所以这里不是可选优化，是 Office 预览能不能用的前提。
 */
export function fontConfigEnv(): NodeJS.ProcessEnv {
  const found = fontConfigFile();
  if (!found) return {};
  return { FONTCONFIG_FILE: found, FONTCONFIG_PATH: path.dirname(found) };
}

export function isOfficeFile(mime: string, name: string) {
  if (OFFICE_MIMES.has(mime)) return true;
  const ext = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/u)?.[1] || "";
  return OFFICE_EXTS.has(ext);
}

export function isHeicFile(mime: string, name: string) {
  const ext = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/u)?.[1] || "";
  return mime === "image/heic" || mime === "image/heif" || ext === "heic" || ext === "heif";
}

/** 上传时就该知道「这个文件根本没法预览」，好让用户当场看到原因，而不是上传完才发现 */
export function previewCapabilityIssue(file: Pick<StoredFile, "mime" | "originalName">) {
  if (isOfficeFile(file.mime, file.originalName)) {
    const caps = probeDeriveCapabilities();
    if (!caps.libreoffice) return "服务器缺少 Office 转换组件，Office 文档暂时只能下载查看";
  }
  if (isHeicFile(file.mime, file.originalName)) {
    // LibreOffice 不认 HEIC，所以这里不能拿 libreoffice 当解码能力；
    // 只有 sips（macOS）或 ImageMagick 带 HEIC 委托时才算能预览。
    const caps = probeDeriveCapabilities();
    if (!caps.sips && !caps.magick) return "服务器缺少 HEIC 解码组件，此图暂时只能下载查看";
  }
  return "";
}

/** 每种文件要产出哪些派生件；带 required 标记的失败才让整体算失败 */
export function planDerivations(file: Pick<StoredFile, "mime" | "originalName">): Array<{ kind: DeriveKind; required: boolean; ext: string }> {
  if (isOfficeFile(file.mime, file.originalName)) {
    return [
      { kind: "preview_pdf", required: true, ext: "pdf" },
      { kind: "thumb", required: false, ext: "jpg" }
    ];
  }
  if (isHeicFile(file.mime, file.originalName)) {
    return [
      { kind: "image_jpg", required: true, ext: "jpg" },
      { kind: "thumb", required: false, ext: "jpg" }
    ];
  }
  if (file.mime === "application/pdf") {
    return [{ kind: "thumb", required: false, ext: "jpg" }];
  }
  if (file.mime.startsWith("image/")) {
    return [{ kind: "thumb", required: false, ext: "jpg" }];
  }
  return [];
}

export function derivativeKey(file: StoredFile, kind: DeriveKind, ext: string) {
  return `${file.key}.deriv/${kind}.${ext}`;
}

interface RunResult {
  code: number | null;
  timedOut: boolean;
  stderr: string;
}

/** 跑外部命令：超时杀整棵进程树（soffice 会 fork，只杀父进程会留一地孤儿） */
export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DERIVE_TIMEOUT_MS;
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, {
        // Windows 上 detached 会开一个独立控制台窗口，而且负 pid 根本不能用（没有进程组语义），
        // 所以那边靠 taskkill /T 递归杀树；POSIX 上才有必要脱离并杀进程组。
        detached: !isWin,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) }
      });
    } catch (error) {
      resolve({ code: null, timedOut: false, stderr: error instanceof Error ? error.message : "启动失败" });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (!pid) return;
      if (isWin) {
        // /T = 连子进程一起杀，/F = 强制；不这么做 soffice.bin 会一直攥着 profile 锁
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
        } catch {
          try { child.kill(); } catch { /* 已经没了 */ }
        }
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程已经没了
        }
      }
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      // 只留尾部：soffice 的 java 警告能刷几百 KB
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, stderr: stderr.trim() });
    });
  });
}

export function shortError(result: RunResult, fallback: string) {
  if (result.timedOut) return `${fallback}：超过 ${Math.round(DERIVE_TIMEOUT_MS / 1000)} 秒未完成，已强制结束`;
  // 外部工具的 stderr 只写日志，不拼进用户可见文案：sips 报的是 "Try 'sips --help' for help"，
  // soffice 报的是 Java/profile 路径，业务用户看了等于没说，还顺带暴露部署细节。
  if (result.stderr) console.error(`[file-derive] ${fallback}：${result.stderr.slice(0, 500)}`);
  return `${fallback}，可下载原文件查看`;
}

export interface DeriveQueueOptions {
  driver?: LocalStorageDriver;
  repository?: MysqlFileRepository | null;
  concurrency?: number;
}

/**
 * 单进程串行队列。没有 Redis/BullMQ 是刻意的：这是单机部署，
 * 多引入一个基础设施换不来可靠性，DB + 启动重排已经把「卡在 processing」堵住了。
 */
export class DeriveQueue {
  private driver: LocalStorageDriver;
  private repository: MysqlFileRepository | null;
  private concurrency: number;
  private pending: string[] = [];
  private running = new Set<string>();
  private draining = false;
  private stopped = false;

  constructor(options: DeriveQueueOptions = {}) {
    this.driver = options.driver || fileStorageDriver;
    // 仓库是启动后注入的，构造时不抓死，否则拿到 null 就再也换不了
    this.repository = options.repository || null;
    this.concurrency = Math.max(1, options.concurrency || 1);
  }

  setRepository(repository: MysqlFileRepository | null) {
    this.repository = repository;
  }

  status() {
    return {
      pending: this.pending.length,
      running: this.running.size,
      capabilities: probeDeriveCapabilities(),
      // 没注入字体配置时，Office 转出来的 PDF 会丢中文，所以要让设置页看得见
      fontconfig: fontConfigEnv().FONTCONFIG_FILE || ""
    };
  }

  /** 启动自愈：把上次进程留下的 processing 落成 failed，再重新排队 */
  async recover(): Promise<{ reset: number; requeued: number }> {
    const repository = this.repository;
    if (!repository) return { reset: 0, requeued: 0 };
    const reason = "服务重启时转换被中断，已自动重排";
    const reset = await repository.resetInterruptedDerivations(reason);
    const files = await repository.filesWithDeriveStatus("failed", 200);
    let requeued = 0;
    for (const file of files) {
      if (file.deriveError !== reason) continue;
      this.enqueue(file.id);
      requeued += 1;
    }
    return { reset, requeued };
  }

  enqueue(fileId: string) {
    if (!fileId || this.stopped) return false;
    if (this.pending.includes(fileId) || this.running.has(fileId)) return false;
    this.pending.push(fileId);
    void this.drain();
    return true;
  }

  stop() {
    this.stopped = true;
  }

  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped && this.running.size < this.concurrency && this.pending.length) {
        const fileId = this.pending.shift()!;
        this.running.add(fileId);
        void this.process(fileId).finally(() => {
          this.running.delete(fileId);
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async process(fileId: string) {
    const repository = this.repository;
    if (!repository) return;
    let file: StoredFile | null = null;
    try {
      file = await repository.findFile(fileId);
      if (!file) return;
      const kinds = planDerivations(file);
      if (!kinds.length) {
        await repository.markDeriveStatus(file.id, "none");
        return;
      }
      await repository.markDeriveStatus(file.id, "processing");
      const failures: string[] = [];
      for (const plan of kinds) {
        try {
          await this.buildDerivative(file, plan.kind, plan.ext);
          await repository.upsertDerivative({ fileId: file.id, kind: plan.kind, status: "ready", storageKey: derivativeKey(file, plan.kind, plan.ext) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "转换失败";
          if (plan.required) failures.push(message);
          await repository.upsertDerivative({ fileId: file.id, kind: plan.kind, status: "failed", error: message });
        }
      }
      if (failures.length) await repository.markDeriveStatus(file.id, "failed", failures[0]);
      else await repository.markDeriveStatus(file.id, "ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "转换失败";
      await repository.markDeriveStatus(fileId, "failed", message).catch(() => undefined);
    }
  }

  /** 生成单个派生件：源文件先落到 tmp，转换产物再入 `.deriv/` */
  private async buildDerivative(file: StoredFile, kind: DeriveKind, ext: string) {
    const caps = probeDeriveCapabilities();
    const source = await this.driver.read(file.key);
    if (!source) throw new Error("文件本体已丢失，无法转换");
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gj-derive-"));
    // 送给转换器的临时文件后缀要按**内容**纠正，不能只看原始后缀：
    // WPS 常见把 OOXML 存成 .doc/.wps/.et，若按后缀解析，LibreOffice 会当 97-2003 老格式处理而失败。
    const sourcePath = path.join(workDir, `source${conversionExtension(source, file.originalName)}`);
    await fsp.writeFile(sourcePath, source);
    try {
      let produced: Buffer | null = null;
      if (kind === "preview_pdf") {
        if (!caps.libreoffice) throw new Error("服务器缺少 Office 转换组件，暂时只能下载查看");
        produced = await this.convertWithLibreOffice(caps.libreoffice, sourcePath, workDir, "pdf");
      } else if (kind === "image_jpg") {
        const decoder = imageDecoder(caps);
        if (!decoder) throw new Error("服务器缺少 HEIC 解码组件，此文件暂时只能下载查看");
        produced = await this.convertImage(decoder, sourcePath, path.join(workDir, "out.jpg"));
      } else if (kind === "thumb") {
        if (isOfficeFile(file.mime, file.originalName)) {
          // Office 的缩略图从刚转出来的 PDF 取第一页，避免再让 soffice 跑一次
          if (!caps.libreoffice) throw new Error("服务器缺少 Office 转换组件，暂时不能生成缩略图");
          const pdf = await this.convertWithLibreOffice(caps.libreoffice, sourcePath, workDir, "pdf");
          const pdfPath = path.join(workDir, "source.pdf");
          await fsp.writeFile(pdfPath, pdf);
          produced = await this.pdfThumb(caps, pdfPath, workDir);
        } else if (file.mime === "application/pdf") {
          produced = await this.pdfThumb(caps, sourcePath, workDir);
        } else {
          const decoder = imageDecoder(caps);
          if (!decoder) throw new Error("缺少图片处理组件，无法生成缩略图");
          produced = await this.convertImage(decoder, sourcePath, path.join(workDir, "thumb.jpg"), { maxSize: DERIVE_THUMB_SIZE });
        }
      } else {
        throw new Error("暂不支持该派生类型");
      }
      if (!produced || !produced.length) throw new Error("转换结果为空");
      const key = derivativeKey(file, kind, ext);
      await this.driver.put(key, produced);
      // 写盘期间文件可能已被彻底删除：补一次存在性校验，否则会留下表里查不到的孤儿派生件
      if (this.repository && !(await this.repository.findFile(file.id))) {
        await this.driver.remove(key).catch(() => undefined);
        return;
      }
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async convertWithLibreOffice(binary: string, sourcePath: string, workDir: string, target: "pdf") {
    // soffice 要独占用户 profile：把它指到临时目录，避免和桌面端 LibreOffice 抢锁。
    // 这里必须用 pathToFileURL：Windows 的 profileDir 是 `C:\Users\...`，直接拼 `file://C:\...`
    // 不是合法 URL，soffice 会静默忽略该参数，于是去抢用户桌面版的 profile 锁而转换失败。
    const profileDir = path.join(workDir, "lo-profile");
    await fsp.mkdir(profileDir, { recursive: true });
    const result = await runCommand(
      binary,
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        target,
        "--outdir",
        workDir,
        sourcePath
      ],
      { timeoutMs: DERIVE_TIMEOUT_MS, cwd: workDir, env: fontConfigEnv() }
    );
    if (result.timedOut) throw new Error(shortError(result, "Office 转 PDF 超时"));
    if (result.code !== 0) {
      // WPS 专有格式转换失败时，用户真正该做的是「另存为 OOXML 再传」，别只丢一句失败
      throw new Error(isWpsNativeFile(sourcePath) ? WPS_NATIVE_HINT : shortError(result, "Office 转 PDF 失败"));
    }
    const produced = path.join(workDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
    const buffer = await fsp.readFile(produced).catch(() => null);
    if (!buffer) {
      throw new Error(isWpsNativeFile(sourcePath)
        ? WPS_NATIVE_HINT
        : "转换没有产出 PDF，源文件可能已损坏，可下载原件确认");
    }
    return buffer;
  }

  /**
   * 图片转 JPEG。
   * sips（macOS）和 ImageMagick（Linux/Windows）的参数语法完全不同，必须分开拼：
   * sips 是 `-s format jpeg -Z 900 in --out out`，IM 是 `in -resize 900x900 -quality 82 out`。
   * 混用会「探测到能力、每次调用都失败」，这类错比没装更难查。
   */
  private async convertImage(decoder: ImageDecoder, sourcePath: string, outPath: string, options: { maxSize?: number } = {}) {
    const args = decoder.kind === "sips"
      ? [
        ...(options.maxSize ? ["-Z", String(options.maxSize)] : []),
        "-s", "format", "jpeg", "-s", "formatOptions", "82", sourcePath, "--out", outPath
      ]
      : [
        // `>` 前缀表示「只在超过时缩小」，否则小图会被放大糊掉
        ...(options.maxSize ? ["-resize", `${options.maxSize}x${options.maxSize}>`] : []),
        "-quality", "82",
        sourcePath, outPath
      ];
    const result = await runCommand(decoder.bin, args, { timeoutMs: 20_000 });
    if (result.code !== 0) throw new Error(shortError(result, "图片转换失败"));
    const buffer = await fsp.readFile(outPath).catch(() => null);
    if (!buffer) throw new Error("图片转换没有产出结果");
    return buffer;
  }

  private async pdfThumb(caps: DeriveCapabilities, pdfPath: string, workDir: string) {
    // sips 排第一：macOS 自带、只出首页（缩略图本来就只要首页）、不依赖 QuickLook 服务。
    // qlmanage 在 launchd/无 GUI 会话里会报 "sandbox initialization failed" 且退出码仍可能是 0，
    // 所以它只能当最后的兜底，不能当主力。
    if (caps.sips) {
      const outPath = path.join(workDir, "pdf-thumb.jpg");
      const result = await runCommand(
        caps.sips,
        ["-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", String(DERIVE_THUMB_SIZE), pdfPath, "--out", outPath],
        { timeoutMs: 20_000 }
      );
      if (result.code === 0) {
        const produced = await fsp.readFile(outPath).catch(() => null);
        if (produced?.length) return produced;
      }
    }
    // pdftoppm 是跨平台主力：poppler 三平台都有包（winget / brew / apt）。
    // 注意 Windows 上输出名是 `thumb-1.jpg`（个位数不补零），Linux 老版本可能是 `thumb-01.jpg`。
    if (caps.pdftoppm) {
      const prefix = path.join(workDir, "thumb");
      const result = await runCommand(
        caps.pdftoppm,
        ["-jpeg", "-f", "1", "-l", "1", "-scale-to", String(DERIVE_THUMB_SIZE), pdfPath, prefix],
        { timeoutMs: 20_000 }
      );
      if (result.code === 0) {
        const produced = await fsp.readFile(`${prefix}-1.jpg`).catch(() => null) || await fsp.readFile(`${prefix}-01.jpg`).catch(() => null);
        if (produced) return produced;
      }
    }
    // ImageMagick 兜底：能读 PDF 的前提是系统里有 Ghostscript，没有就失败，
    // 所以它只负责「万一有」，失败继续往下走，不在这里抛错。
    if (caps.magick) {
      const outPath = path.join(workDir, "im-thumb.jpg");
      const result = await runCommand(
        caps.magick,
        ["-density", "120", `${pdfPath}[0]`, "-background", "white", "-alpha", "remove", "-alpha", "off",
          "-resize", `${DERIVE_THUMB_SIZE}x${DERIVE_THUMB_SIZE}>`, "-quality", "82", outPath],
        { timeoutMs: 20_000 }
      );
      if (result.code === 0) {
        const produced = await fsp.readFile(outPath).catch(() => null);
        if (produced?.length) return produced;
      }
    }
    if (caps.qlmanage) {
      // macOS 兜底：QuickLook 能出第一页 PNG（多页缩略图需要 poppler，未装就只能一页）
      const result = await runCommand(caps.qlmanage, ["-t", "-s", String(DERIVE_THUMB_SIZE), "-o", workDir, pdfPath], {
        timeoutMs: 20_000
      });
      if (result.code !== 0) throw new Error(shortError(result, "PDF 缩略图生成失败"));
      const name = `${path.basename(pdfPath)}.png`;
      const produced = await fsp.readFile(path.join(workDir, name)).catch(() => null);
      if (!produced) throw new Error("PDF 缩略图没有产出结果");
      return produced;
    }
    // 缩略图是可选的（plan.required=false），失败不影响在线预览，所以文案不用吓人
    throw new Error("缺少 PDF 渲染组件，暂时无法生成缩略图");
  }
}

export const deriveQueue = new DeriveQueue();

/** server 启动时调用：注入仓库 + 自愈 + 清理过期分片 */
export async function startDerivePipeline() {
  const repository = getFileRepository();
  deriveQueue.setRepository(repository);
  if (!repository) return { reset: 0, requeued: 0, pruned: 0 };
  const recovered = await deriveQueue.recover();
  const pruned = await fileStorageDriver.pruneChunks(24 * 60 * 60 * 1000);
  return { ...recovered, pruned };
}

/** 独立跑一遍某个文件的派生（重试按钮走这里，不进队列也不受队列深度影响） */
export async function retryDerivation(fileId: string) {
  deriveQueue.enqueue(fileId);
}
