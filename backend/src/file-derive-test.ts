import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_CHUNK_BYTES,
  LocalStorageDriver,
  UPLOAD_SESSION_TTL_MS
} from "./file-storage.js";
import {
  fontConfigFile,
  imageDecoder,
  libreOfficeCandidates,
  planDerivations,
  probeDeriveCapabilities,
  derivativeKey,
  isHeicFile,
  isOfficeFile,
  previewCapabilityIssue,
  runCommand,
  shortError
} from "./file-derive.js";

const isWin = process.platform === "win32";
/** 跨平台地跑一条「会挂很久」和「会失败并写 stderr」的命令，别让测试只在 macOS 成立 */
const slowCommand = isWin
  ? { bin: "cmd", args: ["/c", "ping -n 30 127.0.0.1 > nul"] }
  : { bin: "/bin/sh", args: ["-c", "sleep 30"] };
const failingCommand = isWin
  ? { bin: "cmd", args: ["/c", "echo convert failed: broken file 1>&2 & exit 3"] }
  : { bin: "/bin/sh", args: ["-c", "echo 'convert failed: broken file' >&2; exit 3"] };

/**
 * 临时把 process.platform 改成目标平台，跑完恢复。
 * 这样平台分支是**真的执行到**，而不是靠读源码字符串猜。
 */
function withPlatform<T>(value: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
    // 探测结果里带着 platform，必须让缓存失效，否则后续用例拿到的是另一种平台的能力
    probeDeriveCapabilities(true);
  }
}

let passed = 0;
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const fileOf = (mime: string, originalName: string) => ({ mime, originalName, key: `files/default/26/10/${originalName}`, id: "file_x" });

async function main() {
  console.log("file-derive-test");

  await check("分片大小与服务端口径一致（5MB）", () => {
    assert.equal(FILE_CHUNK_BYTES, 5 * 1024 * 1024);
    assert.equal(UPLOAD_SESSION_TTL_MS, 24 * 60 * 60 * 1000);
  });

  await check("Office 文档按 mime 或扩展名都能认出（含老 .doc/.xls/.ppt）", () => {
    assert.equal(isOfficeFile("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.bin"), true);
    assert.equal(isOfficeFile("application/octet-stream", "PI-2026.DOCX"), true);
    assert.equal(isOfficeFile("application/octet-stream", "quote.xls"), true);
    assert.equal(isOfficeFile("application/octet-stream", "deck.ppt"), true);
    assert.equal(isOfficeFile("application/pdf", "a.pdf"), false);
  });

  await check("HEIC 按 mime 与扩展名都认，且不被当成普通图片放过", () => {
    assert.equal(isHeicFile("image/heic", "IMG_1.HEIC"), true);
    assert.equal(isHeicFile("application/octet-stream", "IMG_1.heif"), true);
    assert.equal(isHeicFile("image/jpeg", "IMG_1.jpg"), false);
  });

  await check("派生计划：docx 必须有 preview_pdf，缩略图是可选的", () => {
    const plan = planDerivations(fileOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PI.docx"));
    assert.deepEqual(plan.map((item) => [item.kind, item.required]), [["preview_pdf", true], ["thumb", false]]);
  });

  await check("派生计划：HEIC 必须有 image_jpg；普通图片只要缩略图", () => {
    const heic = planDerivations(fileOf("image/heic", "IMG_1.heic"));
    assert.deepEqual(heic.map((item) => [item.kind, item.required]), [["image_jpg", true], ["thumb", false]]);
    const png = planDerivations(fileOf("image/png", "shot.png"));
    assert.deepEqual(png.map((item) => [item.kind, item.required]), [["thumb", false]]);
  });

  await check("派生计划：PDF 只出缩略图；ZIP 不产生任何派生（别为压缩包白跑队列）", () => {
    assert.deepEqual(planDerivations(fileOf("application/pdf", "a.pdf")).map((item) => item.kind), ["thumb"]);
    assert.deepEqual(planDerivations(fileOf("application/zip", "a.zip")), []);
  });

  await check("派生件 key 挂在本体旁 .deriv/ 下（备份只搬本体）", () => {
    const key = derivativeKey(fileOf("application/pdf", "a.pdf"), "thumb", "jpg");
    assert.equal(key, "files/default/26/10/a.pdf.deriv/thumb.jpg");
  });

  const driver = new LocalStorageDriver(path.join(os.tmpdir(), `gj-chunk-test-${process.pid}`));
  const uploadId = "upl_test_0001";
  const parts = ["HEAD-PART-", "MIDDLE-SECTION-", "TAIL"].map((text) => Buffer.from(text.repeat(50), "utf8"));

  await check("分片乱序落盘、按序拼装：拼出来的 sha256 与直传一致", async () => {
    await driver.saveChunk(uploadId, 2, parts[2]);
    await driver.saveChunk(uploadId, 0, parts[0]);
    await driver.saveChunk(uploadId, 1, parts[1]);
    assert.deepEqual(await driver.listChunks(uploadId), [0, 1, 2]);
    const key = "files/default/26/10/assembled.bin";
    const result = await driver.assembleChunks(uploadId, 3, key);
    const expected = Buffer.concat(parts);
    assert.equal(result.size, expected.length);
    assert.equal(result.sha256, createHash("sha256").update(expected).digest("hex"));
    const onDisk = await fsp.readFile(path.join(driver.getRoot(), key));
    assert.equal(onDisk.equals(expected), true);
  });

  await check("拼装成功后临时片可清空，且 tmp 不会留在 files/ 里", async () => {
    await driver.discardChunks(uploadId);
    assert.deepEqual(await driver.listChunks(uploadId), []);
    const filesRoot = path.join(driver.getRoot(), "files");
    const entries = await fsp.readdir(filesRoot, { recursive: true });
    assert.equal(entries.some((item) => String(item).includes(".part")), false);
  });

  await check("非法上传会话 ID 直接拒绝（防 ../ 写到根外）", async () => {
    await assert.rejects(() => driver.saveChunk("../../etc", 0, Buffer.from("x")));
    await assert.rejects(() => driver.saveChunk("short", 0, Buffer.from("x")));
  });

  await check("过期分片会被清理，新鲜的不动", async () => {
    const stale = "upl_stale_0001";
    await driver.saveChunk(stale, 0, Buffer.from("old"));
    const staleDir = path.join(driver.getRoot(), "tmp/uploads", stale);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsp.utimes(staleDir, old, old);
    const fresh = "upl_fresh_0001";
    await driver.saveChunk(fresh, 0, Buffer.from("new"));
    const removed = await driver.pruneChunks(24 * 60 * 60 * 1000);
    assert.equal(removed, 1);
    assert.equal(existsSync(staleDir), false);
    assert.equal(existsSync(path.join(driver.getRoot(), "tmp/uploads", fresh)), true);
    await fsp.rm(driver.getRoot(), { recursive: true, force: true });
  });

  await check("转换超时会杀掉整棵进程树（soffice 会 fork，不能只杀父进程）", async () => {
    const started = Date.now();
    const result = await runCommand(slowCommand.bin, slowCommand.args, { timeoutMs: 400 });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    // 没有杀进程组的话这里会等满 30 秒
    assert.ok(elapsed < 5000, `实际耗时 ${elapsed}ms`);
  });

  await check("命令失败时保留 stderr 尾部，便于把真实原因回给用户", async () => {
    const result = await runCommand(failingCommand.bin, failingCommand.args, { timeoutMs: 5000 });
    assert.equal(result.code, 3);
    assert.equal(result.timedOut, false);
    assert.match(result.stderr, /convert failed/u);
  });

  await check("能力探测在 macOS 上能拿到 sips（HEIC 兜底靠它）", () => {
    const caps = probeDeriveCapabilities(true);
    if (process.platform === "darwin") assert.ok(caps.sips, "macOS 应有 /usr/bin/sips");
    assert.equal(typeof caps.libreoffice, "string");
    // 平台要带上，设置页据此给 brew / winget / apt 三种安装指引
    assert.equal(caps.platform, process.platform);
  });

  await check("图片解码器：macOS 走 sips，其它平台走 ImageMagick（参数语法不同）", () => {
    const decoder = imageDecoder(probeDeriveCapabilities());
    if (decoder) assert.match(decoder.kind, /^(sips|magick)$/u);
    // 本机是 mac 时必然有 sips；sips 的 `-s format` 参数不能喂给 ImageMagick
    if (process.platform === "darwin") assert.equal(decoder?.kind, "sips");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "file-derive.ts"), "utf8");
    assert.match(source, /-resize/u, "ImageMagick 分支必须用自己的 -resize 参数");
  });

  await check("Windows 上必须优先 soffice.com：soffice.exe 会立刻返回 0 而转换还没跑完", () => {
    const winCandidates = withPlatform("win32", () => libreOfficeCandidates());
    assert.ok(winCandidates.some((item) => item.endsWith("soffice.com")), "Windows 候选里必须探测 .com");
    assert.ok(winCandidates.some((item) => item.endsWith("soffice.exe")), "标准安装位置来自 .exe 同目录");
    const comAt = winCandidates.findIndex((item) => item.endsWith("soffice.com"));
    const exeAt = winCandidates.findIndex((item) => item.endsWith("soffice.exe"));
    assert.ok(comAt >= 0 && exeAt >= 0 && comAt < exeAt, ".com 必须排在 .exe 前面");
    // 允许用环境变量指定，开源用户可能装在非标准目录
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "file-derive.ts"), "utf8");
    assert.match(source, /LIBREOFFICE_BIN/u);
  });

  await check("Windows 不注入 fontconfig（用了 mac 那份等于告诉 LO 没有字体）", () => {
    assert.equal(withPlatform("win32", () => fontConfigFile()), "", "win32 必须返回空串");
    if (process.platform !== "win32") {
      const found = fontConfigFile();
      // 找不到就返回空串（宁可不注入，也不要注入错平台的那份）
      if (found) {
        assert.ok(existsSync(found));
        assert.match(found, process.platform === "darwin" ? /fonts\.conf$/u : /fonts\.linux\.conf$/u);
      }
    }
  });

  await check("改平台后能力探测要重算，不能返回缓存里的另一套", () => {
    const winCaps = withPlatform("win32", () => probeDeriveCapabilities(true));
    assert.equal(winCaps.platform, "win32");
    assert.equal(winCaps.sips, "", "Windows 没有 sips");
    assert.equal(winCaps.qlmanage, "", "Windows 没有 qlmanage");
    // 恢复本机平台后必须重新探测，否则后面所有用例都在用 Windows 的缓存
    const local = probeDeriveCapabilities(true);
    assert.equal(local.platform, process.platform);
  });

  await check("Long path / profile 用 pathToFileURL（Windows 上 file://C:\\ 不是合法 URL）", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "file-derive.ts"), "utf8");
    assert.match(source, /pathToFileURL\(profileDir\)\.href/u);
    assert.doesNotMatch(source, /UserInstallation=file:\/\$\{profileDir\}/u, "不能再用字符串拼 file://");
  });

  await check("Windows 的超时用 taskkill /T 杀进程树（负 pid 在 win32 无效）", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "file-derive.ts"), "utf8");
    assert.match(source, /taskkill/u);
    assert.match(source, /"\/T", "\/F"/u);
    assert.match(source, /process\.kill\(-pid/u, "POSIX 侧仍要杀进程组");
  });

  await check("HEIC 不能拿 LibreOffice 当解码能力（LO 不认 HEIC）", () => {
    const caps = probeDeriveCapabilities();
    const issue = previewCapabilityIssue(fileOf("image/heic", "IMG_1.heic"));
    if (!caps.sips && !caps.magick) assert.match(issue, /只能下载/u);
    else assert.equal(issue, "");
  });

  await check("没装 Office 转换组件时，上传当场说明「只能下载」而不是静默失败", () => {
    const caps = probeDeriveCapabilities();
    const issue = previewCapabilityIssue(fileOf("application/octet-stream", "PI.docx"));
    if (!caps.libreoffice) {
      assert.match(issue, /只能下载/u);
      // 用户不该看到 brew/soffice 这类运维命令；安装入口在「存储设置」的能力面板里
      assert.doesNotMatch(issue, /brew|LibreOffice|soffice/u);
    } else assert.equal(issue, "");
  });

  await check("外部工具的 stderr 不进用户文案（sips 会回 \"Try 'sips --help'\"）", () => {
    const failed = shortError(
      { code: 1, timedOut: false, stderr: "Try 'sips --help' for help using this tool." },
      "图片转换失败"
    );
    assert.doesNotMatch(failed, /sips|--help/u);
    assert.match(failed, /可下载原文件查看/u);
    // 超时是用户能理解的（等太久了），这条信息要保留
    const timedOut = shortError({ code: null, timedOut: true, stderr: "" }, "图片转换失败");
    assert.match(timedOut, /超时|秒未完成/u);
  });

  console.log(`\nfile-derive-test: ${passed} 项通过`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
