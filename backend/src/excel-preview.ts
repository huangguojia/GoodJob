import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class ExcelPreviewUnavailableError extends Error {}

function libreOfficeCandidates() {
  const configured = process.env.LIBREOFFICE_BIN?.trim();
  const home = process.env.HOME?.trim();
  const candidates = [
    configured,
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    home ? path.join(home, ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice") : "",
    "soffice",
    "libreoffice"
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)].filter((value) => !value.includes(path.sep) || existsSync(value));
}

function runLibreOffice(binary: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(binary, args, { timeout: 45_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      reject(Object.assign(error, { stderr }));
    });
  });
}

export function excelBufferSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function renderExcelBufferToPdf(excelBuffer: Buffer) {
  const workDir = await mkdtemp(path.join(tmpdir(), "goodjob-excel-preview-"));
  const inputPath = path.join(workDir, "document.xlsx");
  const outputPath = path.join(workDir, "document.pdf");
  const profileDir = path.join(workDir, "lo-profile");
  try {
    await mkdir(profileDir);
    await writeFile(inputPath, excelBuffer);
    let lastError: unknown;
    for (const binary of libreOfficeCandidates()) {
      try {
        await runLibreOffice(binary, [
          "--headless",
          `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
          "--convert-to",
          "pdf",
          "--outdir",
          workDir,
          inputPath
        ]);
        const pdf = await readFile(outputPath);
        if (pdf.length < 100 || pdf.subarray(0, 4).toString() !== "%PDF") {
          throw new Error("LibreOffice 未生成有效 PDF");
        }
        return pdf;
      } catch (error) {
        lastError = error;
      }
    }
    const detail = lastError instanceof Error && "code" in lastError && lastError.code !== "ENOENT"
      ? `：${lastError.message}`
      : "";
    throw new ExcelPreviewUnavailableError(`服务器未安装或无法运行 LibreOffice，暂时不能预览 Excel${detail}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
