/**
 * 抽取失败的错误类型（独立成文件）。
 *
 * 为什么单独放：`kb-source-extract.ts` 要调用 OCR（`pdf-ocr.ts`），OCR 又要抛同一种
 * 错误；两者互相 import 会形成 ESM 循环依赖，运行时才炸（`instanceof` 拿到 undefined）。
 * 错误类下沉到最底层，两个模块都只依赖它。
 */
export class KbSourceExtractError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "KbSourceExtractError";
  }
}
