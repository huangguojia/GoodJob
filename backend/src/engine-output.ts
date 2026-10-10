// ---------------------------------------------------------------------------
// CLI 输出契约 · 宽容转换层
//
// 设计原则（2026-10-10 明确）：
//   「依旧让 CLI 敞开了挖，但返回数据的格式要贴合 CRM，防止显示不出来，
//     信息依旧需要尽量全面。」
//
// 这三句话落在四个层次上，缺任何一层都会出现「明明挖到了，界面上却看不见」：
//
//   L1 契约层（输出侧唯一）
//      提示词给出与 CRM 数据结构同名的 JSON 形状：字段名一律用 CRM 的驼峰命名，
//      枚举值与 CRM 的状态机一致。**挖掘的广度不受限**（来源、轮次、深度全放开），
//      但输出的形状只能有一份——CRM 渲染不了的字段，要求模型产出也没有意义。
//
//   L2 宽容读入层（防「显示不出来」）
//      绝不用精确字段名取值。模型实际会写 company_name / 公司名称 / name，
//      把 85 写成 "85"、把 ["a"] 写成 "a"、把整份结果包一层 {"data":{...}}。
//      这些全部要认得——**认得出**比「输出端反复强调格式」可靠得多。
//
//   L3 信息保全层（防丢）
//      所有 slice 上限只约束「首屏渲染」，超出的条目进 extras 保留，前端可展开。
//      永不因为字段不规范而丢弃已经挖到的信息。
//
//   L4 诚实降级层
//      真拿不到结构化结果时，不报「无法解析」，而是把 CLI 的原文摘要交给用户，
//      并把原因归到真实来源（输出被截断 / 执行超时 / 文件本身读不出内容）。
//
// 本模块只做纯转换：不依赖 store、不依赖网络，便于单测覆盖。
// ---------------------------------------------------------------------------

/** 结果被外层包裹时的候选键：CLI 常把真正的结果塞进其中之一 */
const ENVELOPE_KEYS = ["data", "result", "output", "payload", "response", "answer"];

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * 剥掉结果外层的包裹。
 * `{"data":{"companies":[...]}}` 与 `{"companies":[...]}` 必须等价——
 * 否则整份结果会因为多了一层壳而「一条都显示不出来」。
 * 只在顶层确实没有业务字段时才下钻，避免把本来就叫 data 的业务字段误剥。
 */
export function unwrapEnginePayload(parsed: unknown, probeKeys: readonly string[] = [], depth = 2): Record<string, unknown> {
  let current = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  for (let level = 0; level < depth; level += 1) {
    if (probeKeys.some((key) => hasContent(current[key]))) return current;
    const envelope = ENVELOPE_KEYS.map((key) => current[key]).find((value) => value && typeof value === "object" && !Array.isArray(value));
    if (!envelope) return current;
    current = envelope as Record<string, unknown>;
  }
  return current;
}

/** 按别名顺序取第一个「有内容」的原值。字段名差异全在这一层吸收。 */
export function pickRaw(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (hasContent(value)) return value;
  }
  return undefined;
}

/** 通用文本化：只接受能无损转成字符串的值，对象一律不猜（返回空串）。 */
export function textFromUnknown(value: unknown, limit = 500): string {
  if (typeof value === "string") return value.replace(/\s+/gu, " ").trim().slice(0, limit);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, limit);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

export function readText(record: Record<string, unknown>, keys: readonly string[], limit = 500): string {
  return textFromUnknown(pickRaw(record, keys), limit);
}

/**
 * 多行文本：只去掉首尾空白，**保留内部换行**。
 * 邮件正文、背调摘要这类内容用 readText 会被压成一行——段落结构是内容的一部分，不能压。
 */
export function readBlockText(record: Record<string, unknown>, keys: readonly string[], limit = 6000): string {
  const value = pickRaw(record, keys);
  if (typeof value !== "string") return textFromUnknown(value, limit);
  return value.replace(/^[\s\u3000]+|[\s\u3000]+$/gu, "").slice(0, limit);
}

/**
 * 整数读取：数字与数字字符串都收，非法值返回 null。
 * 模型把 `relevance` 写成 "85%"、"85 分" 是常态，所以取首个数字串而不是整体 Number()。
 */
export function readInt(record: Record<string, unknown>, keys: readonly string[], min: number, max: number): number | null {
  const value = pickRaw(record, keys);
  let numeric: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) numeric = value;
  else if (typeof value === "string") {
    const match = value.match(/-?\d+(\.\d+)?/u);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) numeric = parsed;
    }
  }
  if (numeric === null) return null;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

/** 数值读取（不取整），用于 0-1 之间的置信度这类字段 */
export function readNumber(record: Record<string, unknown>, keys: readonly string[], min: number, max: number): number | null {
  const value = pickRaw(record, keys);
  let numeric: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) numeric = value;
  else if (typeof value === "string") {
    const match = value.match(/-?\d+(\.\d+)?/u);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) numeric = parsed;
    }
  }
  if (numeric === null) return null;
  return Math.max(min, Math.min(max, numeric));
}

function parseJsonArray(value: unknown): unknown[] | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^```(?:json)?/iu, "").replace(/```$/u, "").trim();
  if (!text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 把任意值摊平成数组：单值 → 单元素数组；字符串里的 JSON 数组 → 解析出来。 */
export function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const fromJson = parseJsonArray(value);
  if (fromJson) return fromJson;
  if (typeof value === "string") {
    // 常见的「一行一条」写法：模型偶尔用换行或分号代替 JSON 数组
    const lines = value.split(/\r?\n|；|;/u).map((line) => line.trim()).filter(Boolean);
    return lines.length > 1 ? lines : hasContent(value) ? [value] : [];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // {"items":[...]} / {"list":[...]} 这类包裹
    const nested = pickRaw(record, ["items", "list", "entries", "values"]);
    if (Array.isArray(nested)) return nested;
    return [value];
  }
  return [];
}

/**
 * 文本数组读取。
 * 收 string[]、单个 string、以及 {text|value|label|name|title|description} 形状的对象数组——
 * 模型把 `opportunities` 写成 `[{"text":"…"}]` 是实测发生过的事，不该因此整段丢掉。
 */
export function readTextList(
  record: Record<string, unknown>,
  keys: readonly string[],
  limit: number,
  maxLen = 400
): string[] {
  return toArray(pickRaw(record, keys))
    .flatMap((item) => {
      if (typeof item === "string") return [textFromUnknown(item, maxLen)].filter(Boolean);
      if (item && typeof item === "object") {
        const nested = textFromUnknown(pickRaw(item as Record<string, unknown>, ["text", "value", "label", "name", "title", "description", "detail"]), maxLen);
        return nested ? [nested] : [];
      }
      return [];
    })
    .slice(0, limit);
}

/** 对象数组读取：元素不是对象就直接丢弃（调用方逐条再校验）。 */
export function readRecordList(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown>[] {
  return toArray(pickRaw(record, keys))
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

/**
 * 溢出切分：首屏保留 limit 条（渲染稳定），其余进 overflow（信息不丢）。
 *
 * 这是 L3 的落点。以前各解析器直接 slice()，被切掉的条目**永久消失**——
 * 而 CLI 那边其实已经搜到了，用户永远不知道有这些内容。
 */
export function splitByLimit<T>(items: T[], limit: number): { primary: T[]; overflow: T[] } {
  if (items.length <= limit) return { primary: items, overflow: [] };
  return { primary: items.slice(0, limit), overflow: items.slice(limit) };
}

/** 枚举值收敛：不认的值一律回落到默认值，避免前端拿到未知状态渲染空白。 */
export function readEnum<T extends string>(record: Record<string, unknown>, keys: readonly string[], allowed: readonly T[], fallback: T): T {
  const raw = textFromUnknown(pickRaw(record, keys), 40).toLowerCase();
  return (allowed as readonly string[]).includes(raw) ? raw as T : fallback;
}

/** 合法 http(s) 链接才算数；其余返回空串（前端拿空串会退化成纯文本，不会渲染成坏链接）。 */
export function readUrl(record: Record<string, unknown>, keys: readonly string[], limit = 600): string {
  const value = textFromUnknown(pickRaw(record, keys), limit);
  return /^https?:\/\//iu.test(value) ? value : "";
}
