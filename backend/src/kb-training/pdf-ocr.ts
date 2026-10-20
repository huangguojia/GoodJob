import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KbSourceExtractError } from "./kb-source-error.js";

// ---------------------------------------------------------------------------
// 扫描件 PDF 的 OCR 兜底。
//
// 现实：外贸场景里客户给的产品手册、报价单、商业登记证，很大一部分是**拍照/扫描**
// 生成的 PDF —— 页面里只有一张图，没有任何文字层。这类文件走 pdfjs 抽出来是 0 字，
// 训练入口直接把用户挡在门外（"这个 PDF 没有文字层"），可用户手里根本没有别的格式。
//
// 为什么用系统自带 Vision 而不是视觉大模型：
//  1. 训练语料要求**忠于原文**。生成式模型会顺手改写、补全、翻译，抽出来的正文
//     就不再是资料本身，后面所有候选的出处都不可信；Vision 是逐行识别，不改写。
//  2. 零成本、离线、可重复：一份 40 页的报价单按页调模型是一笔真金白银，
//     而且不可复现（同一页两次识别结果可能不同）。
//  3. 中文/英文/俄语/西语等都在系统语言模型里，和这套 CRM 的客户分布吻合。
//
// 代价：只有 macOS 有 Vision。非 macOS 环境如实报错（见 `ocrUnavailable`），
// 不静默退化 —— 悄悄返回半份正文比直接失败更糟。
// ---------------------------------------------------------------------------

/** OCR 最多识别多少页：本机实测约 0.4 秒/页，80 页 ≈ 半分钟，再长应该拆成多份资料。 */
export const KB_PDF_OCR_MAX_PAGES = 80;
/** 单次 OCR 进程的硬超时：卡住的子进程必须被杀掉，不能让 HTTP 请求一直挂着。 */
const OCR_TIMEOUT_MS = 180_000;
/** 编译助手本身要几秒，第一次用到扫描件时发生；之后走缓存直接执行。 */
const COMPILE_TIMEOUT_MS = 120_000;

/**
 * OCR 助手源码（内嵌在 TS 里而不是单独 .swift 文件）：
 * tsc 只编译 .ts、不会把同目录的 .swift 拷进 dist，独立文件在构建产物里必然丢失。
 * 内嵌后源码与调用方永远同版本，缓存键也直接用它的哈希。
 *
 * 职责很窄：把 PDF 指定页渲染成位图 → 交给 Vision 逐行识别 → 输出 JSON。
 * 不做排版重建、不做猜词、不改写任何字符。
 */
const PDF_OCR_SWIFT = String.raw`import Foundation
import PDFKit
import Vision
import CoreGraphics
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(3)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: pdf-ocr <file> [pagesCsv] [maxPages]") }
let filePath = args[1]
let spec = args.count >= 3 ? args[2] : ""
let maxPages = args.count >= 4 ? (Int(args[3]) ?? 80) : 80

guard let document = PDFDocument(url: URL(fileURLWithPath: filePath)) else {
    fail("cannot-open-pdf")
}

let total = document.pageCount
var indices: [Int] = []
if spec.isEmpty {
    // 未指定页：按调用方给的上限从头取，绝不无上限地跑完整本（几百页会挂很久）。
    indices = Array(0..<min(total, max(1, maxPages)))
} else {
    for part in spec.split(separator: ",") {
        if let number = Int(part), number >= 1, number <= total { indices.append(number - 1) }
    }
}
if indices.isEmpty { fail("no-pages-selected") }

var supported: [String] = []
if let list = try? VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: VNRecognizeTextRequestRevision3) {
    supported = list
}
let wanted = ["zh-Hans", "en-US", "ru-RU", "es-ES", "pt-BR", "fr-FR", "de-DE", "it-IT", "nl-NL", "pl-PL", "tr-TR", "ja-JP", "ko-KR", "ar-SA"]
let languages = wanted.filter { code in
    supported.contains { $0.caseInsensitiveCompare(code) == .orderedSame }
}

func render(_ page: PDFPage, scale: CGFloat) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let width = Int((bounds.width * scale).rounded())
    let height = Int((bounds.height * scale).rounded())
    guard width > 0, height > 0 else { return nil }
    guard let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

var pages: [[String: Any]] = []

for index in indices {
    guard let page = document.page(at: index) else { continue }
    guard let image = render(page, scale: 2.0) else {
        pages.append(["index": index + 1, "text": "", "error": "render-failed"])
        continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if !languages.isEmpty { request.recognitionLanguages = languages }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        pages.append(["index": index + 1, "text": "", "error": "ocr-failed"])
        continue
    }
    let observations = request.results ?? []
    // 同一行可能被拆成多块：按纵向位置聚行（自上而下），行内按横向位置排序。
    // 只做排序，不拼接、不纠错 —— 识别到什么就是什么。
    let lines = observations.compactMap { observation -> (CGFloat, CGFloat, String)? in
        guard let top = observation.topCandidates(1).first else { return nil }
        return (observation.boundingBox.midY, observation.boundingBox.minX, top.string)
    }.sorted { left, right in
        if abs(left.0 - right.0) > 0.01 { return left.0 > right.0 }
        return left.1 < right.1
    }
    let text = lines.map { $0.2 }.joined(separator: "\n")
    pages.append(["index": index + 1, "text": text])
}

let payload: [String: Any] = [
    "pagesTotal": total,
    "pagesRead": indices.count,
    "languages": languages,
    "pages": pages
]
guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
      let json = String(data: data, encoding: .utf8) else {
    fail("encode-failed")
}
print(json)
`;

interface OcrPage {
  index: number;
  text: string;
  error?: string;
}

interface OcrPayload {
  pagesTotal?: number;
  pagesRead?: number;
  pages?: OcrPage[];
}

function ocrUnavailable(reason: string): KbSourceExtractError {
  return new KbSourceExtractError(
    `这份 PDF 是扫描件（没有文字层）。本机 OCR 不可用：${reason}。请把要点贴进正文框，或先转成带文字的 PDF / Word`,
    422
  );
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `exit ${code}`));
    });
  });
}

let binaryPromise: Promise<string> | null = null;

/**
 * 取（必要时编译）OCR 助手可执行文件。
 * 按源码哈希分目录：助手逻辑一改就是新路径，不会跑到上一版编译产物。
 */
function ensureOcrBinary(): Promise<string> {
  if (binaryPromise) return binaryPromise;
  binaryPromise = (async () => {
    if (process.platform !== "darwin") {
      throw ocrUnavailable("当前系统没有 Apple Vision（只有 macOS 支持本机 OCR）");
    }
    const key = createHash("sha256").update(PDF_OCR_SWIFT).digest("hex").slice(0, 16);
    const dir = path.join(os.tmpdir(), "gj-kb-pdf-ocr", key);
    const binary = path.join(dir, "pdf-ocr");
    if (fs.existsSync(binary)) return binary;
    await fsp.mkdir(dir, { recursive: true });
    const source = path.join(dir, "pdf-ocr.swift");
    await fsp.writeFile(source, PDF_OCR_SWIFT, "utf8");
    try {
      // -O 编译约 3-5 秒；只发生在第一次遇到扫描件时，之后一直命中缓存。
      await runCommand("swiftc", ["-O", source, "-o", binary], COMPILE_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof Error && error.message === "timeout"
        ? "编译 OCR 组件超时"
        : "编译 OCR 组件失败（需要 Xcode 命令行工具：xcode-select --install）";
      throw ocrUnavailable(reason);
    }
    return binary;
  })().catch((error) => {
    // 失败不缓存：装好命令行工具后不必重启服务
    binaryPromise = null;
    throw error;
  });
  return binaryPromise;
}

export interface KbPdfOcrResult {
  /** 下标 = 页序号（0 基），识别不出内容的页是空串。 */
  pages: string[];
  pagesTotal: number;
  warnings: string[];
}

/**
 * 对指定页做 OCR。
 * @param pages 0 基页序号；不传 = 全部页（受 `KB_PDF_OCR_MAX_PAGES` 限制）
 */
export async function ocrPdfPages(buffer: Buffer, pages?: number[]): Promise<KbPdfOcrResult> {
  const requested = pages && pages.length
    ? pages.filter((index) => Number.isInteger(index) && index >= 0)
    : null;
  const limited = requested ? requested.slice(0, KB_PDF_OCR_MAX_PAGES) : null;
  // 1 基页码交给助手：它对 PDF 更像人话，报错时也方便对照。
  const spec = limited ? limited.map((index) => index + 1).join(",") : "";
  const args = (pdfPath: string) => [pdfPath, spec, String(KB_PDF_OCR_MAX_PAGES)];

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gj-kb-ocr-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  try {
    await fsp.writeFile(pdfPath, buffer);
    let binary = await ensureOcrBinary();
    let stdout: string;
    try {
      ({ stdout } = await runCommand(binary, args(pdfPath), OCR_TIMEOUT_MS));
    } catch (error) {
      // 系统清理 tmp 会把编译好的助手删掉，而进程里的 Promise 还记着旧路径：
      // 只报 ENOENT 等于「重启服务前再也用不了 OCR」。这里丢掉缓存重编一次。
      const text = error instanceof Error ? error.message : "";
      if (!text.includes("ENOENT")) throw error;
      binaryPromise = null;
      binary = await ensureOcrBinary();
      ({ stdout } = await runCommand(binary, args(pdfPath), OCR_TIMEOUT_MS));
    }
    let payload: OcrPayload;
    try {
      payload = JSON.parse(stdout) as OcrPayload;
    } catch {
      throw ocrUnavailable("OCR 组件返回了无法解析的结果");
    }
    const total = Number(payload.pagesTotal || 0);
    const read = Number(payload.pagesRead || 0);
    const warnings: string[] = [];
    if (total > read) {
      warnings.push(`扫描件共 ${total} 页，本次只识别了 ${read} 页（单份上限 ${KB_PDF_OCR_MAX_PAGES} 页），其余页请拆成另一份资料`);
    }
    // 助手返回的是「识别了哪几页」，按页码落到对应下标上。
    const texts: string[] = [];
    for (const item of payload.pages || []) {
      const target = Number(item.index) - 1;
      if (target >= 0) texts[target] = String(item.text || "");
    }
    return { pages: texts, pagesTotal: total, warnings };
  } catch (error) {
    if (error instanceof KbSourceExtractError) throw error;
    if (error instanceof Error && error.message === "timeout") {
      throw ocrUnavailable("OCR 超时（PDF 页数或清晰度超出处理能力）");
    }
    throw ocrUnavailable(error instanceof Error ? error.message.slice(0, 120) : "未知错误");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
