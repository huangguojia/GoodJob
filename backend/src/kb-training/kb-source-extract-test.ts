import assert from "node:assert/strict";

import {
  applyOcrPages,
  extractKbSource,
  kbSourceKind,
  KbSourceExtractError,
  planPdfOcr
} from "./kb-source-extract.js";
import { KB_PDF_OCR_MAX_PAGES } from "./pdf-ocr.js";

// ---------------------------------------------------------------------------
// 扫描件回归：这份测试守的是「PDF 都能训练」这件事的**两条腿**
//  1. 有文字层的 PDF：照旧抽正文，不能被 OCR 路径带偏（既不该慢，也不该改字）；
//  2. 没有文字层的 PDF：必须真的走 OCR，而不是直接回一句「不支持」。
// 第 2 条只用纯函数验证"要不要 OCR / 怎么合并"，因为调用真实 OCR 需要 macOS
// 的 Vision —— 那是环境能力，不是本模块的逻辑。
// ---------------------------------------------------------------------------

/* ---------- 类型判定 ---------- */
assert.equal(kbSourceKind("报价单.PDF"), "pdf");
assert.equal(kbSourceKind("manual.docx"), "docx");
assert.equal(kbSourceKind("notes.md"), "text");
assert.equal(kbSourceKind("manual.doc"), "", "旧版 .doc 不支持（二进制格式），不能静默当 word 收下");
assert.equal(kbSourceKind("scan.jpg"), "");

/* ---------- 没有文字层的页要挑出来送 OCR ---------- */
assert.deepEqual(planPdfOcr(["", ""]), { targets: undefined, scanned: true }, "整份都是空白页 → 全量送 OCR");
assert.deepEqual(
  planPdfOcr(["这是一页有文字的正常手册内容，用来模拟真实资料页", "   "]),
  { targets: [1], scanned: false },
  "混合件只送空白页：文字页重复识别既慢又可能改字"
);
assert.equal(
  planPdfOcr(["正常的产品手册正文，至少超过十二个字符", "另一页也是正常正文，同样超过十二个字符"]),
  null,
  "全都有文字层就不该触发 OCR"
);

const manyBlank = Array.from({ length: KB_PDF_OCR_MAX_PAGES + 20 }, () => "");
const manyPlan = planPdfOcr(manyBlank);
assert.equal(manyPlan?.scanned, true);
assert.equal(manyPlan?.targets, undefined, "全空时交给 OCR 端按上限截断，不在这里预切");

/* ---------- OCR 结果只填空页，不覆盖已有文字 ---------- */
const mergeTarget = ["原有文字甲，这一页有完整的文字层内容", "", "原有文字乙，同样有完整的文字层内容"];
const filled = applyOcrPages(mergeTarget, ["OCR 即使给了结果也不该覆盖有文字层的页", "识别出来的扫描页正文", ""]);
assert.equal(filled, 1);
assert.deepEqual(mergeTarget, [
  "原有文字甲，这一页有完整的文字层内容",
  "识别出来的扫描页正文",
  "原有文字乙，同样有完整的文字层内容"
]);

// 只有一行标题的页也可能被判为"空页"：OCR 结果更短时不能拿它换掉原文
const shortTitle = ["LED-200 参数手册", ""];
assert.equal(applyOcrPages(shortTitle, ["LED", "第二页识别正文"]), 1);
assert.equal(shortTitle[0], "LED-200 参数手册", "识别结果更短时保留原文");
assert.equal(shortTitle[1], "第二页识别正文");

/* ---------- 有文字层的 PDF 仍然走原文，且不产生 OCR 警告 ---------- */
function buildTextPdf(line: string): Buffer {
  const content = `BT /F1 18 Tf 30 150 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function main() {
  const textPdf = buildTextPdf("Minimum order quantity: 500 pcs");
  const extracted = await extractKbSource({ fileName: "quotation.pdf", buffer: textPdf });
  assert.ok(extracted.chars > 0, "有文字层的 PDF 必须抽出正文");
  assert.match(extracted.body, /Minimum order quantity: 500 pcs/u);
  assert.equal(extracted.title, "quotation");
  assert.deepEqual(extracted.warnings, [], "文字层完整时不该出现 OCR 警告");

  /* ---------- 无文字层的 PDF 必须走 OCR，而不是直接拒绝 ---------- */
  const blankPdf = buildTextPdf("");
  await assert.rejects(
    () => extractKbSource({ fileName: "scan.pdf", buffer: blankPdf }),
    (error: unknown) => {
      assert.ok(error instanceof KbSourceExtractError, "应该抛抽取错误（HTTP 层据此回 422）");
      assert.equal(error.status, 422);
      assert.match(error.message, /OCR/u, "错误信息必须说明 OCR 也试过了，否则用户以为功能没做");
      return true;
    }
  );

  /* ---------- 尺寸与类型闸门 ---------- */
  await assert.rejects(
    () => extractKbSource({ fileName: "fake.pdf", buffer: Buffer.from("not a pdf at all") }),
    /内容不是 PDF/u
  );
  await assert.rejects(
    () => extractKbSource({ fileName: "photo.jpg", buffer: Buffer.from([0xff, 0xd8]) }),
    /只支持 PDF/u
  );

  console.log("kb-source-extract-test: 扫描件 OCR 接线与文字层回归全部通过");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
