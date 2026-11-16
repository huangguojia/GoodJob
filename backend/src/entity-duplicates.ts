/**
 * 客户 / 线索查重口径。
 *
 * 2026-11-11：查重范围从「团队」收紧为「本人」——同一位业务员名下不允许重复录入
 * 同一家（公司名 + 国家），但同事各自的客户档案互不拦截。查询（/api/duplicates/check）
 * 和创建拦截（POST /api/customers、POST /api/leads）必须共用本文件的实现，
 * 否则会出现「查得到却建不进」或「查不到却被拦」。
 */

export type DuplicateEntityType = "customer" | "lead";

export interface DuplicateMatch {
  type: DuplicateEntityType;
  id: string;
  company: string;
  country: string;
  stage: string;
  status: string;
  ownerId: string;
  createdAt: string;
}

/** Customer 与 Lead 的公共可读字段；两者字段不完全一致，这里只声明查重要用到的。 */
export interface DuplicateCandidate {
  id: string;
  company: string;
  country: string;
  ownerId: string;
  stage?: string;
  status?: string;
  lifecycleStatus?: string;
  createdAt?: string;
}

export interface DuplicateCandidateSource {
  customers: DuplicateCandidate[];
  leads: DuplicateCandidate[];
}

export interface DuplicateQueryOptions {
  /** 编辑场景排除自身，避免「改客户名后提示与自己重复」 */
  excludeId?: string;
  includeCustomers?: boolean;
  includeLeads?: boolean;
}

/** 归一化「公司名 + 国家」重复判定键：去首尾空格、压平空白、统一小写 */
export function entityDuplicateKey(company: string, country: string) {
  const normalize = (value: string) => String(value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return `${normalize(company)}|${normalize(country)}`;
}

function toMatch(type: DuplicateEntityType, item: DuplicateCandidate): DuplicateMatch {
  return {
    type,
    id: item.id,
    company: item.company,
    country: item.country || "",
    stage: item.stage || "",
    status: item.status || item.lifecycleStatus || "",
    ownerId: item.ownerId,
    createdAt: item.createdAt || ""
  };
}

/**
 * 在当前用户名下查找重复的客户 / 线索。
 *
 * - 只比对 `ownerId`，不跨同事、不跨团队：同事已录的同一家不会挡住本人。
 * - 公司名为空时直接返回空结果（没有可比对的键）。
 * - 客户与线索分开比对，结果合并返回，交给调用方决定怎么呈现。
 */
export function ownedDuplicates(
  source: DuplicateCandidateSource,
  ownerId: string,
  company: string,
  country: string,
  options: DuplicateQueryOptions = {}
): DuplicateMatch[] {
  const normalizedCompany = String(company ?? "").trim();
  if (!normalizedCompany || !ownerId) return [];
  const key = entityDuplicateKey(normalizedCompany, country);
  const excludeId = options.excludeId || "";
  const matches: DuplicateMatch[] = [];

  if (options.includeCustomers !== false) {
    for (const item of source.customers) {
      if (item.id === excludeId || item.ownerId !== ownerId) continue;
      if (entityDuplicateKey(item.company, item.country) !== key) continue;
      matches.push(toMatch("customer", item));
    }
  }

  if (options.includeLeads !== false) {
    for (const item of source.leads) {
      if (item.id === excludeId || item.ownerId !== ownerId) continue;
      if (entityDuplicateKey(item.company, item.country) !== key) continue;
      matches.push(toMatch("lead", item));
    }
  }

  return matches;
}

/** 创建拦截用：返回第一条命中的本人记录（客户优先，与旧行为一致） */
export function findOwnedDuplicate(
  source: DuplicateCandidateSource,
  ownerId: string,
  company: string,
  country: string,
  options: DuplicateQueryOptions = {}
): DuplicateMatch | undefined {
  return ownedDuplicates(source, ownerId, company, country, options)[0];
}
