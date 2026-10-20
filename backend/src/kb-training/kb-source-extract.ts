import { strFromU8, unzipSync } from "fflate";

import { KbSourceExtractError } from "./kb-source-error.js";
import { KB_PDF_OCR_MAX_PAGES, ocrPdfPages } from "./pdf-ocr.js";

export { KbSourceExtractError } from "./kb-source-error.js";

// ---------------------------------------------------------------------------
// 资料正文抽取：把 PDF / Word / 文本读成「可分段的一整段正文」。
//
// 为什么需要它：训练页原先只收 .txt / .md —— 用户手里的产品手册、报价单、条款
// 几乎全是 PDF / Word，于是「资料训练」在真实资料面前等于不能用（只能先手工转格式）。
// 文件中心只存链接与说明，不提供正文；所以抽取必须发生在**训练入口**这一层。
//
// 三条纪律：
//  1. 只做抽取，不做理解：不猜客户字段、不改写内容，原文怎么排就怎么输出；
//  2. 抽取不干净要**说出来**（扫描件 0 字、页数超限），不能静默返回半份正文；
//  3. 扩展名与真实字节都要校验：改后缀骗过白名单的文件会在解析器里炸，
//     报出来的错会是「Unexpected token」这种用户看不懂的东西。
// ---------------------------------------------------------------------------

/** 单份资料的体积上限。与客户资料识别保持一致，避免出现「那边能传这边不能」。 */
export const KB_SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** 正文上限：超出部分直接截断并告知（200 万字符 ≈ 数百页，远超一次训练的处理能力）。 */
export const KB_SOURCE_MAX_CHARS = 2_000_000;
/** PDF 最多读多少页：再多的资料应该拆成多份，一次读 800 页只会把批次拖死。 */
const PDF_MAX_PAGES = 200;

export interface KbExtractedSource {
  title: string;
  body: string;
  /** 抽取过程中的事实（截断 / 跳过 / 无文字层），界面上要原样展示。 */
  warnings: string[];
  /** 抽取到的正文长度（截断前），用来判断「这份资料到底有没有内容」。 */
  chars: number;
}

export function kbSourceKind(fileName: string): "pdf" | "docx" | "text" | "" {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] || "";
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (["txt", "md", "markdown", "csv", "tsv", "json"].includes(extension)) return "text";
  return "";
}

/**
 * 康熙部首（U+2F00-2FDF）与 CJK 部首补充（U+2E80-2EFF）是「长得像汉字」的另一个码位。
 * 不少中文 PDF 的内嵌字体把汉字映射到这一段，抽出来是 ⼿/⼩/⾯/⾊ 而不是 手/小/面/色：
 * 视觉上一模一样，码位上却是两个字 —— 训成语料后按字面匹配永远命中不了
 * （客户问「最小起订量」永远搜不到语料里的「最 ⼩ 起订量」），而且肉眼审不出来。
 * 只对这一段做兼容分解（NFKC），不用整体 NFKC —— 那会把 ①②③、㎡、℃ 一起改掉，
 * 属于对原文的额外改写，不在本轮要修的范围内。
 */
const RADICAL_BLOCK = /[\u2E80-\u2FDF]/gu;

function foldRadicals(raw: string): string {
  return raw.replace(RADICAL_BLOCK, (char) => char.normalize("NFKC"));
}

/**
 * 两个汉字之间的空白（PDF 逐字定位的副产物）不是原文内容，必须删掉。
 * 典型症状：抽出来是「问：最 小 起订量是多少」——字形对了，但中间多了空格，
 * 语料里就再也匹配不上客户问的「最小起订量」。英文单词之间的空格保留。
 */
const CJK_GAP = /(?<=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])[ \t]+(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/gu;

/** 去掉 BOM、统一行尾、折叠 3 个以上空行 —— 分段器按空行切段，多余空行会造成空段。 */
function normalizeText(raw: string): string {
  return foldRadicals(raw)
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(CJK_GAP, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** 一页算「没有文字层」的门槛：少于这个数（忽略空白）就认为该页是图。 */
export const KB_PDF_BARE_PAGE_CHARS = 12;

/**
 * 从逐页正文里挑出需要 OCR 的页。
 * 全篇都是空页 → 送全部（`targets` 为 undefined，由 OCR 端按上限截断）；
 * 只有部分页空 → 只送这些页（混合型 PDF 里文字页不该被重复识别，既慢又可能改字）。
 */
export function planPdfOcr(pageTexts: string[]): { targets?: number[]; scanned: boolean } | null {
  const bare = pageTexts
    .map((text, index) => (text.replace(/\s+/gu, "").length < KB_PDF_BARE_PAGE_CHARS ? index : -1))
    .filter((index) => index >= 0);
  if (!bare.length) return null;
  const scanned = bare.length === pageTexts.length;
  return { targets: scanned ? undefined : bare.slice(0, KB_PDF_OCR_MAX_PAGES), scanned };
}

/** 把 OCR 结果合并回逐页正文：只填空页，已有文字层的页一个字都不动。返回补上的页数。 */
export function applyOcrPages(pageTexts: string[], ocrPages: string[]): number {
  let filled = 0;
  for (let index = 0; index < pageTexts.length; index += 1) {
    const current = pageTexts[index].replace(/\s+/gu, "");
    if (current.length >= KB_PDF_BARE_PAGE_CHARS) continue;
    const recognized = String(ocrPages[index] || "").trim();
    // 短页面（比如只有一行标题）也算"空页"，但 OCR 未必比原文更准：
    // 只有识别结果确实更长才替换，避免把原本正确的标题换成错字。
    if (!recognized || recognized.replace(/\s+/gu, "").length <= current.length) continue;
    pageTexts[index] = recognized;
    filled += 1;
  }
  return filled;
}

async function pdfText(buffer: Buffer): Promise<{ body: string; warnings: string[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  // 加密的报价单很常见（客户发来的 PI 常带打开密码）。pdfjs 抛的是 PasswordException，
  // 直接冒到 HTTP 层会变成 500「服务器错误」，用户完全看不懂该怎么处理。
  let document: Awaited<typeof loadingTask.promise>;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    const name = (error as { name?: string })?.name || "";
    if (name === "PasswordException") {
      throw new KbSourceExtractError("这个 PDF 有打开密码：请先输入密码另存一份不含密码的副本，再上传", 422);
    }
    throw new KbSourceExtractError("这个 PDF 打不开（文件可能损坏或不是标准 PDF）：请另存一份后重试", 422);
  }
  const warnings: string[] = [];
  /** 逐页保留（下标 = 页序），后面要和 OCR 结果按页合并 —— 混合型 PDF 里文字页与扫描页是混着的。 */
  const pageTexts: string[] = [];
  const total = document.numPages;
  try {
    const limit = Math.min(total, PDF_MAX_PAGES);
    if (total > limit) warnings.push(`PDF 共 ${total} 页，本次只读前 ${limit} 页`);
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      /** 同一行可能被 PDF 拆成多个文本块：按 y 坐标聚行，再按 x 排序拼接。 */
      const lines: Array<{ y: number; cells: Array<{ x: number; text: string }> }> = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const y = Number(item.transform?.[5] || 0);
        let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
        if (!line) {
          line = { y, cells: [] };
          lines.push(line);
        }
        line.cells.push({ x: Number(item.transform?.[4] || 0), text: item.str });
      }
      pageTexts.push(
        lines
          .sort((left, right) => right.y - left.y)
          .map((line) => line.cells.sort((left, right) => left.x - right.x).map((cell) => cell.text).join(" "))
          .join("\n")
          .trim()
      );
    }
  } finally {
    await document.destroy();
  }

  // 纯扫描件：一页文字都没有。混合件：文字页有内容、扫描页是空的。
  // 两种情况都走本机 OCR 补齐，只是送的页数不同（全量 vs 仅空白页）。
  const plan = planPdfOcr(pageTexts);
  let ocrAttempted = false;
  if (plan) {
    try {
      ocrAttempted = true;
      const ocr = await ocrPdfPages(buffer, plan.targets);
      const recognizedCount = applyOcrPages(pageTexts, ocr.pages);
      if (recognizedCount) {
        warnings.push(
          plan.scanned
            ? `这份 PDF 是扫描件：已用本机 OCR 识别 ${recognizedCount} 页，识别结果可能有错字，训练前建议抽查候选`
            : `有 ${recognizedCount} 页没有文字层，已用本机 OCR 补齐`
        );
      }
      warnings.push(...ocr.warnings);
    } catch (error) {
      // OCR 失败不该覆盖「至少还有文字页」的这部分成果；但纯扫描件无内容可交，如实报错。
      const hasText = pageTexts.some((text) => text.trim());
      if (!hasText) throw error;
      warnings.push(`有 ${plan.targets?.length ?? pageTexts.length} 页是扫描页，OCR 没跑成功（${error instanceof Error ? error.message : "未知原因"}）`);
    }
  }

  const pages = pageTexts.filter((text) => text.trim());
  if (!pages.length) {
    // 走了 OCR 还是空的：问题不是「没做」，而是「做了也没认出来」，别让用户以为我们没尝试。
    throw new KbSourceExtractError(
      ocrAttempted
        ? "这份 PDF 是扫描件，本机 OCR 没识别出文字（可能太模糊、倾斜或页内是纯图形）：请换一份清晰的资料，或把要点贴进正文框"
        : "这个 PDF 没有文字层（多半是扫描件）：请先用 OCR 转成文字，或把要点贴进正文框",
      422
    );
  }
  return { body: pages.join("\n\n"), warnings };
}

/** Word 正文：`word/document.xml` 里 `<w:p>` 是段落、`<w:t>` 是文字；表格单元格会出现 `<w:tc>`。 */
function docxText(buffer: Buffer): { body: string; warnings: string[] } {
  const files = unzipSync(new Uint8Array(buffer));
  const entry = files["word/document.xml"];
  if (!entry) throw new KbSourceExtractError("这个 .docx 里找不到正文（可能不是 Word 文档）", 422);
  const xml = strFromU8(entry);
  const body = xml
    .replace(/<w:tab[^>]*\/>/gu, "\t")
    .replace(/<w:br[^>]*\/>/gu, "\n")
    .replace(/<\/w:p>/gu, "\n\n")
    .replace(/<\/w:tc>/gu, "\t")
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'");
  const warnings: string[] = [];
  if (!normalizeText(body)) {
    throw new KbSourceExtractError("这个 Word 没有可提取的文字（内容可能全在图片里）", 422);
  }
  return { body, warnings };
}

/**
 * 主入口：按文件真实字节判定类型，而不是只信扩展名。
 * 返回的 `title` 用文件名（去扩展名）—— 它就是候选的出处标题，不能为空。
 */
export async function extractKbSource(options: {
  fileName: string;
  buffer: Buffer;
  declaredMime?: string;
}): Promise<KbExtractedSource> {
  const fileName = String(options.fileName || "").trim();
  if (!fileName) throw new KbSourceExtractError("缺少文件名（x-file-name）", 400);
  const buffer = options.buffer;
  if (!buffer?.length) throw new KbSourceExtractError("文件是空的", 400);
  if (buffer.length > KB_SOURCE_MAX_BYTES) {
    throw new KbSourceExtractError(`文件超过 ${Math.round(KB_SOURCE_MAX_BYTES / 1024 / 1024)} MB，请拆分后再传`, 413);
  }
  const kind = kbSourceKind(fileName);
  if (!kind) {
    throw new KbSourceExtractError("只支持 PDF / DOCX / TXT / MD / CSV：其它格式请先导出成这几种之一", 415);
  }
  const head = buffer.subarray(0, 5).toString("latin1");
  const isZip = buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (kind === "pdf" && !head.startsWith("%PDF-")) {
    throw new KbSourceExtractError("扩展名是 .pdf，但内容不是 PDF", 415);
  }
  if (kind === "docx" && !isZip) {
    throw new KbSourceExtractError("扩展名是 .docx，但内容不是 Word（在线预览导出的 .doc 请另存为 .docx）", 415);
  }

  let body = "";
  let warnings: string[] = [];
  if (kind === "pdf") ({ body, warnings } = await pdfText(buffer));
  else if (kind === "docx") ({ body, warnings } = await docxText(buffer));
  else {
    body = buffer.toString("utf8");
    if (body.includes("\u0000")) {
      throw new KbSourceExtractError("这个文件是二进制内容（扩展名与实际格式不符），请导出成文本后再传", 415);
    }
  }

  const normalized = normalizeText(body);
  if (!normalized) throw new KbSourceExtractError("没有读到任何正文：请确认文件不是空的或纯图片", 422);
  const chars = normalized.length;
  if (chars > KB_SOURCE_MAX_CHARS) {
    warnings = [...warnings, `正文超过 ${KB_SOURCE_MAX_CHARS.toLocaleString()} 字符，已截断`];
  }
  /** 标题会成为候选的出处，同样要去部首化 —— 否则引用卡片上显示的就是 ⼿ 这种字。 */
  const cleanName = foldRadicals(fileName);
  return {
    title: cleanName.replace(/\.[^.]+$/u, "").slice(0, 200) || cleanName.slice(0, 200),
    body: normalized.slice(0, KB_SOURCE_MAX_CHARS),
    warnings,
    chars
  };
}
