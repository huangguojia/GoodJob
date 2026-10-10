/**
 * 把二进制 Office 文档转成纯文本，供本机 CLI 读取。
 *
 * 为什么必须有这一步（2026-10-10 实测事故）：
 *   用户上传一份 .xls 形式发票（PI），CLI 的 Read 工具读二进制文件只能拿到一堆
 *   OLE2 乱码，于是它老老实实回了一个**空字段的合法 JSON** + 警告「该文件是二进制
 *   .xls，Read 无法解析」。CRM 却把这判成「CLI 返回的内容不是可解析的 JSON」。
 *   也就是说：前端写着「支持 Excel」，实际一个字段都拿不到——承诺和能力不符。
 *
 * 做法：在服务端先把 Office 文档抽成文本，落在暂存目录里，再把**文本文件**的路径
 * 交给 CLI。这样 CLI 永远不需要面对二进制，Excel / Word 资料才能真正被识别。
 *
 * 依赖策略：只用本机 Python 的标准库（zipfile + re + xml）就能处理 .xlsx 与 .docx；
 * 老式 .xls（OLE2 复合文档）必须靠第三方库 xlrd / pandas，装了就支持，没装就如实
 * 告知用户「另存为 .xlsx 或 CSV 再上传」，而不是静默给出空结果。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 抽出来的文本长度上限：客户资料（名片/合同/形式发票）远用不到这么多 */
const OFFICE_TEXT_MAX_CHARS = 40_000;
/** 单次转换超时：转换是本地解析，正常几百毫秒；卡住就放弃，绝不拖住上传 */
const OFFICE_EXTRACT_TIMEOUT_MS = 20_000;
/** 探测本机 Python 的超时 */
const OFFICE_PYTHON_PROBE_TIMEOUT_MS = 8_000;

/** 需要走「先文本化再交给 CLI」的扩展名 */
export const OFFICE_BINARY_EXTENSIONS = new Set(["xls", "xlsx", "doc", "docx"]);
/** 能真正抽成文本的扩展名（其余给出可执行的替代建议） */
const OFFICE_CONVERTIBLE_EXTENSIONS = new Set(["xls", "xlsx", "docx"]);

const OFFICE_EXTENSION_HINTS: Record<string, string> = {
  doc: "旧版 .doc 是二进制格式，无法直接抽取文字：请用 Word 另存为 .docx 或 PDF 后再上传",
  ppt: "暂不支持 PowerPoint 资料：请把客户信息截图，或另存为 PDF 后再上传",
  pptx: "暂不支持 PowerPoint 资料：请把客户信息截图，或另存为 PDF 后再上传"
};

/** 转换失败时给用户看的可执行建议 */
export function officeExtensionHint(extension: string) {
  const ext = extension.toLowerCase().replace(/^\./u, "");
  if (OFFICE_EXTENSION_HINTS[ext]) return OFFICE_EXTENSION_HINTS[ext];
  if (ext === "xls") {
    return "旧版 .xls 需要本机 Python 装好 xlrd 或 pandas 才能自动读取：请在文件里「另存为 .xlsx 或 CSV」后重传，或在本机执行 python3 -m pip install xlrd";
  }
  return "该文件无法自动转成文本：请另存为 .xlsx / .docx / CSV / PDF 后再上传";
}

/**
 * 抽取脚本。用 String.raw 保持正则里的反斜杠原样（普通模板串会把 \b 变成退格符）。
 * 参数：path ext maxChars；输出一行 JSON（ok / text / note）。
 */
const OFFICE_EXTRACT_SCRIPT = String.raw`
import sys, json, re, zipfile, html

path, ext, max_chars = sys.argv[1], (sys.argv[2] or "").lower().lstrip("."), int(sys.argv[3])


def emit(ok, text, note=""):
    payload = {"ok": bool(ok), "text": (text or "").strip()[:max_chars], "note": note or ""}
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.flush()
    sys.exit(0)


def strip_tags(chunk):
    chunk = re.sub(r"<[^>]+>", "", chunk)
    return html.unescape(chunk)


def docx_text(target):
    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
        parts = [n for n in names if re.match(r"word/(document|header\d*|footer\d*)\.xml$", n)]
        if not parts:
            return None
        chunks = []
        for name in parts:
            raw = archive.read(name).decode("utf-8", "ignore")
            raw = re.sub(r"</w:p>", "\n", raw)
            raw = re.sub(r"<w:br[^>]*/>", "\n", raw)
            raw = re.sub(r"<w:tab[^>]*/>", "\t", raw)
            chunks.append(strip_tags(raw))
        return "\n".join(chunks)


def xlsx_text_via_zip(target):
    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            raw = archive.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
            for item in re.findall(r"<si\b.*?</si>|<si\s*/>", raw, re.S):
                shared.append(strip_tags("".join(re.findall(r"<t\b[^>]*>(.*?)</t>", item, re.S))))
        sheets = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        lines = []
        for name in sheets:
            raw = archive.read(name).decode("utf-8", "ignore")
            for row in re.findall(r"<row\b.*?</row>|<row\b[^>]*/>", raw, re.S):
                cells = []
                for match in re.finditer(r"<c\b([^>]*?)(?:/>|>(.*?)</c>)", row, re.S):
                    attrs = match.group(1) or ""
                    body = match.group(2) or ""
                    kind = re.search(r't="([^"]+)"', attrs)
                    kind = kind.group(1) if kind else ""
                    if kind == "inlineStr":
                        cells.append(strip_tags("".join(re.findall(r"<t\b[^>]*>(.*?)</t>", body, re.S))))
                        continue
                    value = re.search(r"<v>(.*?)</v>", body, re.S)
                    if not value:
                        continue
                    if kind == "s":
                        try:
                            cells.append(shared[int(value.group(1))])
                        except Exception:
                            cells.append("")
                    else:
                        cells.append(html.unescape(value.group(1)))
                line = " | ".join(x.strip() for x in cells if x and x.strip())
                if line:
                    lines.append(line)
        return "\n".join(lines)


def xlsx_text(target):
    try:
        import openpyxl
        book = openpyxl.load_workbook(target, read_only=True, data_only=True)
        lines = []
        for sheet in book.worksheets:
            lines.append("# 工作表：%s" % sheet.title)
            for row in sheet.iter_rows(values_only=True):
                cells = []
                for value in row:
                    if value is None:
                        continue
                    if isinstance(value, float) and value == int(value):
                        value = int(value)
                    text = str(value).strip()
                    if text:
                        cells.append(text)
                if cells:
                    lines.append(" | ".join(cells))
        book.close()
        return "\n".join(lines)
    except Exception:
        return xlsx_text_via_zip(target)


def xls_text(target):
    errors = []
    try:
        import xlrd
        book = xlrd.open_workbook(target)
        lines = []
        for sheet in book.sheets():
            lines.append("# 工作表：%s" % sheet.name)
            for index in range(sheet.nrows):
                cells = []
                for cell in sheet.row_values(index):
                    if cell is None:
                        continue
                    if isinstance(cell, float) and cell == int(cell):
                        cell = int(cell)
                    text = str(cell).strip()
                    if text:
                        cells.append(text)
                if cells:
                    lines.append(" | ".join(cells))
        return "\n".join(lines), ""
    except Exception as error:
        errors.append(str(error))
    try:
        import pandas
        frames = pandas.read_excel(target, sheet_name=None, header=None)
        lines = []
        for name, frame in frames.items():
            lines.append("# 工作表：%s" % name)
            for row in frame.itertuples(index=False):
                cells = []
                for value in row:
                    text = str(value).strip()
                    if text and text not in ("nan", "NaT", "None"):
                        cells.append(text)
                if cells:
                    lines.append(" | ".join(cells))
        return "\n".join(lines), ""
    except Exception as error:
        errors.append(str(error))
    return "", "；".join(errors[:2])


try:
    if ext == "docx":
        text = docx_text(path)
        if text and text.strip():
            emit(True, text, "已由 CRM 从 Word 转为文本")
        emit(False, "", "该 .docx 里没有可抽取的文字（可能是纯图片文档），请改传截图或 PDF")
    elif ext == "xlsx":
        text = xlsx_text(path)
        if text and text.strip():
            emit(True, text, "已由 CRM 从 Excel 转为文本")
        emit(False, "", "该 .xlsx 里没有读到任何单元格内容")
    elif ext == "xls":
        text, note = xls_text(path)
        if text and text.strip():
            emit(True, text, "已由 CRM 从 Excel 转为文本")
        emit(False, "", note or "无法解析该 .xls")
    else:
        emit(False, "", "不支持的格式")
except Exception as error:
    emit(False, "", "转换失败：%s" % error)
`;

interface OfficePythonCandidate {
  bin: string;
  /** 标准库转换能力（zipfile + re + xml）：xlsx / docx */
  zip: boolean;
  /** 能读旧版 .xls（装了 xlrd 或 pandas） */
  legacy: boolean;
}

/** 探测脚本：报告当前解释器具备哪些能力 */
const OFFICE_PROBE_SCRIPT = String.raw`
import json, sys
def has(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False
capabilities = {"zip": has("zipfile"), "legacy": has("xlrd") or has("pandas")}
sys.stdout.buffer.write(json.dumps(capabilities).encode("utf-8"))
`;

/**
 * 候选解释器：显式环境变量 > 常见安装位置 > PATH。
 * Runner / 后端由 launchd 启动时 PATH 很窄，光靠 `python3` 会漏掉用户自己装的
 * Homebrew 或 python.org 版本（而那恰恰是装了 xlrd / pandas 的那个）。
 */
function officePythonCandidates() {
  const candidates: string[] = [];
  const explicit = (process.env.GOODJOB_OFFICE_PYTHON || "").trim();
  if (explicit) candidates.push(explicit);
  candidates.push("python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3");
  const home = process.env.HOME || "";
  const framework = "/Library/Frameworks/Python.framework/Versions";
  if (existsSync(framework)) {
    for (const version of readdirSync(framework)) {
      candidates.push(`${framework}/${version}/bin/python3`);
    }
  }
  const globals = [
    `${home}/.workbuddy/binaries/python/versions`,
    `${home}/.pyenv/versions`,
    `${home}/miniconda3/bin`,
    `${home}/anaconda3/bin`
  ];
  for (const root of globals) {
    if (!root || !existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      candidates.push(`${root}/${entry}/bin/python3`);
    }
  }
  return candidates.filter((item, index) => item && candidates.indexOf(item) === index);
}

let cachedPython: OfficePythonCandidate | null | undefined;

/** 挑一个可用的解释器：优先「能读 .xls」的，退而求其次「能读 xlsx/docx」的 */
async function resolveOfficePython(): Promise<OfficePythonCandidate | null> {
  if (cachedPython !== undefined) return cachedPython;
  let fallback: OfficePythonCandidate | null = null;
  for (const bin of officePythonCandidates()) {
    if (bin.includes("/") && !existsSync(bin)) continue;
    let stdout = "";
    try {
      const result = await execFileAsync(bin, ["-c", OFFICE_PROBE_SCRIPT], {
        timeout: OFFICE_PYTHON_PROBE_TIMEOUT_MS,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      stdout = result.stdout || "";
    } catch {
      continue;
    }
    let parsed: { zip?: boolean; legacy?: boolean } = {};
    try {
      parsed = JSON.parse(stdout.trim() || "{}") as { zip?: boolean; legacy?: boolean };
    } catch {
      continue;
    }
    const candidate: OfficePythonCandidate = { bin, zip: Boolean(parsed.zip), legacy: Boolean(parsed.legacy) };
    if (candidate.legacy) {
      cachedPython = candidate;
      return candidate;
    }
    if (!fallback && candidate.zip) fallback = candidate;
  }
  cachedPython = fallback;
  return cachedPython;
}

/** 仅供测试与诊断：重置解释器探测缓存 */
export function resetOfficePythonCache() {
  cachedPython = undefined;
}

export interface OfficeTextExtractResult {
  /** 抽出的文本 */
  text: string;
  /** 给用户看的一句话说明（为什么转换、怎么转的） */
  note: string;
  /** 实际使用的解释器（诊断用） */
  pythonBin: string;
}

/**
 * 把 Office 二进制文档转成文本；无法转换时返回 null（调用方负责把原因讲给用户）。
 */
export async function officeDocumentToText(
  filePath: string,
  extension: string
): Promise<OfficeTextExtractResult | null> {
  const ext = extension.toLowerCase().replace(/^\./u, "");
  if (!OFFICE_CONVERTIBLE_EXTENSIONS.has(ext)) return null;
  const python = await resolveOfficePython();
  if (!python) return null;
  // 老的 .xls 只有第三方库能读；解释器不具备该能力时不要白跑一趟
  if (ext === "xls" && !python.legacy) return null;
  let stdout = "";
  try {
    const result = await execFileAsync(
      python.bin,
      ["-c", OFFICE_EXTRACT_SCRIPT, filePath, ext, String(OFFICE_TEXT_MAX_CHARS)],
      {
        timeout: OFFICE_EXTRACT_TIMEOUT_MS,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    stdout = result.stdout || "";
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(stdout.trim() || "{}") as { ok?: boolean; text?: string; note?: string };
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!parsed.ok || !text) return null;
    return {
      text: text.slice(0, OFFICE_TEXT_MAX_CHARS),
      note: (parsed.note || "").trim(),
      pythonBin: python.bin
    };
  } catch {
    return null;
  }
}

/** 诊断用：这台机器能不能自动读 Office 文档 */
export async function officeExtractionCapability() {
  const python = await resolveOfficePython();
  return {
    available: Boolean(python),
    pythonBin: python?.bin || "",
    /** xlsx / docx（标准库即可） */
    modern: Boolean(python?.zip),
    /** 旧版 .xls（需 xlrd 或 pandas） */
    legacy: Boolean(python?.legacy),
    supportedExtensions: python
      ? Array.from(OFFICE_CONVERTIBLE_EXTENSIONS).filter((ext) => ext !== "xls" || python.legacy)
      : []
  };
}
