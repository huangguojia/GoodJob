import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  ProspectResolvedQuerySnapshot,
  ProspectSearchQueryCell,
  ProspectSearchQueryPlanMetadata,
  ProspectSuperSearchDepth
} from "./types.js";

export const PROSPECT_SEARCH_PLANNER_VERSION = "deep-search-planner-v1";

interface PreviousRoundMetric {
  roundNo: number;
  rawCount: number;
  candidateCount: number;
  duplicateRate: number;
  yieldRate: number;
  queryTheme?: string;
}

export interface ProspectSearchRoundPlan {
  resolvedQuery: ProspectResolvedQuerySnapshot;
  providerResolvedQueries: Record<string, ProspectResolvedQuerySnapshot>;
  metadata: ProspectSearchQueryPlanMetadata;
  coverageGaps: string[];
  queryCells: ProspectSearchQueryCell[];
}

export interface ProspectSearchRoundPlanInput {
  baseQuery: ProspectResolvedQuerySnapshot;
  missionId: string;
  roundNo: number;
  maxRounds: number;
  depth: ProspectSuperSearchDepth;
  providerIds: string[];
  providerKinds?: Record<string, string>;
  previousRounds?: PreviousRoundMetric[];
}

export interface ProspectSearchAiEnhancement {
  synonyms?: string[];
  industryTerms?: string[];
  purchaseScenarioTerms?: string[];
  customerTypes?: string[];
  languages?: string[];
}

interface SearchTheme {
  code: string;
  purchaseTerms: string[];
  customerTypes: string[];
  industryTerms: string[];
}

const themes: SearchTheme[] = [
  { code: "baseline", purchaseTerms: ["supplier", "buyer"], customerTypes: [], industryTerms: [] },
  { code: "local_channel", purchaseTerms: ["distributor", "dealer", "stockist", "sales partner"], customerTypes: ["distributor", "dealer"], industryTerms: [] },
  { code: "procurement", purchaseTerms: ["procurement", "rfq", "request for quotation", "tender", "purchasing"], customerTypes: ["buyer", "importer"], industryTerms: [] },
  { code: "project_engineering", purchaseTerms: ["project", "epc", "engineering contractor", "system integrator"], customerTypes: ["epc", "system integrator"], industryTerms: ["engineering"] },
  { code: "trade_channel", purchaseTerms: ["importer", "wholesaler", "regional distributor"], customerTypes: ["importer", "wholesaler"], industryTerms: [] },
  { code: "oem_integration", purchaseTerms: ["oem", "integrator", "manufacturer", "private label"], customerTypes: ["oem", "integrator", "manufacturer"], industryTerms: [] },
  { code: "vendor_registration", purchaseTerms: ["vendor registration", "approved supplier", "supplier portal", "prequalification"], customerTypes: ["procurement organization"], industryTerms: [] },
  { code: "directory_association", purchaseTerms: ["industry association", "member directory", "supplier directory", "catalogue"], customerTypes: ["association member"], industryTerms: [] },
  { code: "aftermarket_service", purchaseTerms: ["mro", "maintenance supplier", "replacement", "aftermarket"], customerTypes: ["service company", "mro supplier"], industryTerms: ["maintenance"] },
  { code: "contract_award", purchaseTerms: ["contract award", "awarded supplier", "framework agreement"], customerTypes: ["contractor", "supplier"], industryTerms: [] },
  { code: "expansion_signal", purchaseTerms: ["plant expansion", "new facility", "capacity expansion", "investment project"], customerTypes: ["project owner", "manufacturer"], industryTerms: [] },
  { code: "certification_ecosystem", purchaseTerms: ["certified partner", "authorized distributor", "approved vendor list"], customerTypes: ["authorized distributor", "certified partner"], industryTerms: [] },
  { code: "regional_long_tail", purchaseTerms: ["regional supplier", "local representative", "technical sales"], customerTypes: ["local representative"], industryTerms: [] },
  { code: "application_specialist", purchaseTerms: ["application specialist", "solution provider", "turnkey solution"], customerTypes: ["solution provider"], industryTerms: [] },
  { code: "replacement_demand", purchaseTerms: ["retrofit", "replacement project", "modernization"], customerTypes: ["retrofit contractor"], industryTerms: [] },
  { code: "coverage_recovery", purchaseTerms: ["supplier", "distributor", "procurement", "project"], customerTypes: [], industryTerms: [] }
];

const localeProfiles: Array<{
  aliases: string[];
  language: string;
  channelTerms: string[];
  procurementTerms: string[];
}> = [
  { aliases: ["germany", "deutschland", "austria", "osterreich", "switzerland", "schweiz"], language: "de", channelTerms: ["handler", "vertriebspartner", "lieferant"], procurementTerms: ["einkauf", "ausschreibung", "angebotsanfrage"] },
  { aliases: ["france", "belgium", "luxembourg"], language: "fr", channelTerms: ["distributeur", "revendeur", "fournisseur"], procurementTerms: ["achat", "appel d'offres", "demande de devis"] },
  { aliases: ["spain", "espana", "mexico", "argentina", "chile", "colombia"], language: "es", channelTerms: ["distribuidor", "proveedor", "mayorista"], procurementTerms: ["compras", "licitacion", "solicitud de cotizacion"] },
  { aliases: ["italy", "italia"], language: "it", channelTerms: ["distributore", "rivenditore", "fornitore"], procurementTerms: ["acquisti", "gara", "richiesta di offerta"] },
  { aliases: ["brazil", "brasil", "portugal"], language: "pt", channelTerms: ["distribuidor", "revendedor", "fornecedor"], procurementTerms: ["compras", "licitacao", "pedido de cotacao"] },
  { aliases: ["netherlands", "nederland"], language: "nl", channelTerms: ["distributeur", "dealer", "leverancier"], procurementTerms: ["inkoop", "aanbesteding", "offerteaanvraag"] },
  { aliases: ["poland", "polska"], language: "pl", channelTerms: ["dystrybutor", "dealer", "dostawca"], procurementTerms: ["zakupy", "przetarg", "zapytanie ofertowe"] },
  { aliases: ["turkey", "turkiye"], language: "tr", channelTerms: ["distributor", "bayi", "tedarikci"], procurementTerms: ["satinalma", "ihale", "teklif talebi"] },
  { aliases: ["japan", "nihon"], language: "ja", channelTerms: ["distributor japan", "sales agent japan", "supplier japan"], procurementTerms: ["procurement japan", "tender japan", "quotation japan"] },
  { aliases: ["south korea", "korea"], language: "ko", channelTerms: ["distributor korea", "dealer korea", "supplier korea"], procurementTerms: ["procurement korea", "tender korea", "quotation korea"] }
];

function hash(value: unknown) {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ").slice(0, 200);
}

function unique(values: string[], limit = 100) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = normalize(value);
    if (!item || seen.has(item) || item === "all" || item === "全部") continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function selectedMarket(countries: string[], roundNo: number) {
  if (!countries.length) return "global";
  return countries[(roundNo - 1) % countries.length]!;
}

function localeTerms(markets: string[]) {
  const profiles = localeProfiles.filter((profile) => markets.some((market) =>
    profile.aliases.some((alias) => normalize(market).includes(alias))
  ));
  return {
    languages: unique(profiles.map((item) => item.language), 12),
    channelTerms: unique(profiles.flatMap((item) => item.channelTerms), 30),
    procurementTerms: unique(profiles.flatMap((item) => item.procurementTerms), 30)
  };
}

function coverageGaps(previous: PreviousRoundMetric[]) {
  if (!previous.length) return ["尚无历史轮次，建立基础覆盖基线"];
  const last = previous[previous.length - 1];
  const gaps: string[] = [];
  if (last.rawCount === 0) gaps.push(`“${last.queryTheme || `第 ${last.roundNo} 轮`}”无返回，切换查询主题与买家表达`);
  if (last.yieldRate < 0.03) gaps.push("有效候选率低于 3%，扩大长尾采购与渠道表达");
  if (last.duplicateRate > 0.9) gaps.push("重复率超过 90%，轮换市场、语言和业务信号");
  if (!gaps.length) gaps.push("当前轮仍有边际产出，继续覆盖尚未执行的查询主题");
  return gaps;
}

export function prospectSearchQueryPlanFingerprint(input: {
  missionId: string;
  roundNo: number;
  theme: string;
  planningMode?: "rules" | "ai_enhanced";
  resolvedQuery: ProspectResolvedQuerySnapshot;
  providerResolvedQueries?: Record<string, ProspectResolvedQuerySnapshot>;
}) {
  return hash({
    plannerVersion: PROSPECT_SEARCH_PLANNER_VERSION,
    missionId: input.missionId,
    roundNo: input.roundNo,
    theme: input.theme,
    planningMode: input.planningMode || "rules",
    resolvedQuery: input.resolvedQuery
  });
}

export function prospectProviderQueriesFingerprint(
  providerResolvedQueries: Record<string, ProspectResolvedQuerySnapshot>
) {
  return hash({
    plannerVersion: PROSPECT_SEARCH_PLANNER_VERSION,
    providerResolvedQueries
  });
}

export function validateProspectSearchQueryPlan(input: {
  metadata: ProspectSearchQueryPlanMetadata;
  resolvedQuery: ProspectResolvedQuerySnapshot;
  providerResolvedQueries?: Record<string, ProspectResolvedQuerySnapshot>;
}) {
  if (input.metadata.source !== "super_search"
    || input.metadata.plannerVersion !== PROSPECT_SEARCH_PLANNER_VERSION
    || input.metadata.roundNo < 1
    || input.metadata.fingerprint !== prospectSearchQueryPlanFingerprint({
      missionId: input.metadata.missionId,
      roundNo: input.metadata.roundNo,
      theme: input.metadata.theme,
      planningMode: input.metadata.planningMode,
      resolvedQuery: input.resolvedQuery
    })
    || Boolean(input.metadata.providerQueriesFingerprint
      && input.providerResolvedQueries
      && input.metadata.providerQueriesFingerprint !== prospectProviderQueriesFingerprint(input.providerResolvedQueries))) {
    throw new Error("超级搜索查询计划完整性校验失败");
  }
}

function providerKind(providerId: string, configured = "") {
  const value = `${providerId} ${configured}`.toLocaleLowerCase("en-US");
  if (/google_places|maps?|places/u.test(value)) return "maps";
  if (/procurement|tender|contract|award|sam_gov|ted_europa/u.test(value)) return "procurement";
  if (/registry|identity|companies_house|sec_edgar|gleif|company_search/u.test(value)) return "registry";
  if (/ai_search|\bai\b/u.test(value)) return "ai";
  return "web";
}

export function buildProspectProviderResolvedQueries(input: {
  resolvedQuery: ProspectResolvedQuerySnapshot;
  providerIds: string[];
  providerKinds?: Record<string, string>;
  focusCompany?: string;
}) {
  const result: Record<string, ProspectResolvedQuerySnapshot> = {};
  const focusCompany = normalize(input.focusCompany || "");
  for (const providerId of unique(input.providerIds, 30)) {
    const kind = providerKind(providerId, input.providerKinds?.[providerId]);
    const base = structuredClone(input.resolvedQuery);
    if (kind === "maps") {
      result[providerId] = {
        ...base,
        positiveKeywords: unique([focusCompany, ...base.positiveKeywords], 12),
        purchaseScenarioTerms: unique(["distributor", "dealer", "supplier", ...base.purchaseScenarioTerms], 12),
        customerTypes: unique(["distributor", "dealer", ...base.customerTypes], 12)
      };
    } else if (kind === "procurement") {
      result[providerId] = {
        ...base,
        positiveKeywords: unique([focusCompany, ...base.positiveKeywords], 12),
        purchaseScenarioTerms: unique(["rfq", "tender", "contract award", "procurement", "approved supplier", ...base.purchaseScenarioTerms], 16),
        customerTypes: unique(["buyer", "supplier", "contractor", ...base.customerTypes], 12)
      };
    } else if (kind === "registry") {
      result[providerId] = {
        ...base,
        positiveKeywords: unique([focusCompany || base.positiveKeywords[0] || ""], 2),
        synonyms: [],
        industryTerms: [],
        purchaseScenarioTerms: [],
        customerTypes: []
      };
    } else if (kind === "ai") {
      result[providerId] = {
        ...base,
        positiveKeywords: unique([focusCompany, ...base.positiveKeywords], 12),
        purchaseScenarioTerms: unique(["source-backed company relationship", "official source", "public evidence", ...base.purchaseScenarioTerms], 16)
      };
    } else {
      result[providerId] = {
        ...base,
        positiveKeywords: unique([focusCompany, ...base.positiveKeywords], 12),
        purchaseScenarioTerms: unique([...(focusCompany ? ["subsidiary", "distributor", "partner", "supplier", "project"] : []), ...base.purchaseScenarioTerms], 18)
      };
    }
  }
  return result;
}

export function planProspectSearchRound(input: ProspectSearchRoundPlanInput): ProspectSearchRoundPlan {
  if (!Number.isInteger(input.roundNo) || input.roundNo < 1 || input.roundNo > input.maxRounds) {
    throw new Error("超级搜索轮次超出规划范围");
  }
  const theme = themes[(input.roundNo - 1) % themes.length];
  const market = selectedMarket(unique(input.baseQuery.countries), input.roundNo);
  const locale = localeTerms([market]);
  const useLocalChannel = theme.code === "local_channel";
  const useLocalProcurement = theme.code === "procurement" || theme.code === "vendor_registration" || theme.code === "contract_award";
  const keywordVariants = unique([
    ...input.baseQuery.positiveKeywords,
    ...input.baseQuery.synonyms
  ]);
  const keyword = keywordVariants[(input.roundNo - 1) % Math.max(1, keywordVariants.length)] || "business supplier";
  const customerTypes = unique([
    ...theme.customerTypes,
    ...input.baseQuery.customerTypes
  ]);
  const customerType = customerTypes[(input.roundNo - 1) % Math.max(1, customerTypes.length)] || "unrestricted";
  const languageChoices = unique([
    ...(theme.code === "baseline" ? ["en"] : []),
    ...locale.languages,
    ...input.baseQuery.languages,
    "en"
  ]);
  const language = languageChoices[(input.roundNo - 1) % languageChoices.length] || "en";
  const purchaseTerms = unique([
    ...(useLocalChannel ? locale.channelTerms : []),
    ...(useLocalProcurement ? locale.procurementTerms : []),
    ...theme.purchaseTerms,
    ...input.baseQuery.purchaseScenarioTerms
  ]);
  const purchaseTerm = purchaseTerms[(input.roundNo - 1) % Math.max(1, purchaseTerms.length)] || "supplier";
  const industryTerms = unique([
    ...theme.industryTerms,
    ...input.baseQuery.industryTerms
  ]);
  const industryTerm = industryTerms[(input.roundNo - 1) % Math.max(1, industryTerms.length)] || "";
  const resolvedQuery: ProspectResolvedQuerySnapshot = {
    ...structuredClone(input.baseQuery),
    positiveKeywords: [keyword],
    synonyms: [],
    industryTerms: industryTerm ? [industryTerm] : [],
    purchaseScenarioTerms: [purchaseTerm],
    countries: [market],
    languages: [language],
    customerTypes: [customerType],
    exclusionKeywords: unique(input.baseQuery.exclusionKeywords),
    exclusionDomains: unique(input.baseQuery.exclusionDomains)
  };
  const providerResolvedQueries = buildProspectProviderResolvedQueries({
    resolvedQuery,
    providerIds: input.providerIds,
    providerKinds: input.providerKinds
  });
  const fingerprint = prospectSearchQueryPlanFingerprint({
    missionId: input.missionId,
    roundNo: input.roundNo,
    theme: theme.code,
    planningMode: "rules",
    resolvedQuery,
    providerResolvedQueries
  });
  const metadata: ProspectSearchQueryPlanMetadata = {
    source: "super_search",
    plannerVersion: PROSPECT_SEARCH_PLANNER_VERSION,
    missionId: input.missionId,
    roundNo: input.roundNo,
    theme: theme.code,
    planningMode: "rules",
    fingerprint,
    providerQueriesFingerprint: prospectProviderQueriesFingerprint(providerResolvedQueries)
  };
  const providers = unique(input.providerIds, 30);
  const queryCells: ProspectSearchQueryCell[] = [];
  for (const providerId of providers) {
    const providerQuery = providerResolvedQueries[providerId] || resolvedQuery;
    const queryText = unique([
      ...providerQuery.positiveKeywords,
      ...providerQuery.synonyms,
      ...providerQuery.industryTerms,
      ...providerQuery.purchaseScenarioTerms,
      customerType,
      market
    ], 16).join(" ").slice(0, 600);
    const cellBase = { market, language, customerType, queryTheme: theme.code, providerId, queryText };
    queryCells.push({ ...cellBase, fingerprint: hash(cellBase), status: "planned" });
  }
  return {
    resolvedQuery,
    providerResolvedQueries,
    metadata,
    coverageGaps: coverageGaps(input.previousRounds || []),
    queryCells
  };
}

export function enhanceProspectSearchRoundPlan(
  plan: ProspectSearchRoundPlan,
  enhancement: ProspectSearchAiEnhancement
): ProspectSearchRoundPlan {
  const resolvedQuery: ProspectResolvedQuerySnapshot = {
    ...structuredClone(plan.resolvedQuery),
    synonyms: unique([...(enhancement.synonyms || []), ...plan.resolvedQuery.synonyms], 1),
    industryTerms: unique([...(enhancement.industryTerms || []), ...plan.resolvedQuery.industryTerms], 1),
    purchaseScenarioTerms: unique([...(enhancement.purchaseScenarioTerms || []), ...plan.resolvedQuery.purchaseScenarioTerms], 1),
    customerTypes: unique([...(enhancement.customerTypes || []), ...plan.resolvedQuery.customerTypes], 1),
    languages: unique([...(enhancement.languages || []), ...plan.resolvedQuery.languages], 1)
  };
  const providerResolvedQueries = buildProspectProviderResolvedQueries({
    resolvedQuery,
    providerIds: plan.queryCells.map((item) => item.providerId)
  });
  const metadata: ProspectSearchQueryPlanMetadata = {
    ...plan.metadata,
    planningMode: "ai_enhanced",
    fingerprint: prospectSearchQueryPlanFingerprint({
      missionId: plan.metadata.missionId,
      roundNo: plan.metadata.roundNo,
      theme: plan.metadata.theme,
      planningMode: "ai_enhanced",
      resolvedQuery,
    }),
    providerQueriesFingerprint: prospectProviderQueriesFingerprint(providerResolvedQueries)
  };
  const queryCells = plan.queryCells.map((cell) => {
    const providerQuery = providerResolvedQueries[cell.providerId] || resolvedQuery;
    const queryText = unique([
      ...providerQuery.positiveKeywords,
      ...providerQuery.synonyms,
      ...providerQuery.industryTerms,
      ...providerQuery.purchaseScenarioTerms,
      ...providerQuery.customerTypes,
      ...providerQuery.countries
    ], 16).join(" ").slice(0, 600);
    const cellBase = {
      market: cell.market,
      language: resolvedQuery.languages[0] || cell.language,
      customerType: resolvedQuery.customerTypes[0] || cell.customerType,
      queryTheme: cell.queryTheme,
      providerId: cell.providerId,
      queryText
    };
    return {
      ...cellBase,
      fingerprint: hash(cellBase),
      status: "planned" as const
    };
  });
  const addedCount = Object.values(enhancement).reduce(
    (sum, values) => sum + (Array.isArray(values) ? values.length : 0),
    0
  );
  return {
    resolvedQuery,
    providerResolvedQueries,
    metadata,
    queryCells,
    coverageGaps: [
      ...plan.coverageGaps,
      `AI 已补充 ${addedCount} 个受控查询表达，企业事实仍由数据源返回`
    ]
  };
}
