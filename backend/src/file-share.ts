import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { ShareLinkRecord } from "./file-storage.js";

// ---------------------------------------------------------------------------
// 分享链接 + 水印（M3）
//
// 两条设计原则：
// 1. 水印优先「不烧」：预览走 HTML 叠加层，中文没有字体风险，也不改动原件。
//    只有「允许下载」时才会把水印烧进 PDF —— 因为那个文件会离开我们的服务器。
// 2. 分享是「另开一条口子」，权限判定不经过 evaluateFileAccess（访问者没有账号），
//    但可用的前提完全相同：文件必须 active、分享必须未撤销未过期未超次数。
// ---------------------------------------------------------------------------

/** 32 字节随机 token，base64url 后 43 字符，够防枚举且能放进 URL */
export function createShareToken(): string {
  return randomBytes(32).toString("base64url");
}

const SCRYPT_PREFIX = "scrypt";

export function hashSharePassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password.normalize("NFKC"), salt, 32).toString("hex");
  return `${SCRYPT_PREFIX}$${salt}$${hash}`;
}

export function verifySharePassword(password: string, stored: string): boolean {
  if (!stored) return true; // 没设密码 = 谁拿到链接都能看
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) return false;
  try {
    const derived = scryptSync(password.normalize("NFKC"), parts[1], 32);
    const expected = Buffer.from(parts[2], "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 密码通过后下的通行 cookie：值由 hash+token 派生，服务端可重算，不需要额外密钥 */
export function shareCookieName(token: string) {
  return `gj_sh_${token.slice(0, 10)}`;
}

export function shareCookieValue(share: ShareLinkRecord) {
  return createHash("sha256").update(`${share.passwordHash}|${share.token}`).digest("hex").slice(0, 32);
}

export function shareCookieMatches(share: ShareLinkRecord, value: string) {
  if (!share.passwordHash) return true;
  const expected = shareCookieValue(share);
  if (value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export type ShareBlockReason = "revoked" | "expired" | "exhausted" | "";

/** 分享能不能用；返回空串 = 可用 */
export function shareBlockReason(share: ShareLinkRecord, now = new Date()): ShareBlockReason {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt) {
    const at = new Date(share.expiresAt).getTime();
    if (Number.isFinite(at) && at <= now.getTime()) return "expired";
  }
  if (share.maxViews > 0 && share.viewCount >= share.maxViews) return "exhausted";
  return "";
}

export const SHARE_BLOCK_TEXT: Record<Exclude<ShareBlockReason, "">, string> = {
  revoked: "该分享链接已被撤销",
  expired: "该分享链接已过期",
  exhausted: "该分享链接的查看次数已用完"
};

/**
 * 水印文字：客户名 + 日期 + 分享编号。
 * 编号是给「截图外流后倒查是谁」用的 —— 没有它，水印只是一层灰字。
 */
export function buildWatermarkText(input: { customerName?: string; sharerName?: string; token?: string; now?: Date }) {
  const date = (input.now || new Date()).toISOString().slice(0, 10);
  const who = String(input.customerName || input.sharerName || "GoodJob").slice(0, 20);
  const mark = String(input.token || "").slice(0, 6);
  return mark ? `${who} · ${date} · ${mark}` : `${who} · ${date}`;
}

/**
 * 水印用的中文字体候选（按平台）。
 *
 * 关键约束：pdf-lib 只能嵌入**单个 sfnt**，`.ttc` 字体集合会抛
 * `font.createSubset is not a function`。所以候选里优先单文件 .ttf/.otf；
 * Windows 上 `simhei.ttf`（黑体）就是单文件，`msyh.ttc`/`simsun.ttc` 要走下面的集合拆包。
 */
export function cjkFontCandidates(): string[] {
  const configured = String(process.env.GOODJOB_WATERMARK_FONT || "").trim();
  const list = [configured];
  if (process.platform === "win32") {
    const windir = String(process.env.WINDIR || "C:\\Windows");
    const fonts = `${windir}\\Fonts`;
    list.push(`${fonts}\\simhei.ttf`, `${fonts}\\Deng.ttf`, `${fonts}\\msyh.ttc`, `${fonts}\\simsun.ttc`, `${fonts}\\simkai.ttf`);
    return list;
  }
  if (process.platform === "darwin") {
    list.push(
      "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
      "/Library/Fonts/Arial Unicode.ttf",
      "/System/Library/Fonts/Hiragino Sans GB.ttc",
      "/System/Library/Fonts/STHeiti Light.ttc",
      "/System/Library/Fonts/Supplemental/Songti.ttc"
    );
    return list;
  }
  list.push(
    // 容器里唯一常见的**单文件**中文字体（Debian: fonts-droid-fallback）
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc"
  );
  return list;
}

/**
 * 从 TTC（TrueType Collection）里抽出第 index 个字体，重排成独立 sfnt。
 *
 * 为什么不能直接按 offset 切片：TTC 里各表的 offset 是**相对整个 TTC 文件**的绝对偏移，
 * 直接切出来的字节里 table 指针全错，fontkit 会解析失败。所以必须重写 table directory。
 * 只要搬字节、不改表内容，表级 checksum 不变，无需重算。
 */
export function extractSfntFromCollection(buffer: Buffer, index = 0): Buffer | null {
  if (buffer.length < 16 || buffer.toString("latin1", 0, 4) !== "ttcf") return null;
  const numFonts = buffer.readUInt32BE(8);
  if (!numFonts || index >= numFonts) return null;
  const base = buffer.readUInt32BE(12 + index * 4);
  if (base + 12 > buffer.length) return null;
  const numTables = buffer.readUInt16BE(base + 4);
  if (!numTables || base + 12 + numTables * 16 > buffer.length) return null;

  const entries = [] as Array<{ tag: string; checksum: number; offset: number; length: number }>;
  for (let i = 0; i < numTables; i += 1) {
    const at = base + 12 + i * 16;
    entries.push({
      tag: buffer.toString("latin1", at, at + 4),
      checksum: buffer.readUInt32BE(at + 4),
      offset: buffer.readUInt32BE(at + 8),
      length: buffer.readUInt32BE(at + 12)
    });
  }
  // 表数据一律 4 字节对齐，否则有些解析器（含 macOS CoreText）会拒绝
  const headerSize = 12 + numTables * 16;
  const positions: number[] = [];
  let cursor = headerSize;
  for (const entry of entries) {
    positions.push(cursor);
    cursor += entry.length;
    cursor += (4 - (cursor % 4)) % 4;
  }
  const out = Buffer.alloc(cursor);
  buffer.copy(out, 0, base, base + 12);
  entries.forEach((entry, i) => {
    if (entry.offset + entry.length > buffer.length) throw new Error("TTC 表越界");
    const at = 12 + i * 16;
    out.write(entry.tag, at, 4, "latin1");
    out.writeUInt32BE(entry.checksum, at + 4);
    out.writeUInt32BE(positions[i], at + 8);
    out.writeUInt32BE(entry.length, at + 12);
    buffer.copy(out, positions[i], entry.offset, entry.offset + entry.length);
  });
  return out;
}

let cjkFontCache: Buffer | null | undefined;
let cjkFontSource = "";

/** 中文字体只读一次；找不到就退回内置 Helvetica（只能画 ASCII） */
async function loadCjkFont(): Promise<Buffer | null> {
  if (cjkFontCache !== undefined) return cjkFontCache;
  for (const candidate of cjkFontCandidates()) {
    try {
      if (!candidate || !existsSync(candidate)) continue;
      const raw = await readFile(candidate);
      // .ttc 一律拆成单字体再交给 pdf-lib；拆不出来就换下一个候选
      const font = raw.toString("latin1", 0, 4) === "ttcf" ? extractSfntFromCollection(raw) : raw;
      if (!font) continue;
      cjkFontCache = font;
      cjkFontSource = candidate;
      return cjkFontCache;
    } catch {
      continue;
    }
  }
  cjkFontCache = null;
  cjkFontSource = "";
  return null;
}

/** 当前水印字体来源（设置页/诊断用）；空串 = 只能画 ASCII */
/**
 * 丢掉字体缓存，下次打水印重新挑字体。
 * 运维换字体后不必重启进程；测试也靠它验证「字体不可用时的降级路径」。
 */
export function resetWatermarkFontCache() {
  cjkFontCache = undefined;
  cjkFontSource = "";
}

function hasCjk(text: string) {
  return /[\u2e80-\u9fff\uf900-\ufaff]/u.test(text);
}

/**
 * 没有中文字形时的降级文案：只留 ASCII（客户名多半是英文公司名，
 * token 前 6 位和日期本来就是 ASCII，倒查能力不丢），只把中文段去掉。
 */
export function asciiWatermarkFallback(text: string, fallback = "GoodJob") {
  const cleaned = String(text || "")
    .replace(/[^\x20-\x7e]+/gu, " ")
    .replace(/\s*·\s*/gu, " · ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  const visible = cleaned.replace(/[^\x21-\x7e]/gu, "");
  return visible.length >= 3 ? cleaned : fallback;
}

/**
 * 给 PDF 打水印（斜向平铺 + 中间一行大字）。
 * 这个函数是「允许下载」链路上唯一会重写文件字节的地方，失败必须抛错而不是静默返回原件。
 *
 * 唯一的例外是字体：找不到中文字体时降级成 ASCII 水印，不能把整次下载打成 500。
 * Linux/Windows 上「系统没装中文字体」是常见状态，而不是异常。
 */
export async function watermarkPdf(buffer: Buffer, text: string): Promise<Buffer> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const cjkFont = await loadCjkFont();
  let font;
  let content = text;
  if (hasCjk(text) && cjkFont) {
    try {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(cjkFont, { subset: true });
    } catch (error) {
      // 字体文件损坏 / 子集化不支持（历史上 ttc 就栽在这里）——降级继续
      console.error(`[file-share] 水印字体嵌入失败，改用 ASCII：${error instanceof Error ? error.message : error}`);
      font = undefined;
    }
  }
  if (!font) {
    content = hasCjk(text) ? asciiWatermarkFallback(text) : text;
    font = await doc.embedFont(StandardFonts.Helvetica);
  }
  const color = rgb(0.62, 0.66, 0.72);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(12, Math.min(26, Math.round(width / 26)));
    // 平铺：斜向铺满，保证裁掉一角仍然带水印
    for (let row = -1; row * 120 < height + 120; row += 1) {
      for (let col = -1; col * 260 < width + 260; col += 1) {
        page.drawText(content, {
          x: col * 260 + (row % 2 === 0 ? 0 : 130),
          y: height - row * 120,
          size,
          font,
          color,
          opacity: 0.18,
          rotate: degrees(28)
        });
      }
    }
    page.drawText(content, {
      x: Math.max(24, width / 2 - content.length * 6),
      y: height / 2,
      size: Math.max(18, Math.round(width / 22)),
      font,
      color,
      opacity: 0.12,
      rotate: degrees(28)
    });
  }
  const out = await doc.save();
  return Buffer.from(out);
}

/** 分享页 HTML：自带水印层；预览模式下 watermarked=true 时叠一层，下载模式则由服务端烧进文件 */
export function sharePageHtml(input: {
  title: string;
  token: string;
  watermark: string;
  fileName: string;
  mime: string;
  mode: "preview" | "download";
  behind: boolean;
  needsPassword?: boolean;
  passwordError?: string;
  blockText?: string;
  remainingViews?: number;
}) {
  const esc = (value: string) =>
    String(value).replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
  const watermarkLayer = input.mode === "preview" && !input.behind
    ? `<div class="wm">${Array.from({ length: 18 }, () => `<span>${esc(input.watermark)}</span>`).join("")}</div>`
    : "";
  const body = input.blockText
    ? `<div class="card"><div class="ico">!</div><h1>${esc(input.blockText)}</h1><p>请联系发送方重新获取链接。</p></div>`
    : input.needsPassword
      ? `<div class="card">
           <div class="ico">🔒</div>
           <h1>需要密码</h1>
           <p>该文件由发送方设置了访问密码。</p>
           <form method="POST" action="/api/share/${esc(input.token)}/unlock">
             <input type="password" name="password" placeholder="请输入访问密码" autofocus required />
             ${input.passwordError ? `<div class="err">${esc(input.passwordError)}</div>` : ""}
             <button type="submit">查看文件</button>
           </form>
         </div>`
      : `<div class="viewer">
           <iframe src="/api/share/${esc(input.token)}/content" title="${esc(input.fileName)}"></iframe>
           ${watermarkLayer}
         </div>
         <div class="bar">
           <span class="name">${esc(input.fileName)}</span>
           ${input.mode === "download" ? `<a class="dl" href="/api/share/${esc(input.token)}/content?download=1">下载</a>` : `<span class="hint">仅供查看</span>`}
           ${input.remainingViews != null && input.remainingViews > 0 ? `<span class="hint">剩余 ${input.remainingViews} 次</span>` : ""}
         </div>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${esc(input.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
         background:#eef2f7; color:#16233a; display:flex; flex-direction:column; }
  .viewer { position:relative; flex:1; min-height:0; margin:16px; border-radius:12px; overflow:hidden;
            background:#fff; box-shadow:0 10px 30px -18px rgba(22,35,58,.5); }
  .viewer iframe { width:100%; height:calc(100vh - 108px); border:0; display:block; background:#fff; }
  .wm { position:absolute; inset:0; pointer-events:none; overflow:hidden; display:flex; flex-wrap:wrap;
        align-content:space-around; justify-content:space-around; gap:48px; padding:24px; }
  .wm span { font-size:15px; color:rgba(22,35,58,.16); transform:rotate(-24deg); white-space:nowrap; user-select:none; }
  .bar { display:flex; align-items:center; gap:14px; padding:0 18px 14px; font-size:13px; color:#63758c; }
  .bar .name { font-weight:600; color:#16233a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar .hint { color:#8798ad; }
  .bar .dl { margin-left:auto; background:#16233a; color:#fff; text-decoration:none; padding:7px 16px; border-radius:6px; font-size:13px; }
  .card { margin:auto; background:#fff; padding:36px 32px; border-radius:14px; text-align:center; width:min(420px,calc(100vw - 40px));
          box-shadow:0 14px 40px -22px rgba(22,35,58,.55); }
  .card .ico { width:44px; height:44px; margin:0 auto 12px; border-radius:50%; background:#eef2f7; color:#63758c;
               display:flex; align-items:center; justify-content:center; font-size:20px; }
  .card h1 { font-size:17px; margin:0 0 8px; }
  .card p { margin:0 0 18px; color:#63758c; font-size:13px; }
  .card input { width:100%; height:38px; padding:0 12px; border:1px solid #d5dfeb; border-radius:6px; font-size:14px; }
  .card button { width:100%; height:38px; margin-top:12px; border:0; border-radius:6px; background:#16233a; color:#fff; font-size:14px; cursor:pointer; }
  .card .err { color:#b42318; font-size:12px; margin-top:8px; }
</style></head>
<body>${body}</body></html>`;
}
