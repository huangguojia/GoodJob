/**
 * 发信副本归档到「已发送」。
 *
 * 背景（2026-09-29 实测）：腾讯企业邮等服务的「已发送」只有在**网页端勾选了
 * 「保存已发送至服务器」**后，才会保存 SMTP 客户端投递的邮件。未勾选时，CRM 明明
 * 发出去了（台账 `sent`、无退信），用户在自己邮箱的「已发送」里却一封都看不到。
 * 这里由 CRM 自己补这一步：发信成功后，用 IMAP APPEND 把**同一封原始 MIME**写进
 * 发件账号邮箱的「已发送」文件夹。
 *
 * 设计约束：
 * - **best-effort**：任何失败只返回错误信息，绝不抛出、绝不影响发信结果（信已经发出去了）。
 * - ⚠️ **必须挂 `error` 监听**：`ImapFlow` 是 EventEmitter，未处理的 `'error'` 事件会
 *   **直接杀掉整个 Node 进程**。2026-09-29 开发档位后端就被一次套接字空闲超时打崩过
 *   （`Unhandled 'error' event` / `ETIMEOUT`）。
 * - ⚠️ **空闲关闭必须早于 socketTimeout**：否则连接会在被我们关掉之前先触发超时错误。
 * - **不新增数据库字段**：优先用 `users.imap_*`；为空时从 `smtp_host` 推导
 *   （`smtp.exmail.qq.com` → `imap.exmail.qq.com`）。密码优先 `imap_password`，
 *   没有则复用 `smtp_password`（实测腾讯企业邮同一串授权码可同时登 SMTP 与 IMAP）。
 * - **连续失败要退避**：邮箱侧不可用时不能拖慢每一封信的发送。
 * - 可用环境变量 `OUTBOUND_EMAIL_ARCHIVE_TO_SENT=false` 整体关闭；test/e2e 环境自动关闭。
 */
import { ImapFlow } from "imapflow";

export interface SentFolderArchiveUser {
  id: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUser?: string;
  imapPassword?: string;
  smtpHost?: string;
  smtpUser?: string;
  smtpPassword?: string;
}

export interface SentFolderTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** true = 主机名是从 smtp_host 推导出来的，用户没有单独配 IMAP */
  derived: boolean;
}

export interface SentFolderArchiveResult {
  ok: boolean;
  /** true = 主动跳过（配置关闭，或刚失败过、正在退避），不算异常 */
  skipped?: boolean;
  folder?: string;
  /** 补充说明（例如"服务端已自行保存"），失败时为原因 */
  note?: string;
  error?: string;
}

export interface MailboxLike {
  path: string;
  specialUse?: string;
}

/** 连接空闲多久后主动关闭。必须明显小于 socketTimeout，否则会先触发超时错误。 */
const CONNECTION_IDLE_MS = 45_000;
/** IMAP 套接字空闲超时（比上面的主动关闭宽松得多，只用于兜底）。 */
const SOCKET_TIMEOUT_MS = 300_000;
/** 单次归档的总超时：不能让邮箱侧的问题拖慢发信。 */
const ARCHIVE_TIMEOUT_MS = 12_000;
/** 失败后多久内不再重试（避免每封信都卡一次超时）。 */
const FAILURE_BACKOFF_MS = 5 * 60_000;

interface PooledConnection {
  client: ImapFlow;
  folderPath: string;
  idleTimer: NodeJS.Timeout | null;
}

const pool = new Map<string, PooledConnection>();
/** 被调用方超时放弃、但底层仍在连接中的 key：连上后立刻关掉，不留孤儿连接。 */
const abandoned = new Set<string>();
/** key → 退避截止时间戳 */
const backoffUntil = new Map<string, number>();
/**
 * key → 确认「邮箱服务端自己会保存已发送」的时间。
 * 腾讯企业邮开启「保存已发送至服务器」后，IMAP APPEND 会被拒（`Mail has saved by smtp!`）——
 * 那不是错误，而是"已经存过了，别重复写"。记下来后这段时间内就不必再白跑一趟 IMAP。
 */
const serverSavesItself = new Map<string, number>();
const SERVER_SAVES_RECHECK_MS = 30 * 60_000;

/**
 * 判断 IMAP 的拒绝是否属于「服务端已经保存过这封信」。
 * 腾讯企业邮的原文是 `Mail has saved by smtp!`：开启「保存已发送至服务器」后，
 * 邮件已由 SMTP 侧落库，客户端再 APPEND 会因重复而冲突被拒——目的其实已达成。
 */
export function isAlreadySavedByServer(error: unknown) {
  const source = (error || {}) as { message?: unknown; response?: unknown; responseText?: unknown };
  return [error, source.message, source.response, source.responseText]
    .map((value) => (typeof value === "string" ? value : ""))
    .some((text) => /has saved by smtp/i.test(text));
}

/** 是否启用发信归档。默认开启；测试环境与显式关闭时不启用。 */
export function sentFolderArchiveEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (["test", "e2e"].includes(env.NODE_ENV || "")) return false;
  const raw = (env.OUTBOUND_EMAIL_ARCHIVE_TO_SENT || "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

/**
 * 从 SMTP 主机名推导 IMAP 主机名。
 * 只认「smtp 作为独立标签」这一种规律（`smtp.x` / `x.smtp.y`），推不出来就返回空串——
 * 宁可不归档，也不去猜一个可能错的主机（猜错会连错服务器、还可能触发登录风控）。
 */
export function deriveImapHostFromSmtpHost(smtpHost: string) {
  const host = (smtpHost || "").trim().toLowerCase();
  if (!host || host.includes(" ")) return "";
  const labels = host.split(".");
  const index = labels.indexOf("smtp");
  if (index < 0) return "";
  labels[index] = "imap";
  return labels.join(".");
}

/** 解析出归档要用的 IMAP 账号；缺少主机或凭据时返回 null。 */
export function resolveSentFolderTarget(user: SentFolderArchiveUser): SentFolderTarget | null {
  const explicitHost = (user.imapHost || "").trim();
  const derivedHost = explicitHost ? "" : deriveImapHostFromSmtpHost(user.smtpHost || "");
  const host = explicitHost || derivedHost;
  if (!host) return null;

  const account = (user.imapUser || "").trim() || (user.smtpUser || "").trim();
  const password = (user.imapPassword || "").trim() || (user.smtpPassword || "").trim();
  if (!account || !password) return null;

  return {
    host,
    port: Number(user.imapPort) || 993,
    secure: user.imapSecure ?? true,
    user: account,
    password,
    derived: !explicitHost
  };
}

/** 供界面/日志用的脱敏描述（绝不回显密码）。 */
export function describeSentFolderTarget(target: SentFolderTarget | null) {
  if (!target) return "未配置可用的 IMAP 账号";
  return `${target.user} @ ${target.host}:${target.port}${target.secure ? " (SSL)" : ""}${target.derived ? " · 由 SMTP 配置推导" : ""}`;
}

/**
 * 从文件夹列表里挑「已发送」。优先看 IMAP 的 \Sent 特殊用途标记
 * （腾讯企业邮的 path 是 `Sent Messages`），标记缺失时再按名称兜底。
 */
export function pickSentFolderPath(boxes: MailboxLike[]) {
  const bySpecialUse = boxes.find((box) => (box.specialUse || "").trim().toLowerCase() === "\\sent");
  if (bySpecialUse) return bySpecialUse.path;

  const exact = boxes.find((box) => /^(sent|sent messages|sent items|已发送|已发送邮件)$/i.test(box.path.trim()));
  if (exact) return exact.path;

  const loose = boxes.find((box) => /sent|已发送/i.test(box.path));
  return loose ? loose.path : "";
}

/** 排查归档行为时的开关：OUTBOUND_EMAIL_ARCHIVE_DEBUG=true 会打印每条成功路径。 */
function debugLog(message: string) {
  const raw = (process.env.OUTBOUND_EMAIL_ARCHIVE_DEBUG || "").trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(raw)) console.info(`[outbound-email] ${message}`);
}

/** 创建一个「不会把进程搞崩」的 IMAP 客户端。 */
function createArchiveClient(target: SentFolderTarget) {
  const client = new ImapFlow({
    host: target.host,
    port: target.port,
    secure: target.secure,
    auth: { user: target.user, pass: target.password },
    logger: false,
    emitLogs: false,
    greetingTimeout: 15_000,
    socketTimeout: SOCKET_TIMEOUT_MS
  });
  // ⚠️ 这一行是保命的：没有 error 监听时，一次套接字超时就能让整个后端进程退出。
  client.on("error", (error: unknown) => {
    console.warn(`[outbound-email] 邮箱连接异常（已忽略，不影响发信）：${error instanceof Error ? error.message : String(error)}`);
  });
  return client;
}

function touchConnection(key: string) {
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => { void dropConnection(key); }, CONNECTION_IDLE_MS);
  entry.idleTimer.unref?.();
}

async function dropConnection(key: string) {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  await entry.client.logout().catch(() => undefined);
}

async function ensureConnection(key: string, target: SentFolderTarget): Promise<PooledConnection> {
  const existing = pool.get(key);
  if (existing && existing.client.usable) {
    touchConnection(key);
    return existing;
  }
  if (existing) await dropConnection(key);

  const client = createArchiveClient(target);
  try {
    await client.connect();
    const boxes = await client.list();
    const folderPath = pickSentFolderPath(
      boxes.map((box) => ({ path: box.path, specialUse: String(box.specialUse || "") }))
    );
    if (!folderPath) throw new Error("邮箱里找不到「已发送」文件夹");

    // 调用方已经超时放弃了：连上也别留着，直接关掉。
    if (abandoned.delete(key)) {
      await client.logout().catch(() => undefined);
      throw new Error("归档已超时放弃");
    }

    const entry: PooledConnection = { client, folderPath, idleTimer: null };
    pool.set(key, entry);
    touchConnection(key);
    return entry;
  } catch (error) {
    await client.logout().catch(() => undefined);
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * 把一封已发出的邮件副本写入「已发送」。
 * **永不抛出**：失败只体现在返回值里，调用方无需 try/catch。
 */
export async function archiveMessageToSentFolder(
  user: SentFolderArchiveUser,
  raw: Buffer | string,
  options: { date?: Date; flags?: string[] } = {}
): Promise<SentFolderArchiveResult> {
  if (!sentFolderArchiveEnabled()) {
    debugLog("未归档：开关关闭（NODE_ENV 为 test/e2e，或 OUTBOUND_EMAIL_ARCHIVE_TO_SENT 显式关闭）");
    return { ok: false, skipped: true };
  }
  const target = resolveSentFolderTarget(user);
  if (!target) {
    debugLog(`未归档：解析不出 IMAP 账号（smtpHost=${user.smtpHost ? "有" : "空"}，账号=${user.smtpUser ? "有" : "空"}，密码=${user.smtpPassword ? "有" : "空"}）`);
    return { ok: false, skipped: true, error: "没有可用的 IMAP 账号，无法归档到已发送" };
  }

  const key = `${user.id}|${target.host}|${target.user}`;
  const until = backoffUntil.get(key) || 0;
  if (Date.now() < until) {
    return { ok: false, skipped: true, error: `邮箱侧刚失败过，${Math.ceil((until - Date.now()) / 1000)} 秒内不再重试` };
  }
  // 已知该邮箱服务端自己会保存已发送：直接让路，连 IMAP 都不必连。
  const selfSaveAt = serverSavesItself.get(key) || 0;
  if (Date.now() - selfSaveAt < SERVER_SAVES_RECHECK_MS) {
    return { ok: false, skipped: true, error: "邮箱服务端已开启「保存已发送至服务器」，无需客户端补写" };
  }

  try {
    const entry = await withTimeout(ensureConnection(key, target), ARCHIVE_TIMEOUT_MS, "连接邮箱超时");
    await withTimeout(
      entry.client.append(entry.folderPath, raw, options.flags ?? ["\\Seen"], options.date ?? new Date()),
      ARCHIVE_TIMEOUT_MS,
      "写入已发送超时"
    );
    touchConnection(key);
    backoffUntil.delete(key);
    debugLog(`${target.user} 副本已写入「${entry.folderPath}」`);
    return { ok: true, folder: entry.folderPath };
  } catch (error) {
    /**
     * 「服务端已保存过」要当成**成功**：邮箱里本来就有这封信，客户端无需再写。
     * 只有真正的问题（超时、认证失败、找不到文件夹）才退避重试。
     */
    if (isAlreadySavedByServer(error)) {
      const firstTime = !serverSavesItself.has(key);
      serverSavesItself.set(key, Date.now());
      touchConnection(key);
      backoffUntil.delete(key);
      if (firstTime) {
        console.info(`[outbound-email] ${target.user} 的邮箱已开启「保存已发送至服务器」，服务端会自行留存副本，CRM 侧归档让路。`);
      }
      return { ok: true, note: "邮箱服务端已自行保存，客户端无需补写" };
    }
    // 标记放弃，防止底层连接稍后连上后变成没人管的孤儿连接
    abandoned.add(key);
    await dropConnection(key);
    backoffUntil.set(key, Date.now() + FAILURE_BACKOFF_MS);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 关闭全部缓存连接（进程退出、测试收尾时用）。 */
export async function closeSentFolderConnections() {
  await Promise.all([...pool.keys()].map((key) => dropConnection(key)));
}
