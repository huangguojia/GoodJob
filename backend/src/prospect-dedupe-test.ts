import assert from "node:assert/strict";
import { isSameProviderOpportunity, normalizeCrmCompanyName } from "./server.js";
import type { WebsiteOpportunity } from "./types.js";

let passed = 0;
function check(ok: boolean, label: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    process.exitCode = 1;
  }
}

function candidate(overrides: Partial<WebsiteOpportunity> = {}): WebsiteOpportunity {
  return {
    id: "cand_1",
    company: "",
    business: "paint manufacturing",
    country: "Thailand",
    website: "",
    contact: "",
    contactInfo: "",
    description: "",
    ownerId: "u_admin",
    teamId: "europe",
    status: "new",
    createdAt: new Date().toISOString(),
    ...overrides
  } as WebsiteOpportunity;
}

// ── normalizeCrmCompanyName：归一化与法律后缀剥离 ──
check(normalizeCrmCompanyName("Kansai Paint (Thailand) Co., Ltd.") === "kansai paint thailand",
  "后缀剥离：Co., Ltd. 与括号/大小写归一");
check(normalizeCrmCompanyName("KANSAI PAINT THAILAND") === "kansai paint thailand",
  "大小写归一一致");
check(normalizeCrmCompanyName("Công ty TNHH Sơn TOA Việt Nam") === "công ty sơn toa việt nam",
  "越南语 TNHH 后缀剥离");
check(normalizeCrmCompanyName("KTH Paint Industries Sdn. Bhd.") === "kth paint industries",
  "马来语 SDN BHD 后缀剥离");
check(normalizeCrmCompanyName("  3M  ") === "3m", "短名保留不误删");

// ── 第一/第二优先级键（原有行为不回归）──
const evidenceA = candidate({ id: "a", sourceEvidence: [{ providerId: "web", providerRecordId: "rec_1" } as never] });
const evidenceB = candidate({ id: "b", sourceEvidence: [{ providerId: "web", providerRecordId: "rec_1" } as never] });
check(isSameProviderOpportunity(evidenceA, evidenceB), "证据记录键相同 → 同一候选");
check(!isSameProviderOpportunity(
  candidate({ id: "a", website: "https://jotun.co.th" }),
  candidate({ id: "b", website: "https://jotun.co.jp", country: "Japan" })
), "同域名不同国家 → 不同候选（集团子公司保留）");
check(isSameProviderOpportunity(
  candidate({ id: "a", website: "https://jotun.co.th", country: "Thailand" }),
  candidate({ id: "b", website: "https://www.jotun.co.th/x", country: "Thailand" })
), "域名+国家相同 → 同一候选");

// ── 第三优先级键（本轮新增）：归一化公司名 + 国家 ──
check(isSameProviderOpportunity(
  candidate({ id: "a", company: "Kansai Paint (Thailand) Co., Ltd.", website: "https://kansaipaint.co.th" }),
  candidate({ id: "b", company: "KANSAI PAINT THAILAND", website: "https://kansai.co.th", source: "cli_acquisition" })
), "同名同国家不同域名 → 同一候选（本轮修复的缺口）");
check(!isSameProviderOpportunity(
  candidate({ id: "a", company: "TOA Paint (Thailand)", website: "https://toapaint.co.th" }),
  candidate({ id: "b", company: "TOA Paint (Vietnam) Company Limited", website: "https://toavietnam.vn", country: "Vietnam" })
), "同名不同国家 → 不同候选");
check(!isSameProviderOpportunity(
  candidate({ id: "a", company: "Nippon Paint Industrial Coatings", website: "https://nippon.co.th" }),
  candidate({ id: "b", company: "Nippon Paint Industrial Coatings", website: "https://nippon.co.jp", country: "" })
), "同名但一方国家缺失 → 不同候选（保守不并）");
check(!isSameProviderOpportunity(
  candidate({ id: "a", company: "3M", website: "https://3ma.co.th" }),
  candidate({ id: "b", company: "3M", website: "https://3mb.co.th" })
), "名字键过短(<4，如 3M)不触发名键合并 → 不同候选（保守）");
check(!isSameProviderOpportunity(
  candidate({ id: "a", company: "Alpha Chemical", website: "https://alpha-a.co.th" }),
  candidate({ id: "b", company: "Beta Chemical", website: "https://beta-b.co.th" })
), "不同名不同域 → 不同候选");

// ── 免费源契约保护：带独立来源记录键的同名记录必须保留 ──
check(!isSameProviderOpportunity(
  candidate({ id: "a", company: "Muster Company GmbH", sourceEvidence: [{ providerId: "gleif", providerRecordId: "rec_g" } as never] }),
  candidate({ id: "b", company: "Muster Company GmbH", sourceEvidence: [{ providerId: "wikidata", providerRecordId: "rec_w" } as never] })
), "双方都有独立来源记录键 → 同名也不合并（免费源契约）");
check(!isSameProviderOpportunity(
  candidate({ id: "a", company: "Muster Company GmbH", sourceEvidence: [{ providerId: "gleif", providerRecordId: "rec_g" } as never] }),
  candidate({ id: "b", company: "Muster Company GmbH", website: "https://muster.co.th" })
), "一方有来源记录键 → 不走名字键（保守）");

console.log(`prospect-dedupe-test: ${passed} assertions passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
