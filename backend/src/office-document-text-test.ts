/**
 * Office 文档文本化的回归测试。
 *
 * 只验证「一定能用」的那部分：用 Python 标准库现场造一个最小 .docx / .xlsx，
 * 再走真实转换链路读回来。老式 .xls（OLE2 复合文档）没法用标准库生成，
 * 由 officeExtensionHint 的提示话术断言兜住——那条路径靠 xlrd / pandas，装不了就如实告知用户。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  OFFICE_BINARY_EXTENSIONS,
  officeDocumentToText,
  officeExtractionCapability,
  officeExtensionHint
} from "./office-document-text.js";

const execFileAsync = promisify(execFile);

/** 用标准库现场造最小样本：docx 只要有 word/document.xml，xlsx 只要有 sharedStrings + sheet */
const MAKE_SAMPLE_SCRIPT = String.raw`
import sys, zipfile

kind, target = sys.argv[1], sys.argv[2]

if kind == "docx":
    document = (
        "<w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body>"
        "<w:p><w:r><w:t>Blue Harbor Trading LLC</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>sales@blueharbor.example</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Hamburg, Germany</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("word/document.xml", document)
else:
    values = ["Company", "PT Nusantara Jaya", "Email", "buyer@nusantara.example"]
    shared = "<sst>" + "".join("<si><t>%s</t></si>" % item for item in values) + "</sst>"
    rows = "".join(
        '<row r="%d"><c r="A%d" t="s"><v>%d</v></c></row>' % (index + 1, index + 1, index)
        for index in range(len(values))
    )
    sheet = "<worksheet><sheetData>%s</sheetData></worksheet>" % rows
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("xl/sharedStrings.xml", shared)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
`;

// ── 1. 扩展名归类与提示话术 ───────────────────────────────────────
assert.ok(OFFICE_BINARY_EXTENSIONS.has("xls"), "旧版 xls 属于需要文本化的二进制文档");
assert.ok(OFFICE_BINARY_EXTENSIONS.has("xlsx"), "xlsx 属于需要文本化的二进制文档");
assert.ok(OFFICE_BINARY_EXTENSIONS.has("docx"), "docx 属于需要文本化的二进制文档");
assert.ok(!OFFICE_BINARY_EXTENSIONS.has("pdf"), "PDF 不该被拦：CLI 自己能读");
assert.ok(!OFFICE_BINARY_EXTENSIONS.has("png"), "图片不该被拦：CLI 能识别图像内容");
assert.match(officeExtensionHint("doc"), /另存为 .docx/u, "老 .doc 要给可执行的替代建议");
assert.match(officeExtensionHint("xls"), /xlrd/u, "xls 转换失败时要讲清缺什么、怎么补");

// ── 2. 真实转换链路（本机有可用 Python 时才跑）───────────────────
const capability = await officeExtractionCapability();
assert.ok(Array.isArray(capability.supportedExtensions));

if (!capability.available) {
  console.log("⚠ 本机没有可用 Python：Office 文本化会在运行时降级为「把原件交给 CLI」，跳过转换断言");
} else {
  const dir = await mkdtemp(path.join(tmpdir(), "gj-office-test-"));
  try {
    const samples = [
      { kind: "docx", extension: "docx", expected: "Blue Harbor Trading LLC" },
      { kind: "xlsx", extension: "xlsx", expected: "PT Nusantara Jaya" }
    ] as const;
    for (const sample of samples) {
      const target = path.join(dir, `sample.${sample.extension}`);
      await execFileAsync(capability.pythonBin, ["-c", MAKE_SAMPLE_SCRIPT, sample.kind, target], { timeout: 30_000 });
      const extracted = await officeDocumentToText(target, sample.extension);
      assert.ok(extracted, `${sample.extension} 应该能抽成文本`);
      assert.match(extracted.text, new RegExp(sample.expected, "u"), `${sample.extension} 内容要能读出来`);
      assert.match(extracted.note, /转为文本/u);
      assert.equal(extracted.pythonBin, capability.pythonBin);
    }
    // 文件不存在 / 格式不认识：必须安全返回 null，绝不抛异常打断上传
    assert.equal(await officeDocumentToText(path.join(dir, "missing.xlsx"), "xlsx"), null);
    assert.equal(await officeDocumentToText(path.join(dir, "missing.pdf"), "pdf"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`✓ Office 文档文本化：扩展名归类 + docx/xlsx 端到端转换通过（解释器 ${capability.pythonBin}）`);
}
