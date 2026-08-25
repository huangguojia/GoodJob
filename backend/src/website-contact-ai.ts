import { load } from "cheerio";
import { callAiModel, extractJsonObject } from "./ai-model-runtime.js";
import type { AiModelConfig, ExtractedWebsiteContact } from "./types.js";

export interface WebsiteContactAiPage {
  sourceUrl: string;
  html: string;
}

export interface WebsiteContactAiInput {
  domain: string;
  pages: WebsiteContactAiPage[];
}

export type WebsiteContactAiExtractor = (
  input: WebsiteContactAiInput
) => Promise<ExtractedWebsiteContact[]>;

const MAX_PAGE_TEXT_CHARS = 9_000;
const MAX_TOTAL_TEXT_CHARS = 18_000;

function compactText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function comparisonText(value: unknown) {
  return compactText(value).toLocaleLowerCase("en-US");
}

function normalizeEmail(value: unknown) {
  return compactText(value)
    .replace(/^mailto:/iu, "")
    .split("?")[0]!
    .match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}/iu)?.[0]
    ?.toLocaleLowerCase("en-US") || "";
}

function normalizePhone(value: unknown) {
  const source = compactText(value).replace(/^tel:/iu, "").split("?")[0]!;
  const digits = source.replace(/\D/gu, "");
  if (digits.length < 7 || digits.length > 15 || /^(\d)\1{6,}$/u.test(digits)) return "";
  return `${source.startsWith("+") ? "+" : ""}${digits}`;
}

function normalizeWhatsapp(value: unknown) {
  const source = compactText(value);
  const fromUrl = source.match(/(?:wa\.me\/|whatsapp\.com\/(?:send\/?\?phone=)?)(\+?\d{7,15})/iu)?.[1];
  return normalizePhone(fromUrl || source);
}

function pageSource(page: WebsiteContactAiPage) {
  const $ = load(page.html, { xmlMode: false });
  $("script,style,noscript,template,svg,canvas,iframe,object,head").remove();
  $("p,li,address,article,section,div,h1,h2,h3,h4,h5,h6,td,th,footer,header").each((_index, node) => {
    $(node).append("\n");
  });
  const explicitChannels: string[] = [];
  $("a[href]").each((_index, node) => {
    const href = compactText($(node).attr("href"));
    if (/^(?:mailto:|tel:)/iu.test(href)
      || /(?:wa\.me\/|whatsapp\.com\/)/iu.test(href)) {
      explicitChannels.push(href);
    }
  });
  const visibleText = $("body").text()
    .split(/\n+/u)
    .map(compactText)
    .filter(Boolean)
    .join("\n");
  return [visibleText, ...explicitChannels].filter(Boolean).join("\n").slice(0, MAX_PAGE_TEXT_CHARS);
}

function exactTextOnPage(pageText: string, value: string) {
  return Boolean(value && comparisonText(pageText).includes(comparisonText(value)));
}

function exactPhoneOnPage(pageText: string, value: string) {
  const expected = normalizePhone(value).replace(/\D/gu, "");
  if (!expected) return false;
  const candidates = pageText.match(/(?:\+?\d[\d\s().-]{5,}\d)/gu) || [];
  return candidates.some((candidate) => normalizePhone(candidate).replace(/\D/gu, "") === expected);
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function boundedField(value: unknown, maxLength: number) {
  return compactText(value).slice(0, maxLength);
}

export function validateAiWebsiteContacts(
  raw: unknown,
  pages: Array<{ sourceUrl: string; text: string }>
): ExtractedWebsiteContact[] {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const records = Array.isArray(root.contacts) ? root.contacts.slice(0, 8) : [];
  const contacts: ExtractedWebsiteContact[] = [];
  const seen = new Set<string>();
  for (const value of records) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const pageIndex = Math.trunc(Number(item.pageIndex)) - 1;
    const page = pages[pageIndex];
    if (!page) continue;
    const name = boundedField(item.name, 100);
    const title = boundedField(item.title, 120);
    const evidenceQuote = boundedField(item.evidenceQuote, 500);
    if (evidenceQuote && !exactTextOnPage(page.text, evidenceQuote)) continue;
    if (name && !exactTextOnPage(page.text, name)) continue;
    if (title && !exactTextOnPage(page.text, title)) continue;

    const emails = [...new Set(arrayValue(item.emails)
      .map(normalizeEmail)
      .filter((email) => email && comparisonText(page.text).includes(email)))].slice(0, 4);
    const phones = [...new Set(arrayValue(item.phones)
      .map(normalizePhone)
      .filter((phone) => phone && exactPhoneOnPage(page.text, phone)))].slice(0, 4);
    const whatsapp = [...new Set(arrayValue(item.whatsapp)
      .map(normalizeWhatsapp)
      .filter((phone) => phone && exactPhoneOnPage(page.text, phone)))].slice(0, 2);
    if (!emails.length && !phones.length && !whatsapp.length) continue;
    const key = `${name.toLocaleLowerCase("en-US")}|${emails.join(",")}|${phones.join(",")}|${whatsapp.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push({
      kind: name ? "person" : "company",
      name: name || "公司公开联系",
      title,
      emails,
      phones,
      whatsapp,
      source: "website_probe",
      sourceLabel: "境外企业官网 · AI 原文整理",
      sourceKind: "official_website",
      confidence: name ? 78 : 74,
      verificationStatus: "source_confirmed",
      observedAt: new Date().toISOString(),
      reasonCodes: ["AI_STRUCTURED_PUBLIC_PAGE", "EXACT_SOURCE_TEXT_MATCH"],
      evidenceUrl: page.sourceUrl
    });
  }
  return contacts;
}

export async function extractWebsitePublicContactsWithAi(
  config: AiModelConfig,
  input: WebsiteContactAiInput
) {
  const pages = input.pages.slice(0, 2).map((page) => ({
    sourceUrl: page.sourceUrl,
    text: pageSource(page)
  })).filter((page) => page.text);
  if (!pages.length) return [];
  let remaining = MAX_TOTAL_TEXT_CHARS;
  const promptPages = pages.map((page, index) => {
    const text = page.text.slice(0, remaining);
    remaining -= text.length;
    return `PAGE ${index + 1}\nURL: ${page.sourceUrl}\nPUBLIC_TEXT:\n${text}`;
  }).filter((_page, index) => index === 0 || remaining >= 0);
  const prompt = [
    "你是企业官网公开联系方式整理器。输入来自已获准读取的境外企业官网页面。",
    "只整理原文中明确出现的联系人与联系渠道，禁止猜测、补全、推导或生成邮箱、电话、姓名和职位。",
    "每条记录必须属于同一个页面；姓名、职位、邮箱、电话和 WhatsApp 必须逐字存在于该 PAGE 的 PUBLIC_TEXT。",
    "无法关联到个人时 name 和 title 留空，作为公司公开渠道返回。不要把日期、订单号、传真标题或产品编号当电话。",
    "只返回 JSON：{\"contacts\":[{\"pageIndex\":1,\"name\":\"\",\"title\":\"\",\"emails\":[],\"phones\":[],\"whatsapp\":[],\"evidenceQuote\":\"原文中的连续短句\"}]}",
    `官网主域名：${input.domain}`,
    ...promptPages
  ].join("\n\n");
  const content = await callAiModel(config, prompt, 22_000, undefined, 45_000);
  return validateAiWebsiteContacts(extractJsonObject(content), pages);
}
