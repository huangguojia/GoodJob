import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  contentDisposition,
  evaluateFileAccess,
  sanitizeOriginalName,
  safeStoragePath,
  sniffFileType
} from "./file-storage.js";

let passed = 0;
function check(name: string, run: () => void) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const bufferOf = (...bytes: number[]) => Buffer.from(bytes);
const ascii = (value: string) => Buffer.from(value, "latin1");

check("PDF 按魔数识别，不信任扩展名（.pdf.txt 也是 PDF）", () => {
  const result = sniffFileType(Buffer.concat([ascii("%PDF-1.7"), Buffer.from("\n")]), "invoice.pdf.txt");
  assert.equal(result?.ext, "pdf");
  assert.equal(result?.mime, "application/pdf");
});

check("JPEG / PNG / WEBP / HEIC 都能认出来", () => {
  assert.equal(sniffFileType(bufferOf(0xff, 0xd8, 0xff, 0xe0), "a.jpg")?.ext, "jpg");
  assert.equal(sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "a.png")?.ext, "png");
  const webp = Buffer.concat([ascii("RIFF"), bufferOf(0, 0, 0, 0), ascii("WEBPVP8 ")]);
  assert.equal(sniffFileType(webp, "a.webp")?.ext, "webp");
  const heic = Buffer.concat([bufferOf(0, 0, 0, 0x18), ascii("ftypheic"), Buffer.alloc(8)]);
  assert.equal(sniffFileType(heic, "IMG_0001.HEIC")?.ext, "heic");
});

check("OOXML 靠扩展名细分（三种格式魔数相同，顺序错了会全变 zip）", () => {
  const pk = bufferOf(0x50, 0x4b, 0x03, 0x04);
  assert.equal(sniffFileType(pk, "PI.docx")?.ext, "docx");
  assert.equal(sniffFileType(pk, "CI.xlsx")?.ext, "xlsx");
  assert.equal(sniffFileType(pk, "报价.pptx")?.ext, "pptx");
  assert.equal(sniffFileType(pk, "pack.zip")?.ext, "zip");
  // 声明成 docx 但其实是别的 zip：不能冒充成 Word
  assert.equal(sniffFileType(pk, "evil.pdf")?.ext, "zip");
});

check("可执行文件与未知二进制一律拒绝", () => {
  assert.equal(sniffFileType(ascii("MZ\x90\x00\x03"), "setup.exe"), null);
  assert.equal(sniffFileType(bufferOf(0x7f, 0x45, 0x4c, 0x46), "linux-bin"), null);
  assert.equal(sniffFileType(Buffer.alloc(0), "empty.pdf"), null);
});

check("纯文本只在扩展名允许时接受，含 NUL 的伪文本拒绝", () => {
  assert.equal(sniffFileType(ascii("hello world"), "notes.txt")?.mime, "text/plain");
  assert.equal(sniffFileType(ascii("a,b\n1,2"), "data.csv")?.mime, "text/csv");
  assert.equal(sniffFileType(Buffer.from([0x68, 0x00, 0x69]), "notes.txt"), null);
  assert.equal(sniffFileType(ascii("hello"), "script.sh"), null);
});

check("文件名清洗：去路径、去非法字符、保留中文、按字节截断", () => {
  assert.equal(sanitizeOriginalName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeOriginalName("C:\\\\temp\\\\PI 2026.pdf"), "PI 2026.pdf");
  assert.equal(sanitizeOriginalName('a<b>c:d"e|f?g*h.pdf'), "a_b_c_d_e_f_g_h.pdf");
  assert.equal(sanitizeOriginalName("  合同扫描件.pdf  "), "合同扫描件.pdf");
  assert.equal(sanitizeOriginalName("...hidden.txt"), "hidden.txt");
  assert.equal(sanitizeOriginalName(""), "file");
  const long = "中".repeat(200) + ".pdf";
  const cleaned = sanitizeOriginalName(long);
  assert.ok(Buffer.byteLength(cleaned, "utf8") <= 255, "清洗后必须 ≤255 字节");
});

check("下载响应头：中文名走 filename*，ASCII 回退不是问号", () => {
  const header = contentDisposition("采购合同 2026.pdf");
  assert.ok(header.includes("attachment;"));
  assert.ok(header.includes("filename*=UTF-8''%E9%87%87%E8%B4%AD"), header);
  assert.ok(header.includes('filename="'), "必须保留 ASCII 兜底");
  assert.ok(!header.includes("??"), "回退名不能变成问号");
  assert.ok(contentDisposition("a.pdf", true).startsWith("inline;"));
});

check("存储路径：拒绝穿越与绝对路径，正常 key 落在根内", () => {
  // 用 os.tmpdir() 而不是写死 /tmp：Windows 上没有 /tmp，路径运算也会跑偏
  const root = path.join(os.tmpdir(), "gj-file-root");
  assert.equal(safeStoragePath(root, "files/26/10/a.pdf"), path.join(root, "files/26/10/a.pdf"));
  assert.throws(() => safeStoragePath(root, "../../etc/passwd"));
  assert.throws(() => safeStoragePath(root, "/etc/passwd"));
  assert.throws(() => safeStoragePath(root, "files/../../outside.pdf"));
  assert.throws(() => safeStoragePath(root, ""));
  // Windows 盘符绝对路径：收下它等于把存储根判定作废
  assert.throws(() => safeStoragePath(root, "C:\\Windows\\win.ini"));
  // 反斜杠形式的 key 要归一成 /，否则同一个文件会有两个 key
  assert.equal(safeStoragePath(root, "files\\26\\10\\a.pdf"), path.join(root, "files/26/10/a.pdf"));
});

const baseFile = {
  status: "active" as const,
  visibility: "inherit" as const,
  ownerId: "u_sales_a",
  teamId: "t1",
  createdBy: "u_sales_a",
  legalHold: false
};
const userA = { id: "u_sales_a", role: "sales", teamId: "t1" };
const userB = { id: "u_sales_b", role: "sales", teamId: "t1" };
const manager = { id: "u_mgr", role: "manager", teamId: "t1" };
const otherTeam = { id: "u_other", role: "sales", teamId: "t2" };
const baseOptions = { isAdmin: false, hasManagePermission: false, canSee: () => false };

check("上传者本人始终可见（即使没有任何引用）", () => {
  const decision = evaluateFileAccess(userA, baseFile, [], baseOptions);
  assert.equal(decision.ok, true);
  assert.equal(decision.canManage, true);
});

check("inherit + 匿名：没有引用时别人看不到（台账孤儿只属于上传者）", () => {
  const decision = evaluateFileAccess(userB, baseFile, [], baseOptions);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 403);
});

check("inherit 并集：任一关联业务可见即可见", () => {
  const refs = [
    { ownerId: "u_sales_b", teamId: "t1" },
    { ownerId: "u_sales_c", teamId: "t1" }
  ];
  const canSee = (ownerId: string) => ownerId === "u_sales_c";
  const decision = evaluateFileAccess(userB, baseFile, refs, { ...baseOptions, canSee });
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, "reference");
});

check("inherit 并集不因「有一个不可见」而整体拒绝", () => {
  const refs = [
    { ownerId: "u_sales_c", teamId: "t1" },
    { ownerId: "u_sales_d", teamId: "t1" }
  ];
  const canSee = (ownerId: string) => ownerId === "u_sales_c";
  assert.equal(evaluateFileAccess(userB, baseFile, refs, { ...baseOptions, canSee }).ok, true);
});

check("private 只有本人与管理员能看", () => {
  const file = { ...baseFile, visibility: "private" as const };
  assert.equal(evaluateFileAccess(userA, file, [], baseOptions).ok, true);
  assert.equal(evaluateFileAccess(userB, file, [], baseOptions).ok, false);
  assert.equal(evaluateFileAccess(userB, file, [], { ...baseOptions, isAdmin: true }).ok, true);
});

check("team 档：同团队可见，跨团队不可见", () => {
  const file = { ...baseFile, visibility: "team" as const };
  assert.equal(evaluateFileAccess(userB, file, [], baseOptions).ok, true);
  assert.equal(evaluateFileAccess(otherTeam, file, [], baseOptions).ok, false);
});

check("回收站：普通用户 404（不暴露删除行为），管理员与本人仍可见", () => {
  const file = { ...baseFile, status: "recycled" as const };
  const other = evaluateFileAccess(userB, file, [], baseOptions);
  assert.equal(other.ok, false);
  assert.equal(other.code, 404);
  assert.equal(evaluateFileAccess(userA, file, [], baseOptions).ok, true);
  assert.equal(evaluateFileAccess(userB, file, [], { ...baseOptions, isAdmin: true }).ok, true);
});

check("manage 动作：只有本人或管理员通过，普通同事即使能看也不能删", () => {
  const viewer = evaluateFileAccess(userB, baseFile, [{ ownerId: "u_sales_b", teamId: "t1" }], {
    ...baseOptions,
    canSee: () => true,
    action: "manage"
  });
  assert.equal(viewer.ok, false);
  assert.equal(evaluateFileAccess(userA, baseFile, [], { ...baseOptions, action: "manage" }).ok, true);
});

check("管理员不受 visibility 限制，但 private 也不会漏给普通同事", () => {
  const file = { ...baseFile, visibility: "private" as const };
  assert.equal(evaluateFileAccess(manager, file, [], baseOptions).ok, false, "经理不是文件管理员，不能看他人私件");
  assert.equal(evaluateFileAccess(manager, file, [], { ...baseOptions, isAdmin: true }).ok, true);
});

console.log(`\nfile-storage-test: ${passed} 项通过`);
