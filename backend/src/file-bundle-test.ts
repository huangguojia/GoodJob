import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { PDFDocument } from "pdf-lib";
import { buildZipStream, crc32, dedupeZipNames, mergePdfs, sanitizeZipName } from "./file-bundle.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

// CRC32 的公开测试向量：实现错了这里必红
check("crc32 标准向量", () => {
  assert.equal(crc32(Buffer.from("123456789", "latin1")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  // 分块喂进去必须等于一次性喂（流式实现的正确性前提）
  const whole = Buffer.from("Hello, 单证 PI-2026!", "utf8");
  assert.equal(crc32(whole.subarray(4), crc32(whole.subarray(0, 4))), crc32(whole));
});

check("sanitizeZipName 去目录与非法字符", () => {
  assert.equal(sanitizeZipName("C:\\temp\\PI 2026.pdf"), "PI 2026.pdf");
  assert.equal(sanitizeZipName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeZipName("a<b>c:d|e?f*g.txt"), "a_b_c_d_e_f_g.txt");
  // 中文必须原样保留：ASCII 化会让客户看到一堆乱码文件名
  assert.equal(sanitizeZipName("合同-PI-2026.pdf"), "合同-PI-2026.pdf");
  assert.equal(sanitizeZipName(""), "file");
  assert.equal(sanitizeZipName("..."), "file");
});

check("sanitizeZipName 超长按字节截断且保留扩展名", () => {
  const out = sanitizeZipName("单".repeat(100) + ".pdf");
  assert.ok(Buffer.byteLength(out, "utf8") <= 180, `实际 ${Buffer.byteLength(out, "utf8")} 字节`);
  assert.ok(out.endsWith(".pdf"));
});

check("dedupeZipNames 同名递增不覆盖", () => {
  assert.deepEqual(dedupeZipNames(["PI.pdf", "PI.pdf", "PI.pdf", "合同.docx"]), ["PI.pdf", "PI(2).pdf", "PI(3).pdf", "合同.docx"]);
  assert.deepEqual(dedupeZipNames(["a/report.xlsx", "b/report.xlsx"]), ["report.xlsx", "report(2).xlsx"]);
});

check("sanitizeZipName 挡掉 Windows 解压端会炸的名字", () => {
  // NTFS 设备保留名：`CON.txt` 在资源管理器里根本解不出来
  assert.equal(sanitizeZipName("CON.txt"), "_CON.txt");
  assert.equal(sanitizeZipName("nul.pdf"), "_nul.pdf");
  assert.equal(sanitizeZipName("COM1.xlsx"), "_COM1.xlsx");
  assert.equal(sanitizeZipName("console.txt"), "console.txt", "只是前缀相同不能误伤");
  // 结尾的点和空格会被 Windows 静默吞掉，导致「包里 5 个、解开 4 个」
  assert.equal(sanitizeZipName("report.pdf. "), "report.pdf");
  assert.equal(sanitizeZipName("报价单."), "报价单");
});

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// 用真实 unzip 解一遍：只验签名等于自己骗自己
const zip = await collect(buildZipStream([
  { name: "合同 PI.pdf", size: 5, open: () => Readable.from([Buffer.from("aaaaa")]) },
  { name: "合同 PI.pdf", size: 3, open: () => Readable.from([Buffer.from("bbb")]) },
  { name: "notes.txt", size: 6, open: () => Readable.from([Buffer.from("hello!")]) }
]));
assert.equal(zip.readUInt32LE(0), 0x04034b50, "缺少 local file header 签名");
assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), "缺少 EOCD");
assert.ok(zip.includes(Buffer.from("合同 PI.pdf", "utf8")), "中文文件名没有按 UTF-8 写入");
assert.ok(zip.includes(Buffer.from("合同 PI(2).pdf", "utf8")), "同名文件没有去重");
passed += 1;

// 临时目录走 os.tmpdir()：写死 /tmp 在 Windows 上直接失败
const workDir = path.join(os.tmpdir(), `gj-bundle-check-${process.pid}`);
await fsp.rm(workDir, { recursive: true, force: true });
await fsp.mkdir(workDir, { recursive: true });
const zipPath = path.join(workDir, "check.zip");
const extractDir = path.join(workDir, "out");

/** Windows 上通常只有 `python`；没有 Python 时跳过真实解压校验而不是让测试变红 */
function pythonBin() {
  for (const candidate of [process.env.PYTHON_BIN, "python3", "python"].filter(Boolean) as string[]) {
    try {
      execFileSync(candidate, ["-c", "print(1)"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

const python = pythonBin();
await fsp.writeFile(zipPath, zip);
try {
  if (python) {
    // 不用 unzip -l 验文件名：macOS 自带的 Info-ZIP 不认 Bit 11（UTF-8），
    // 会把中文按本地代码页显示成乱码，看着像我们写错了。Python zipfile 严格按 flag 解码。
    const listing = execFileSync(python, ["-c", [
      "import zipfile,json,sys",
      "z=zipfile.ZipFile(sys.argv[1])",
      "print(json.dumps({'names':z.namelist(),'bad':z.testzip()}))"
    ].join("\n"), zipPath], { encoding: "utf8" });
    const info = JSON.parse(listing) as { names: string[]; bad: string | null };
    assert.deepEqual(info.names, ["合同 PI.pdf", "合同 PI(2).pdf", "notes.txt"]);
    assert.equal(info.bad, null, `CRC 校验失败的文件：${info.bad}`);

    await fsp.mkdir(extractDir, { recursive: true });
    execFileSync(python, ["-c", [
      "import zipfile,sys",
      "zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])"
    ].join("\n"), zipPath, extractDir]);
    assert.equal(await fsp.readFile(path.join(extractDir, "notes.txt"), "utf8"), "hello!");
    assert.equal(await fsp.readFile(path.join(extractDir, "合同 PI.pdf"), "utf8"), "aaaaa");
    passed += 1;
  } else {
    console.log("  ! 未检测到 Python，跳过真实解压校验（设置 PYTHON_BIN 可启用）");
  }
} finally {
  await fsp.rm(workDir, { recursive: true, force: true });
}

// 流中途读失败：整包不能崩，要留下零字节条目并回调报错
const failedNames: string[] = [];
const broken = await collect(buildZipStream([
  { name: "good.txt", size: 2, open: () => Readable.from([Buffer.from("ok")]) },
  { name: "bad.txt", size: 10, open: () => { throw new Error("模拟读盘失败"); } },
  { name: "after.txt", size: 4, open: () => Readable.from([Buffer.from("last")]) }
], (name) => failedNames.push(name)));
assert.deepEqual(failedNames, ["bad.txt"]);
assert.equal(broken.readUInt32LE(0), 0x04034b50);
assert.ok(broken.includes(Buffer.from("after.txt", "utf8")), "一个文件失败不该让后面的条目丢失");
passed += 1;

const makePdf = async (label: string) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  page.drawText(label, { x: 20, y: 200, size: 14 });
  return Buffer.from(await doc.save());
};
const pdfA = await makePdf("A");
const pdfB = await makePdf("B");
const merged = await mergePdfs([pdfA, pdfB]);
const mergedDoc = await PDFDocument.load(merged);
assert.equal(mergedDoc.getPageCount(), 2, "合并后页数应为 2");
passed += 1;

await assert.rejects(() => mergePdfs([]), /没有可合并/u);
passed += 1;

console.log(`file-bundle-test: ${passed} 项通过`);
