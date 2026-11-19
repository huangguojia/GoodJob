import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import {
  SHARE_BLOCK_TEXT,
  asciiWatermarkFallback,
  buildWatermarkText,
  cjkFontCandidates,
  createShareToken,
  extractSfntFromCollection,
  hashSharePassword,
  resetWatermarkFontCache,
  shareBlockReason,
  shareCookieMatches,
  shareCookieName,
  shareCookieValue,
  sharePageHtml,
  verifySharePassword,
  watermarkPdf
} from "./file-share.js";
import type { ShareLinkRecord } from "./file-storage.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

const baseShare = (patch: Partial<ShareLinkRecord> = {}): ShareLinkRecord => ({
  id: "shr_test",
  token: "tok_abcdefghij",
  fileId: "file_test",
  createdBy: "u_1",
  teamId: "t_1",
  mode: "preview",
  passwordHash: "",
  expiresAt: "",
  maxViews: 0,
  viewCount: 0,
  watermarkText: "上海朋绎 · 2026-10-28",
  revokedAt: "",
  createdAt: new Date().toISOString(),
  ...patch
});

check("token 够长、URL 安全、不重复", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i += 1) {
    const token = createShareToken();
    assert.equal(token.length, 43, `实际长度 ${token.length}`);
    assert.match(token, /^[A-Za-z0-9_-]+$/u, "token 含 URL 不安全字符");
    assert.ok(!seen.has(token), "生成出重复 token");
    seen.add(token);
  }
});

check("密码哈希：正确通过、错误拒绝、不存明文", () => {
  const stored = hashSharePassword("GoodJob-2026");
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(!stored.includes("GoodJob-2026"), "哈希里不能出现明文密码");
  assert.equal(verifySharePassword("GoodJob-2026", stored), true);
  assert.equal(verifySharePassword("goodjob-2026", stored), false);
  assert.equal(verifySharePassword("", stored), false);
  // 空哈希 = 没设密码，谁拿到链接都能看
  assert.equal(verifySharePassword("随便", ""), true);
  // 格式坏了要拒绝而不是抛错（老数据/被改坏的行）
  assert.equal(verifySharePassword("x", "garbage"), false);
  assert.equal(verifySharePassword("x", "scrypt$onlytwo"), false);
  // 同一密码两次哈希必须不同（盐不同）
  assert.notEqual(hashSharePassword("GoodJob-2026"), stored);
});

check("shareBlockReason 四种状态", () => {
  assert.equal(shareBlockReason(baseShare()), "");
  assert.equal(shareBlockReason(baseShare({ revokedAt: new Date().toISOString() })), "revoked");
  assert.equal(shareBlockReason(baseShare({ expiresAt: new Date(Date.now() - 1000).toISOString() })), "expired");
  assert.equal(shareBlockReason(baseShare({ expiresAt: new Date(Date.now() + 60_000).toISOString() })), "");
  assert.equal(shareBlockReason(baseShare({ maxViews: 3, viewCount: 3 })), "exhausted");
  assert.equal(shareBlockReason(baseShare({ maxViews: 3, viewCount: 2 })), "");
  // maxViews=0 = 不限次数，不能算用尽
  assert.equal(shareBlockReason(baseShare({ maxViews: 0, viewCount: 999 })), "");
  assert.ok(SHARE_BLOCK_TEXT.expired.length > 0);
});

check("通行 cookie：值可重算、长度不同直接拒", () => {
  const share = baseShare({ passwordHash: hashSharePassword("pw") });
  const value = shareCookieValue(share);
  assert.equal(value.length, 32);
  assert.equal(shareCookieMatches(share, value), true);
  assert.equal(shareCookieMatches(share, `${value}x`), false);
  assert.equal(shareCookieMatches(share, ""), false);
  // 没设密码时不看 cookie
  assert.equal(shareCookieMatches(baseShare(), ""), true);
  assert.match(shareCookieName("abcdefghijklmn"), /^gj_sh_abcdefghij$/u);
});

check("水印文字含日期与可追溯编号", () => {
  const text = buildWatermarkText({ customerName: "上海朋绎机械", token: "abcdef123456", now: new Date("2026-10-28T08:00:00Z") });
  assert.match(text, /上海朋绎机械/u);
  assert.match(text, /2026-10-28/u);
  assert.match(text, /abcdef/u);
  // 客户名过长要截断，否则水印铺出去会盖满整页
  assert.ok(buildWatermarkText({ customerName: "长".repeat(80), token: "t" }).length <= 40);
  // 什么都不知道时也要有兜底，不能是空串
  assert.ok(buildWatermarkText({}).includes("GoodJob"));
});

check("分享页：拦截/密码/预览/下载四种形态", () => {
  const blocked = sharePageHtml({ title: "x", token: "t", watermark: "", fileName: "", mime: "", mode: "preview", behind: false, blockText: "该分享链接已过期" });
  assert.ok(blocked.includes("该分享链接已过期"));
  assert.ok(!blocked.includes("<iframe"), "链接失效时不该渲染 iframe");

  const locked = sharePageHtml({ title: "x", token: "t", watermark: "w", fileName: "a.pdf", mime: "application/pdf", mode: "preview", behind: false, needsPassword: true });
  assert.ok(locked.includes("<form"), "需要密码时必须给输入框");
  assert.ok(locked.includes("密码不正确") === false);

  const preview = sharePageHtml({ title: "x", token: "t", watermark: "上海朋绎 · 2026-10-28", fileName: "PI.pdf", mime: "application/pdf", mode: "preview", behind: false });
  assert.ok(preview.includes("<iframe"), "预览模式要有 iframe");
  assert.ok(preview.includes('class="wm"'), "预览模式必须有水印叠层");
  assert.ok(preview.includes("仅供查看"));
  assert.ok(!preview.includes("?download=1"), "预览模式不能给下载按钮");

  const download = sharePageHtml({ title: "x", token: "t", watermark: "w", fileName: "PI.pdf", mime: "application/pdf", mode: "download", behind: false });
  assert.ok(download.includes("?download=1"));
  // 下载模式的水印烧在文件里，页面不再叠层（否则双重水印）
  assert.ok(!download.includes('class="wm"'));

  // 文件名进入 HTML 必须转义：单证名字里有 < > 是真实存在的
  const escaped = sharePageHtml({ title: "x", token: "t", watermark: "w", fileName: '<img src=x onerror="alert(1)">.pdf', mime: "application/pdf", mode: "preview", behind: false });
  assert.ok(!escaped.includes("<img src=x"), "文件名没有转义，等于给了 XSS");
  assert.ok(escaped.includes("&lt;img"));
});

const makePdf = async (pages = 2) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`page ${i + 1}`, { x: 60, y: 700, size: 18 });
  }
  return Buffer.from(await doc.save());
};

const source = await makePdf(3);
const marked = await watermarkPdf(source, "上海朋绎机械 · 2026-10-28 · abcdef");
const markedDoc = await PDFDocument.load(marked);
assert.equal(markedDoc.getPageCount(), 3, "水印不能改变页数");
assert.ok(marked.length > source.length, "打了水印体积应该变大");
assert.notEqual(Buffer.compare(marked, source), 0, "输出必须真的变了");
// 再打一次仍然可解析（幂等性：重复水印不会把文件打坏）
const twice = await watermarkPdf(marked, "上海朋绎机械 · 2026-10-28 · abcdef");
assert.equal((await PDFDocument.load(twice)).getPageCount(), 3);
passed += 1;

// 纯英文走内置字体：机器上没有任何中文字体时也不能整条链路失败
const ascii = await watermarkPdf(source, "GoodJob 2026-10-28 abcdef");
assert.equal((await PDFDocument.load(ascii)).getPageCount(), 3);
passed += 1;

// 加密/损坏的 PDF：明确抛错，绝不返回未加水印的原件
await assert.rejects(() => watermarkPdf(Buffer.from("not a pdf at all"), "x"), /.*/u);
passed += 1;

check("没有中文字形时降级成 ASCII，不让下载整条链路 500", () => {
  // 客户名是中文、token 和日期是 ASCII：降级后仍保留「谁漏的、哪天漏的」这两条线索
  const fallback = asciiWatermarkFallback("上海朋绎机械 · 2026-10-28 · abcdef");
  assert.doesNotMatch(fallback, /[\u4e00-\u9fff]/u, "降级后不能残留中文，否则标准字体仍然编码不了");
  // 必须整串都是可打印 ASCII：塞控制字符（\u0000 之类）同样会让 WinAnsi 编码失败，
  // 只断言「没有中文」抓不到这种变异
  assert.match(fallback, /^[\x20-\x7e]+$/u, `降级结果必须是可打印 ASCII，实际 ${JSON.stringify(fallback)}`);
  assert.match(fallback, /2026-10-28/u);
  assert.match(fallback, /abcdef/u);
  // 整段中文剥完什么都不剩时，必须给一个能画出来的非空串
  assert.equal(asciiWatermarkFallback("上海朋绎机械"), "GoodJob");
});

check("TTC 集合拆包：重写 table 偏移，直接切片会得到坏字体", () => {
  // 合成一个最小 TTC：1 个字体、1 张表，表 offset 是**相对整个 TTC 文件**的绝对偏移。
  // 直接 slice 会把 44 这个绝对偏移原样留下，新文件里它就指向了文件外。
  const wide = Buffer.alloc(64);
  wide.write("ttcf", 0, "latin1");
  wide.writeUInt32BE(0x00010000, 4);
  wide.writeUInt32BE(1, 8);
  wide.writeUInt32BE(16, 12);
  wide.writeUInt32BE(0x00010000, 16);
  wide.writeUInt16BE(1, 20);
  wide.writeUInt16BE(16, 22);
  wide.writeUInt16BE(0, 24);
  wide.writeUInt16BE(0, 26);
  wide.write("head", 28, "latin1");
  wide.writeUInt32BE(0x11223344, 32);
  wide.writeUInt32BE(44, 36); // 表数据在原 TTC 里的绝对偏移
  wide.writeUInt32BE(4, 40);
  wide.writeUInt32BE(0x01020304, 44);
  wide.writeUInt32BE(0x05060708, 48);

  const sfnt = extractSfntFromCollection(wide);
  assert.ok(sfnt, "应该能拆出字体");
  assert.equal(sfnt.subarray(0, 4).toString("latin1"), "\u0000\u0001\u0000\u0000");
  assert.equal(sfnt.readUInt16BE(4), 1, "表数量要带过来");
  assert.equal(sfnt.subarray(12, 16).toString("latin1"), "head");
  // 新布局：12 字节头 + 16 字节目录 = 28 才开始放表数据
  assert.equal(sfnt.readUInt32BE(20), 28, "表 offset 必须重写成相对于新文件的偏移");
  assert.equal(sfnt.readUInt32BE(28), 0x01020304, "表内容要被搬过来");
  // 非 TTC 输入原样返回 null，由调用方继续试下一个候选
  assert.equal(extractSfntFromCollection(Buffer.from("not a font")), null);
  assert.equal(extractSfntFromCollection(wide, 3), null, "索引越界不能崩");
});

check("中文字体候选按平台给（Windows 必须有单文件 .ttf）", () => {
  const candidates = cjkFontCandidates();
  assert.ok(candidates.some((item) => item.endsWith(".ttf") || item.endsWith(".otf")),
    "候选里至少要有一个单文件字体，pdf-lib 嵌不了 ttc");
  if (process.platform === "darwin") {
    assert.ok(candidates.some((item) => item.includes("Arial Unicode")), "macOS 首选 Arial Unicode");
  }
  // Windows/Linux 的分支在本机跑不到，用源码结构守住：改坏了这里会红
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "file-share.ts"), "utf8");
  assert.match(source, /simhei\.ttf/u, "Windows 候选必须含 simhei.ttf（黑体是单文件）");
  assert.match(source, /DroidSansFallbackFull\.ttf/u, "Linux 候选必须含 Droid 单文件中文字体");
});

// 字体文件坏了 / 平台没有中文字体：必须降级成 ASCII 水印，不能让下载 500
{
  const bogus = path.join(os.tmpdir(), `gj-bogus-font-${process.pid}.ttf`);
  writeFileSync(bogus, Buffer.from("this is definitely not a font file"));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalFont = process.env.GOODJOB_WATERMARK_FONT;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: true });
  process.env.GOODJOB_WATERMARK_FONT = bogus;
  resetWatermarkFontCache();
  try {
    const degraded = await watermarkPdf(source, "上海朋绎机械 · 2026-10-28 · abcdef");
    assert.equal((await PDFDocument.load(degraded)).getPageCount(), 3, "字体不可用时页数不能变");
    assert.notEqual(Buffer.compare(degraded, source), 0, "仍然要真的打上水印（ASCII 版）");
  } finally {
    rmSync(bogus, { force: true });
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    if (originalFont === undefined) delete process.env.GOODJOB_WATERMARK_FONT;
    else process.env.GOODJOB_WATERMARK_FONT = originalFont;
    // 缓存里现在是「垃圾字体」的失败状态，必须清掉，否则后面所有用例都走降级
    resetWatermarkFontCache();
  }
  passed += 1;
}

// 真实 ttc 端到端：拆包后必须能被 pdf-lib 嵌进去并画出中文（只有 macOS 有系统 ttc）
const realTtc = "/System/Library/Fonts/Hiragino Sans GB.ttc";
if (existsSync(realTtc)) {
  const sfnt = extractSfntFromCollection(readFileSync(realTtc));
  assert.ok(sfnt, "真实 ttc 应该能拆出字体");
  const doc = await PDFDocument.create();
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(sfnt, { subset: true });
  const page = doc.addPage([200, 100]);
  page.drawText("上海朋绎 测试", { x: 10, y: 40, size: 12, font });
  assert.ok((await doc.save()).length > 0, "拆包后的字体要能真的画出中文");
  passed += 1;
}

console.log(`file-share-test: ${passed} 项通过`);
