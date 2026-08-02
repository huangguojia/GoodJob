import { spawn } from "node:child_process";
import { verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface UpdateAsset {
  url: string;
  size: number;
  sha256: string;
}

export interface ReleaseInfo {
  date: string;
  windows?: UpdateAsset;
  databaseCompatibility: "backward-compatible";
  changelog: string;
  credits?: string;
}

export interface UpdateManifest {
  packageFormatVersion: number;
  latestVersion: string;
  minimumVersion: string;
  releases: Record<string, ReleaseInfo>;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  changelog: string | null;
  credits: string | null;
  lastChecked: string | null;
  error: string | null;
}

export type UpdateStage =
  | "idle"
  | "checking"
  | "backing_up"
  | "backup_verified"
  | "downloading"
  | "verifying"
  | "staged"
  | "migrating"
  | "switching"
  | "rolling_back"
  | "done"
  | "error";

export interface UpdateProgress {
  stage: UpdateStage;
  message: string;
  percent: number;
  updatedAt?: string;
  backupFile?: string;
  backupSize?: number;
  backupSha256?: string;
  failedStage?: string;
  version?: string;
}

let inMemoryProgress: UpdateProgress = { stage: "idle", message: "", percent: 0 };
let lastCheckResult: UpdateStatus | null = null;

function getDataDir() {
  return process.env.GOODJOB_DATA_DIR?.trim() || path.join(homedir(), ".goodjob-crm");
}

function updateConfigPath() {
  return process.env.GOODJOB_UPDATE_CONFIG_FILE?.trim() || path.join(getDataDir(), "config", "update-config.json");
}

function updateProgressPath() {
  return process.env.GOODJOB_UPDATE_PROGRESS_FILE?.trim() || path.join(getDataDir(), "updates", "progress.json");
}

function getAppDir() {
  return process.env.GOODJOB_APP_DIR?.trim() || path.resolve(process.cwd(), "..");
}

function getVersion() {
  try {
    const packagePath = path.join(getAppDir(), "package.json");
    if (existsSync(packagePath)) {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
      if (parsed.version) return parsed.version;
    }
  } catch {
    // Environment fallback keeps diagnostics available for an incomplete package.
  }
  return process.env.GOODJOB_APP_VERSION || "0.0.0";
}

function readJsonFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getMirrorUrl() {
  const configured = String(readJsonFile(updateConfigPath()).mirrorUrl || "").trim();
  return configured || process.env.GOODJOB_MIRROR_URL?.trim() || "";
}

function normalizeMirror(value: string) {
  const candidate = value.trim();
  if (!candidate) throw new Error("镜像源不能为空");
  if (/^https?:\/\//iu.test(candidate)) {
    const url = new URL(candidate);
    if (url.username || url.password || url.search || url.hash) throw new Error("镜像源不能包含账号、查询参数或片段");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("公网镜像源必须使用 HTTPS");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("镜像源只支持 HTTPS");
    return url.toString().replace(/\/+$/u, "");
  }
  if (process.platform !== "win32" || !path.win32.isAbsolute(candidate)) {
    throw new Error("镜像源应为 HTTPS URL，Windows 本地测试也可填写绝对目录");
  }
  return path.win32.normalize(candidate);
}

function manifestLocation(mirror: string) {
  return /^https?:\/\//iu.test(mirror)
    ? `${mirror.replace(/\/+$/u, "")}/manifest.json`
    : path.win32.join(mirror, "manifest.json");
}

function signatureLocation(mirror: string) {
  return /^https?:\/\//iu.test(mirror)
    ? `${mirror.replace(/\/+$/u, "")}/manifest.sig`
    : path.win32.join(mirror, "manifest.sig");
}

async function fetchResource(url: string, timeoutMs = 15_000, maxBytes = 1_048_576): Promise<Buffer> {
  if (!/^https?:\/\//iu.test(url)) {
    const value = readFileSync(url);
    if (value.byteLength > maxBytes) throw new Error("更新清单超过安全大小限制");
    return value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "GoodJob-CRM-Updater/2.0", Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) throw new Error("更新清单超过安全大小限制");
    const value = Buffer.from(await response.arrayBuffer());
    if (value.byteLength > maxBytes) throw new Error("更新清单超过安全大小限制");
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function loadVerifiedManifest(mirror: string) {
  const publicKeyPath = process.env.GOODJOB_UPDATE_PUBLIC_KEY?.trim();
  if (!publicKeyPath || !existsSync(publicKeyPath)) throw new Error("安装包缺少更新签名公钥，请重新安装完整便携包");
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchResource(manifestLocation(mirror)),
    fetchResource(signatureLocation(mirror), 15_000, 4096)
  ]);
  const signatureText = signatureBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signatureText)) throw new Error("manifest.sig 不是有效 Base64");
  const signature = Buffer.from(signatureText, "base64");
  if (!verifySignature(null, manifestBytes, readFileSync(publicKeyPath, "utf8"), signature)) {
    throw new Error("更新清单签名无效，已拒绝使用该镜像源");
  }
  return validateManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
}

function validateManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== "object") throw new Error("更新清单格式无效");
  const manifest = value as Partial<UpdateManifest>;
  if (manifest.packageFormatVersion !== 2) throw new Error("镜像源不是 Windows 完整更新包格式 v2");
  if (!manifest.latestVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.latestVersion)) {
    throw new Error("更新清单版本号无效");
  }
  if (!manifest.minimumVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.minimumVersion)) {
    throw new Error("更新清单最低兼容版本无效");
  }
  const release = manifest.releases?.[manifest.latestVersion];
  if (!release?.windows) throw new Error(`版本 ${manifest.latestVersion} 缺少 Windows x64 更新包`);
  if (release.databaseCompatibility !== "backward-compatible") {
    throw new Error("该版本没有声明数据库向后兼容，不能执行热更新");
  }
  if (!Number.isSafeInteger(release.windows.size) || release.windows.size < 1024 || release.windows.size > 1_610_612_736) {
    throw new Error("Windows 更新包大小无效");
  }
  if (!/^[a-f0-9]{64}$/iu.test(release.windows.sha256)) throw new Error("Windows 更新包 SHA256 无效");
  validateAssetUrl(release.windows.url);
  return manifest as UpdateManifest;
}

function validateAssetUrl(value: string) {
  const candidate = String(value || "").trim();
  if (!candidate) throw new Error("Windows 更新包地址为空");
  if (/^https?:\/\//iu.test(candidate)) {
    const url = new URL(candidate);
    if (url.username || url.password || url.hash) throw new Error("Windows 更新包地址不能包含账号或片段");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("公网更新包必须使用 HTTPS");
    }
    return;
  }
  const normalized = candidate.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Windows 更新包相对路径不安全");
  }
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const currentVersion = getVersion();
  const mirror = getMirrorUrl();
  if (!mirror) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      changelog: null,
      credits: null,
      lastChecked: null,
      error: "镜像源未配置。请填写 HTTPS 镜像地址后保存。"
    };
  }
  try {
    inMemoryProgress = { stage: "checking", message: "正在读取更新清单", percent: 0 };
    const normalized = normalizeMirror(mirror);
    const manifest = await loadVerifiedManifest(normalized);
    if (compareVersions(currentVersion, manifest.minimumVersion) < 0) {
      throw new Error(`当前版本 v${currentVersion} 低于热更新最低版本 v${manifest.minimumVersion}，请下载完整便携包升级`);
    }
    const release = manifest.releases[manifest.latestVersion]!;
    const result: UpdateStatus = {
      currentVersion,
      latestVersion: manifest.latestVersion,
      hasUpdate: compareVersions(manifest.latestVersion, currentVersion) > 0,
      changelog: release.changelog || null,
      credits: null,
      lastChecked: new Date().toISOString(),
      error: null
    };
    lastCheckResult = result;
    inMemoryProgress = { stage: "idle", message: "", percent: 0 };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    inMemoryProgress = { stage: "error", message, percent: 0 };
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      changelog: null,
      credits: null,
      lastChecked: new Date().toISOString(),
      error: message
    };
  }
}

export async function applyUpdate(): Promise<{ success: boolean; message: string }> {
  if (process.platform !== "win32") return { success: false, message: "一键热更新目前只在 Windows 便携版启用" };
  const mirror = getMirrorUrl();
  if (!mirror) return { success: false, message: "镜像源未配置" };
  const current = getUpdateProgress();
  if (!["idle", "done", "error"].includes(current.stage)) return { success: false, message: "已有更新任务正在进行" };
  const script = process.env.GOODJOB_UPDATER_SCRIPT?.trim();
  const packageRoot = process.env.GOODJOB_PACKAGE_ROOT?.trim();
  if (!script || !packageRoot || !existsSync(script)) return { success: false, message: "Windows 外部更新器不存在，请重新安装完整便携包" };

  mkdirSync(path.dirname(updateProgressPath()), { recursive: true });
  inMemoryProgress = { stage: "checking", message: "外部更新器正在启动", percent: 1, updatedAt: new Date().toISOString() };
  writeFileSync(updateProgressPath(), JSON.stringify(inMemoryProgress, null, 2));
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-PackageRoot", packageRoot,
    "-DataRoot", getDataDir(),
    "-Mirror", normalizeMirror(mirror)
  ], {
    detached: true,
    windowsHide: false,
    stdio: "ignore"
  });
  child.unref();
  return { success: true, message: "更新器已启动，将先备份并校验数据库" };
}

export function getUpdateProgress(): UpdateProgress {
  const file = updateProgressPath();
  if (!existsSync(file)) return inMemoryProgress;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as UpdateProgress;
    if (parsed && typeof parsed.stage === "string" && Number.isFinite(parsed.percent)) return parsed;
  } catch {
    // Keep the last in-memory progress if the atomic file is temporarily unavailable.
  }
  return inMemoryProgress;
}

export function getLastCheckResult() {
  return lastCheckResult;
}

export function setMirrorUrl(url: string) {
  const normalized = normalizeMirror(url);
  const file = updateConfigPath();
  const config = readJsonFile(file);
  config.mirrorUrl = normalized;
  config.channel = String(config.channel || "stable");
  config.lastUpdated = new Date().toISOString();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
}

export function getMirrorConfig() {
  return { mirrorUrl: getMirrorUrl(), currentVersion: getVersion() };
}

function compareVersions(a: string, b: string) {
  const [coreA, preA = ""] = a.split("-", 2);
  const [coreB, preB = ""] = b.split("-", 2);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (partsA[index] || 0) - (partsB[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  const identifiersA = preA.split(".");
  const identifiersB = preB.split(".");
  for (let index = 0; index < Math.max(identifiersA.length, identifiersB.length); index += 1) {
    if (index >= identifiersA.length) return -1;
    if (index >= identifiersB.length) return 1;
    const left = identifiersA[index]!;
    const right = identifiersB[index]!;
    if (left === right) continue;
    const leftNumeric = /^\d+$/u.test(left);
    const rightNumeric = /^\d+$/u.test(right);
    if (leftNumeric && rightNumeric) return Number(left) > Number(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
