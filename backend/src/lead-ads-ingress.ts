/**
 * 广告表单（Facebook Lead Ads）载荷归一化。
 *
 * 中转服务（Make / Zapier / LeadSync）送来的 JSON 结构不统一，至少三种：
 *   1. 扁平对象：{ full_name, email, phone_number, company }
 *   2. Meta 原始：{ fields: { ... } } 或 { field_data: [{ name, values }] }
 *   3. Graph API：{ data: [{ field_data: [...] }] }（数组包一层）
 * 这里统一摊平成「字段名 → 值」，再按别名表映射到 CRM 线索字段。
 *
 * 原则：只搬运、不猜测。缺什么就空着，绝不补全邮箱 / 人名 / 公司名。
 */
import { createHash } from "node:crypto";

export interface NormalizedLeadAdsLead {
  company: string;
  contact: string;
  country: string;
  email: string;
  phone: string;
  source: string;
  sourceCampaign: string;
  externalId: string;
  inquiryContent: string;
  remark: string;
  rawPayload: Record<string, unknown>;
}

const COMPANY_KEYS = [
  "company", "companyname", "organization", "organisation", "businessname",
  "employer", "brand", "公司", "公司名称", "企业名称", "单位", "单位名称", "厂名", "品牌"
];
const CONTACT_KEYS = [
  "fullname", "name", "contactname", "contactperson", "personname", "yourname",
  "姓名", "联系人", "名字", "称呼"
];
const EMAIL_KEYS = [
  "email", "emailaddress", "workemail", "businessemail", "mail",
  "邮箱", "电子邮箱", "邮件", "邮件地址"
];
const PHONE_KEYS = [
  "phonenumber", "phone", "mobile", "mobilephone", "tel", "telephone", "whatsapp",
  "whatsappnumber", "电话", "手机", "手机号", "联系电话", "电话号"
];
const COUNTRY_KEYS = [
  "country", "countrycode", "countryname", "国家", "国家地区", "所在国家"
];
const MESSAGE_KEYS = [
  "message", "remarks", "remark", "comments", "comment", "inquiry", "requirement",
  "requirements", "demand", "note", "notes",
  "需求", "备注", "留言", "留言内容", "询盘内容", "采购需求", "产品需求", "想了解"
];
const FORM_KEYS = ["formname", "formid", "form", "表单名称", "表单"];
const CAMPAIGN_KEYS = [
  "campaignname", "campaign", "campaignid", "adsetname", "adname", "adid",
  "广告系列", "广告名称", "广告"
];
const EXTERNAL_ID_KEYS = ["leadgenid", "leadid", "leadid", "id", "submissionid"];

/** 归一化后的键：小写、去空白/下划线/连字符/标点，保留中文与数字。 */
export function leadAdsFieldKey(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[\s_\-—–./\\|]+/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(" / ");
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "text", "name", "label"]) {
      if (key in record) {
        const nested = scalarText(record[key]);
        if (nested) return nested;
      }
    }
  }
  return "";
}

type FieldBucket = Map<string, { label: string; value: string }>;

function addField(bucket: FieldBucket, label: unknown, value: unknown) {
  const key = leadAdsFieldKey(String(label || ""));
  if (!key) return;
  const text = scalarText(value);
  if (!text) return;
  if (!bucket.has(key)) bucket.set(key, { label: String(label), value: text });
}

/** 把各种包装结构摊平；最多递归 3 层，防畸形载荷。 */
export function collectLeadAdsFields(payload: unknown, depth = 0): FieldBucket {
  const bucket: FieldBucket = new Map();
  if (depth > 3 || payload === null || payload === undefined) return bucket;

  if (Array.isArray(payload)) {
    for (const item of payload.slice(0, 20)) {
      // Meta 的 field_data 项就是 { name, values }，必须按字段处理；
      // 直接递归会把 "name" / "values" 当成两个业务字段收进去。
      if (item && typeof item === "object" && "name" in item
        && ("values" in item || "value" in item)) {
        const entry = item as Record<string, unknown>;
        addField(bucket, entry.name, entry.values ?? entry.value);
        continue;
      }
      for (const [key, entry] of collectLeadAdsFields(item, depth + 1)) bucket.set(key, entry);
    }
    return bucket;
  }

  if (typeof payload !== "object") return bucket;
  const record = payload as Record<string, unknown>;

  // Meta field_data: [{ name, values: [] }]
  if (Array.isArray(record.field_data)) {
    for (const item of record.field_data.slice(0, 60)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      addField(bucket, entry.name ?? entry.key ?? entry.label, entry.values ?? entry.value);
    }
  }

  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = leadAdsFieldKey(rawKey);
    if (key === "fielddata") continue; // 上面已按 { name, values } 处理过
    if (["fields", "data", "entry", "changes", "value"].includes(key)) {
      for (const [nestedKey, entry] of collectLeadAdsFields(rawValue, depth + 1)) bucket.set(nestedKey, entry);
      continue;
    }
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      for (const [nestedKey, entry] of collectLeadAdsFields(rawValue, depth + 1)) bucket.set(nestedKey, entry);
      continue;
    }
    addField(bucket, rawKey, rawValue);
  }
  return bucket;
}

function pick(bucket: FieldBucket, keys: string[]) {
  for (const key of keys) {
    const entry = bucket.get(leadAdsFieldKey(key));
    if (entry?.value) return entry.value;
  }
  return "";
}

function joinedName(bucket: FieldBucket) {
  const first = pick(bucket, ["firstname", "first_name", "givenname", "名"]);
  const last = pick(bucket, ["lastname", "last_name", "surname", "familyname", "姓"]);
  return [first, last].filter(Boolean).join(" ").trim();
}

function normalizedEmail(value: string) {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  return match ? match[0].trim() : "";
}

function normalizedPhone(value: string) {
  const compact = value.replace(/[^\d+()\-\s]/gu, " ").replace(/\s+/gu, " ").trim();
  const digits = compact.replace(/\D/gu, "");
  return digits.length >= 6 ? compact : "";
}

const KNOWN_KEYS = new Set([
  ...COMPANY_KEYS, ...CONTACT_KEYS, ...EMAIL_KEYS, ...PHONE_KEYS, ...COUNTRY_KEYS,
  ...MESSAGE_KEYS, ...FORM_KEYS, ...CAMPAIGN_KEYS, ...EXTERNAL_ID_KEYS,
  "firstname", "lastname", "givenname", "surname", "familyname", "名", "姓",
  "object", "pageid", "createdtime", "createdat", "submittedat", "submittime",
  "platform", "isexport", "status", "formid", "adid", "adsetid", "campaignid"
].map((item) => leadAdsFieldKey(item)));

/**
 * 确定性外部 ID：优先用平台给的真实 id；没有就按「邮箱 + 电话 + 表单」算哈希。
 * 同一份表单重复投递（webhook 重试 / Make 重跑）必须落到同一条线索上。
 */
export function leadAdsExternalId(bucket: FieldBucket) {
  const platformId = pick(bucket, EXTERNAL_ID_KEYS)
    .replace(/[^\w-]/gu, "")
    .slice(0, 120);
  if (platformId) return `fb:${platformId}`;
  const seed = [
    normalizedEmail(pick(bucket, EMAIL_KEYS)),
    normalizedPhone(pick(bucket, PHONE_KEYS)).replace(/\D/gu, ""),
    pick(bucket, FORM_KEYS)
  ].join("|").toLocaleLowerCase("en-US");
  return `fbhash:${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

function compactRawPayload(payload: unknown): Record<string, unknown> {
  try {
    const text = JSON.stringify(payload ?? {});
    if (text.length <= 32_000) return (payload && typeof payload === "object" ? payload : { value: payload }) as Record<string, unknown>;
    return { truncated: true, bytes: text.length, preview: text.slice(0, 4_000) };
  } catch {
    return { unserializable: true };
  }
}

/**
 * 载荷里是否存在任何可用业务信息。
 *
 * 必须有这道判断：normalizeLeadAdsPayload 的 company 带兜底文案
 * （"Facebook 广告表单线索"），所以「归一化后 company 非空」不能用来判断载荷有效，
 * 否则空对象 {} 也会造出一条只有兜底公司名的空线索。
 */
export function hasLeadAdsContent(payload: unknown): boolean {
  const bucket = collectLeadAdsFields(payload);
  if (bucket.size === 0) return false;
  return Boolean(
    normalizedEmail(pick(bucket, EMAIL_KEYS))
    || normalizedPhone(pick(bucket, PHONE_KEYS))
    || pick(bucket, CONTACT_KEYS)
    || joinedName(bucket)
    || pick(bucket, COMPANY_KEYS)
    || pick(bucket, MESSAGE_KEYS)
  );
}

export function normalizeLeadAdsPayload(payload: unknown): NormalizedLeadAdsLead {
  const bucket = collectLeadAdsFields(payload);
  const formName = pick(bucket, FORM_KEYS);
  const campaignName = pick(bucket, CAMPAIGN_KEYS);
  const contact = pick(bucket, CONTACT_KEYS) || joinedName(bucket);
  const email = normalizedEmail(pick(bucket, EMAIL_KEYS));
  const phone = normalizedPhone(pick(bucket, PHONE_KEYS));
  const country = pick(bucket, COUNTRY_KEYS);

  const extras: string[] = [];
  for (const [key, entry] of bucket) {
    if (KNOWN_KEYS.has(key)) continue;
    extras.push(`${entry.label}=${entry.value.slice(0, 120)}`);
    if (extras.length >= 20) break;
  }

  const message = pick(bucket, MESSAGE_KEYS);
  const inquiryParts = [message, extras.length ? `其它答案：${extras.join("；")}` : ""].filter(Boolean);

  const company = pick(bucket, COMPANY_KEYS)
    || formName
    || (contact ? `${contact}（Facebook 表单）` : "Facebook 广告表单线索");

  const remarkParts = [
    "来源：Facebook 广告表单",
    formName ? `表单：${formName}` : "",
    campaignName ? `广告：${campaignName}` : "",
    !email && pick(bucket, EMAIL_KEYS) ? `邮箱原文（未通过校验）：${pick(bucket, EMAIL_KEYS).slice(0, 120)}` : ""
  ].filter(Boolean);

  return {
    company: company.slice(0, 200),
    contact: contact.slice(0, 120),
    country: country.slice(0, 80),
    email: email.slice(0, 200),
    phone: phone.slice(0, 80),
    source: "Facebook 广告表单",
    sourceCampaign: (campaignName || formName).slice(0, 120),
    externalId: leadAdsExternalId(bucket),
    inquiryContent: inquiryParts.join("\n").slice(0, 20_000),
    remark: remarkParts.join("｜").slice(0, 2_000),
    rawPayload: compactRawPayload(payload)
  };
}
