import { isIP } from "node:net";
import type {
  ProspectVerificationCheck,
  ProspectVerificationReport,
  ProviderEvidenceSnapshot,
  WebsiteOpportunity
} from "./types.js";

const PENDING_VALUES = new Set([
  "",
  "unknown",
  "未知",
  "待维护",
  "待人工核实",
  "n/a",
  "na"
]);

function normalized(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase();
}

function hasValue(value: unknown) {
  return !PENDING_VALUES.has(normalized(value));
}

function websiteDomain(value: string) {
  if (!value) return "";
  try {
    return new URL(/^https?:\/\//iu.test(value) ? value : `https://${value}`)
      .hostname
      .replace(/^www\./iu, "")
      .toLocaleLowerCase();
  } catch {
    return "";
  }
}

function evidenceTime(evidence: ProviderEvidenceSnapshot[], fallback: string) {
  return evidence
    .map((item) => item.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || fallback;
}

function isIdentityEvidence(item: ProviderEvidenceSnapshot) {
  return item.sourceLevel === "identity"
    || /(registry|registration|legal[_ -]?entity|company[_ -]?registry|lei)/iu.test(
      `${item.recordType} ${item.evidenceSummary}`
    );
}

function check(
  code: string,
  label: string,
  status: ProspectVerificationCheck["status"],
  summary: string,
  source: string,
  checkedAt: string
): ProspectVerificationCheck {
  return { code, label, status, summary, source, checkedAt };
}

export function buildProspectVerificationReport(
  opportunity: Pick<
    WebsiteOpportunity,
    | "website"
    | "contact"
    | "contactInfo"
    | "status"
    | "createdAt"
    | "verifiedAt"
    | "sourceEvidence"
    | "sourceLabel"
    | "source"
    | "lastReplyClassification"
    | "outreachState"
  >,
  generatedAt = new Date().toISOString()
): ProspectVerificationReport {
  const evidence = opportunity.sourceEvidence || [];
  const checkedAt = evidenceTime(evidence, opportunity.createdAt || generatedAt);
  const providers = [...new Set(evidence.map((item) => item.providerId).filter(Boolean))];
  const identityEvidence = evidence.filter(isIdentityEvidence);
  const candidateDomain = websiteDomain(opportunity.website || "");
  const evidenceWithDomains = evidence
    .map((item) => ({
      providerId: item.providerId,
      domain: websiteDomain(item.officialWebsite)
    }))
    .filter((item) => item.providerId && item.domain);
  const evidenceDomains = [...new Set(
    evidenceWithDomains.map((item) => item.domain)
  )];
  const matchingDomainProviders = [...new Set(
    evidenceWithDomains
      .filter((item) => item.domain === candidateDomain)
      .map((item) => item.providerId)
  )];
  const domainsConsistent = Boolean(
    candidateDomain
    && evidenceDomains.length === 1
    && evidenceDomains[0] === candidateDomain
  );
  const multiSourceDomainVerified = domainsConsistent
    && matchingDomainProviders.length >= 2;
  const contactEvidence = evidence.some((item) =>
    item.matchedFields.some((field) =>
      /(contact|email|phone|whatsapp|wechat)/iu.test(field)
    )
  );
  const manuallyVerified = Boolean(
    opportunity.verifiedAt
    || ["contactable", "contacted", "synced"].includes(opportunity.status)
  );
  const replied = opportunity.outreachState === "replied"
    || hasValue(opportunity.lastReplyClassification);

  let level: ProspectVerificationReport["level"] = "L0";
  if (evidence.length) level = "L1";
  if (identityEvidence.length) level = "L2";
  if (multiSourceDomainVerified) level = "L3";
  if (manuallyVerified) level = "L4";
  if (replied) level = "L5";

  const levelMeta: Record<
    ProspectVerificationReport["level"],
    { label: string; conclusion: string }
  > = {
    L0: {
      label: "链接待核实",
      conclusion: "仅完成链接登记，企业身份、业务范围和联系方式均需人工确认。"
    },
    L1: {
      label: "来源已记录",
      conclusion: "已取得 API 或搜索服务返回的来源记录，尚不能视为企业身份确认。"
    },
    L2: {
      label: "企业身份有据",
      conclusion: "已有企业登记或强身份来源证据，联系人与采购需求仍需人工确认。"
    },
    L3: {
      label: "多源一致",
      conclusion: "两个及以上独立来源指向一致企业域名，建议优先进行人工业务核验。"
    },
    L4: {
      label: "人工已核验",
      conclusion: "业务员已核验并确认可联系，可进入触达或线索流程。"
    },
    L5: {
      label: "触达已验证",
      conclusion: "已取得真实回复或有效互动，企业与联系方式可信度最高。"
    }
  };

  const checks: ProspectVerificationCheck[] = [
    check(
      "crawler_free_policy",
      "网页访问策略",
      "passed",
      "系统未访问、下载、解析或探测企业网页，仅保存链接和授权数据源返回字段。",
      "系统安全策略",
      generatedAt
    ),
    check(
      "website_reference",
      "官网链接",
      candidateDomain ? "partial" : "manual_required",
      candidateDomain
        ? `已登记域名 ${candidateDomain}；链接格式有效不代表官网真实性。`
        : "未登记可用官网链接，需要人工补充。",
      "链接登记",
      opportunity.createdAt || generatedAt
    ),
    check(
      "provider_evidence",
      "来源证据",
      evidence.length ? "partial" : "manual_required",
      evidence.length
        ? `已保留 ${evidence.length} 条来源记录，来自 ${providers.length} 个独立数据源。`
        : "当前没有结构化来源证据，仅可作为人工核验入口。",
      providers.join("、") || opportunity.sourceLabel || opportunity.source || "人工登记",
      checkedAt
    ),
    check(
      "enterprise_identity",
      "企业身份",
      identityEvidence.length ? "passed" : "unverified",
      identityEvidence.length
        ? `存在 ${identityEvidence.length} 条企业登记或强身份来源证据。`
        : "尚无企业登记或强身份来源证据。",
      identityEvidence.map((item) => item.providerId).join("、") || "待人工核实",
      checkedAt
    ),
    check(
      "multi_source_consistency",
      "多源一致性",
      multiSourceDomainVerified
        ? "passed"
        : providers.length >= 2 && evidenceDomains.length
          ? "partial"
          : "unverified",
      multiSourceDomainVerified
        ? `${matchingDomainProviders.length} 个独立来源均提供并指向域名 ${candidateDomain}。`
        : providers.length < 2
          ? "独立来源不足两个，无法完成多源交叉确认。"
          : !candidateDomain
            ? "候选未登记有效域名，无法核对多源域名一致性。"
            : evidenceDomains.length === 0
              ? "来源数量已满足，但没有来源提供可核对的企业域名证据。"
              : domainsConsistent
                ? `仅 ${matchingDomainProviders.length} 个来源提供域名 ${candidateDomain}，至少需要两个独立来源。`
                : `${providers.length} 个独立来源存在域名差异，需要人工判断是否为同一主体。`,
      matchingDomainProviders.join("、") || providers.join("、") || "待补充来源",
      checkedAt
    ),
    check(
      "contact_information",
      "联系方式",
      manuallyVerified && hasValue(opportunity.contactInfo || opportunity.contact)
        ? "passed"
        : contactEvidence && hasValue(opportunity.contactInfo || opportunity.contact)
          ? "partial"
          : "manual_required",
      manuallyVerified && hasValue(opportunity.contactInfo || opportunity.contact)
        ? "业务员已人工确认联系方式可用于触达。"
        : contactEvidence && hasValue(opportunity.contactInfo || opportunity.contact)
          ? "来源包含联系方式字段，但尚未经过业务员人工确认。"
          : "尚无已确认的联系方式，需要人工核实。",
      manuallyVerified ? "业务员人工核验" : contactEvidence ? "授权数据源" : "待人工核实",
      opportunity.verifiedAt || checkedAt
    )
  ];

  if (replied) {
    checks.push(check(
      "real_interaction",
      "真实互动",
      "passed",
      "已记录真实回复或有效互动，触达结果已进入业务闭环。",
      "CRM 触达记录",
      generatedAt
    ));
  }

  return {
    level,
    levelLabel: levelMeta[level].label,
    conclusion: levelMeta[level].conclusion,
    generatedAt,
    crawlerFree: true,
    checks
  };
}

export function withProspectVerificationReport<T extends WebsiteOpportunity>(
  opportunity: T,
  generatedAt = new Date().toISOString()
): T {
  opportunity.verificationReport = buildProspectVerificationReport(
    opportunity,
    generatedAt
  );
  return opportunity;
}

export function prospectVerificationReferenceTime(
  opportunity: Pick<
    WebsiteOpportunity,
    | "createdAt"
    | "verifiedAt"
    | "statusChangedAt"
    | "lastDevelopmentEmailAt"
    | "lastTouchpointAt"
    | "sourceEvidence"
  >
) {
  const timestamps = [
    opportunity.createdAt,
    opportunity.verifiedAt,
    opportunity.statusChangedAt,
    opportunity.lastDevelopmentEmailAt,
    opportunity.lastTouchpointAt,
    ...(opportunity.sourceEvidence || []).map((item) => item.fetchedAt)
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter(Number.isFinite);
  return timestamps.length
    ? new Date(Math.max(...timestamps)).toISOString()
    : "1970-01-01T00:00:00.000Z";
}

export function ensureProspectVerificationReport<
  T extends WebsiteOpportunity
>(opportunity: T): T {
  if (!opportunity.verificationReport) {
    withProspectVerificationReport(
      opportunity,
      prospectVerificationReferenceTime(opportunity)
    );
  }
  return opportunity;
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function isPrivateIpv6(hostname: string) {
  const value = hostname.toLocaleLowerCase();
  return value === "::"
    || value === "::1"
    || value.startsWith("fc")
    || value.startsWith("fd")
    || value.startsWith("fe8")
    || value.startsWith("fe9")
    || value.startsWith("fea")
    || value.startsWith("feb");
}

export function normalizeWebsiteReference(rawUrl: string) {
  const raw = rawUrl.trim();
  if (!raw) throw new Error("官网链接不能为空");
  const url = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("官网链接仅支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("官网链接不能包含账号或密码");
  }
  const hostname = url.hostname.replace(/\.$/u, "").toLocaleLowerCase();
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")) {
    throw new Error("官网链接不能使用本地地址");
  }
  const ipVersion = isIP(hostname);
  if ((ipVersion === 4 && isPrivateIpv4(hostname))
    || (ipVersion === 6 && isPrivateIpv6(hostname))) {
    throw new Error("官网链接不能使用内网或回环地址");
  }
  url.hostname = hostname;
  url.hash = "";
  return url.toString();
}

export function companyNameFromWebsiteReference(website: string) {
  const hostname = new URL(website).hostname.replace(/^www\./iu, "");
  const first = hostname.split(".")[0] || hostname;
  return first
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((item) => item.charAt(0).toLocaleUpperCase() + item.slice(1))
    .join(" ")
    || hostname;
}
