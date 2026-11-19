import { Readable } from "node:stream";
import { PDFDocument } from "pdf-lib";

// ---------------------------------------------------------------------------
// 打包与合并（M5）
//
// 为什么自己写 ZIP 而不是引 archiver：
// - archiver v8 没有类型声明，且它的错误路径会把「某个文件读失败」变成整包 500；
//   这里需要的是「逐个过权限 + 单个失败不影响其它」，流式、可中断、可计数。
// - 用 store（不压缩）模式：单证多为 PDF/图片，deflate 收益个位数百分比，
//   而 CPU 和内存开销换来的是更慢的首字节。压不压缩对用户没有感知，对服务器有。
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer: Buffer, seed = 0): number {
  let crc = (seed ^ -1) >>> 0;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/**
 * 写 zip 的文件名：去掉目录、控制字符，超长截断（ZIP 名字上限 65535 字节，这里按 180 字节保守）。
 * 这里按**最严格的解压端**（Windows 资源管理器）来清洗，因为包可能在任何机器上被解开：
 * 非法字符 `<>:"|?*`、设备保留名（CON/NUL/COM1…）、结尾的点或空格，在 NTFS 上都会出问题。
 */
export function sanitizeZipName(name: string, fallback = "file"): string {
  const leaf = String(name || "").split(/[\\/]/u).pop() || "";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    // 保留中文：只挡 Windows 非法字符，不做 ASCII 化
    .replace(/[<>:"|?*]/gu, "_")
    .replace(/^\.+/u, "")
    // 结尾的点和空格在 Windows 上会被静默吞掉，导致「包里有 5 个文件、解开只有 4 个」
    .replace(/[. ]+$/gu, "")
    .trim();
  let base = cleaned || fallback;
  // `CON.txt` 在 Windows 上依然打不开：判据是去掉扩展名之后的主干
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (WINDOWS_RESERVED.test(stem)) base = `_${base}`;
  if (Buffer.byteLength(base, "utf8") <= 180) return base;
  const ext = base.match(/\.[a-z0-9]{1,8}$/iu)?.[0] || "";
  let trimmed = base.slice(0, base.length - ext.length);
  while (Buffer.byteLength(trimmed + ext, "utf8") > 180) trimmed = trimmed.slice(0, -1);
  return trimmed + ext;
}

/** 同名文件加 (2)(3) 后缀，否则解压时后者覆盖前者，用户会以为丢文件 */
export function dedupeZipNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((raw) => {
    const name = sanitizeZipName(raw);
    const seen = used.get(name) || 0;
    used.set(name, seen + 1);
    if (seen === 0) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${stem}(${seen + 1})${ext}`;
  });
}

function dosDateTime(date: Date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

export interface ZipEntry {
  name: string;
  size: number;
  /** 打开这一条的字节流；调用方负责逐个过权限判定，不许在这里读库 */
  open: () => Readable;
}

/**
 * 流式 ZIP（store 模式，带 data descriptor）。
 * 用 data descriptor 是因为 CRC 必须读完才知道；先把 header 发出去，
 * 用户能立刻开始下载，而不是等服务器读完整个包。
 */
export function buildZipStream(entries: ZipEntry[], onError?: (name: string, error: Error) => void): Readable {
  const names = dedupeZipNames(entries.map((entry) => entry.name));
  const central: Buffer[] = [];
  let offset = 0;
  let index = 0;
  const { time, day } = dosDateTime(new Date());

  const localHeader = (name: string, size: number) => {
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    // bit 3 = 后面有 data descriptor；bit 11 = 文件名是 UTF-8（否则中文名解压成乱码）
    header.writeUInt16LE(0x0008 | 0x0800, 6);
    header.writeUInt16LE(0, 8); // store
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(0, 14); // crc 留给 descriptor
    header.writeUInt32LE(size > 0xffffffff ? 0xffffffff : size >>> 0, 18);
    header.writeUInt32LE(size > 0xffffffff ? 0xffffffff : size >>> 0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, 30);
    return header;
  };

  const dataDescriptor = (crc: number, size: number) => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0x08074b50, 0);
    buf.writeUInt32LE(crc >>> 0, 4);
    buf.writeUInt32LE(size > 0xffffffff ? 0xffffffff : size >>> 0, 8);
    buf.writeUInt32LE(size > 0xffffffff ? 0xffffffff : size >>> 0, 12);
    return buf;
  };

  const centralHeader = (name: string, crc: number, size: number, localOffset: number) => {
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(46 + nameBuf.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0008 | 0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(size > 0xffffffff ? 0xffffffff : size >>> 0, 20);
    header.writeUInt32LE(size > 0xffffffff ? 0xffffffff : size >>> 0, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localOffset >>> 0, 42);
    nameBuf.copy(header, 46);
    return header;
  };

  async function* generate() {
    for (const entry of entries) {
      const name = names[index];
      index += 1;
      const localOffset = offset;
      const header = localHeader(name, entry.size);
      yield header;
      offset += header.length;

      let crc = 0;
      let written = 0;
      let stream: Readable | null = null;
      try {
        stream = entry.open();
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          crc = crc32(buf, crc);
          written += buf.length;
          offset += buf.length;
          yield buf;
        }
      } catch (error) {
        // 单个文件读失败：整包不能半途中止（用户已经收到前面几条了），
        // 用零字节占位 + 记录错误，让下载仍能完成、并在结果里如实报告。
        onError?.(name, error as Error);
        stream?.destroy();
      }
      const descriptor = dataDescriptor(crc, written);
      yield descriptor;
      offset += descriptor.length;
      central.push(centralHeader(name, crc, written, localOffset));
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const header of central) {
      yield header;
      centralSize += header.length;
      offset += header.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    yield eocd;
    void offset;
  }

  return Readable.from(generate());
}

/** 合并 PDF：按给定顺序拼接，只保留页面，不保留书签/表单（跨文件合并书签会互相踩） */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  if (!buffers.length) throw new Error("没有可合并的 PDF");
  const merged = await PDFDocument.create();
  for (const [index, buffer] of buffers.entries()) {
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    } catch (error) {
      throw new Error(`第 ${index + 1} 个 PDF 无法解析：${(error as Error).message}`);
    }
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  const out = await merged.save();
  return Buffer.from(out);
}
