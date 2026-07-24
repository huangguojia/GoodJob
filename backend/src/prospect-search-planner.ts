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

function selectedMarkets(countries: string[], roundNo: number, depth: ProspectSuperSearchDepth) {
  if (countries.length <= 1) return [...countries];
  const size = depth === "balanced" ? 2 : depth === "deep" ? 3 : 4;
  const start = ((roundNo - 1) * size) % countries.length;
  return Array.from({ length: Math.min(size, countries.length) }, (_, index) => countries[(start + index) % countries.length]);
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

export function validateProspectSearchQueryPlan(input: {
  metadata: ProspectSearchQueryPlanMetadata;
  resolvedQuery: ProspectResolvedQuerySnapshot;
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
    })) {
    throw new Error("超级搜索查询计划完整性校验失败");
  }
}

export function planProspectSearchRound(input: ProspectSearchRoundPlanInput): ProspectSearchRoundPlan {
  if (!Number.isInteger(input.roundNo) || input.roundNo < 1 || input.roundNo > input.maxRounds) {
    throw new Error("超级搜索轮次超出规划范围");
  }
  const theme = themes[(input.roundNo - 1) % themes.length];
  const markets = selectedMarkets(unique(input.baseQuery.countries), input.roundNo, input.depth);
  const locale = localeTerms(markets);
  const useLocalChannel = theme.code === "local_channel";
  const useLocalProcurement = theme.code === "procurement" || theme.code === "vendor_registration" || theme.code === "contract_award";
  const resolvedQuery: ProspectResolvedQuerySnapshot = {
    ...structuredClone(input.baseQuery),
    positiveKeywords: unique(input.baseQuery.positiveKeywords),
    synonyms: unique(input.baseQuery.synonyms),
    industryTerms: unique([...input.baseQuery.industryTerms, ...theme.industryTerms]),
    purchaseScenarioTerms: unique([
      ...input.baseQuery.purchaseScenarioTerms,
      ...theme.purchaseTerms,
      ...(useLocalChannel ? locale.channelTerms : []),
      ...(useLocalProcurement ? locale.procurementTerms : [])
    ]),
    countries: markets,
    languages: unique([...input.baseQuery.languages, ...locale.languages]),
    customerTypes: unique([...input.baseQuery.customerTypes, ...theme.customerTypes]),
    exclusionKeywords: unique(input.baseQuery.exclusionKeywords),
    exclusionDomains: unique(input.baseQuery.exclusionDomains)
  };
  const fingerprint = prospectSearchQueryPlanFingerprint({
    missionId: input.missionId,
    roundNo: input.roundNo,
    theme: theme.code,
    planningMode: "rules",
    resolvedQuery
  });
  const metadata: ProspectSearchQueryPlanMetadata = {
    source: "super_search",
    plannerVersion: PROSPECT_SEARCH_PLANNER_VERSION,
    missionId: input.missionId,
    roundNo: input.roundNo,
    theme: theme.code,
    planningMode: "rules",
    fingerprint
  };
  const providers = unique(input.providerIds, 30);
  const market = markets.length ? markets.join(", ") : "global";
  const customerType = resolvedQuery.customerTypes.join(", ") || "unrestricted";
  const language = resolvedQuery.languages.join(", ") || "auto";
  const queryText = unique([
    ...resolvedQuery.positiveKeywords,
    ...resolvedQuery.synonyms,
    ...resolvedQuery.purchaseScenarioTerms
  ], 16).join(" ").slice(0, 600);
  const queryCells: ProspectSearchQueryCell[] = [];
  for (const providerId of providers) {
    const cellBase = { market, language, customerType, queryTheme: theme.code, providerId, queryText };
    queryCells.push({ ...cellBase, fingerprint: hash(cellBase), status: "planned" });
  }
  return {
    resolvedQuery,
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
    synonyms: unique([...plan.resolvedQuery.synonyms, ...(enhancement.synonyms || [])]),
    industryTerms: unique([...plan.resolvedQuery.industryTerms, ...(enhancement.industryTerms || [])]),
    purchaseScenarioTerms: unique([
      ...plan.resolvedQuery.purchaseScenarioTerms,
      ...(enhancement.purchaseScenarioTerms || [])
    ]),
    customerTypes: unique([...plan.resolvedQuery.customerTypes, ...(enhancement.customerTypes || [])]),
    languages: unique([...plan.resolvedQuery.languages, ...(enhancement.languages || [])])
  };
  const metadata: ProspectSearchQueryPlanMetadata = {
    ...plan.metadata,
    planningMode: "ai_enhanced",
    fingerprint: prospectSearchQueryPlanFingerprint({
      missionId: plan.metadata.missionId,
      roundNo: plan.metadata.roundNo,
      theme: plan.metadata.theme,
      planningMode: "ai_enhanced",
      resolvedQuery
    })
  };
  const queryText = unique([
    ...resolvedQuery.positiveKeywords,
    ...resolvedQuery.synonyms,
    ...resolvedQuery.purchaseScenarioTerms
  ], 16).join(" ").slice(0, 600);
  const queryCells = plan.queryCells.map((cell) => {
    const cellBase = {
      market: cell.market,
      language: resolvedQuery.languages.join(", ") || cell.language,
      customerType: resolvedQuery.customerTypes.join(", ") || cell.customerType,
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
    metadata,
    queryCells,
    coverageGaps: [
      ...plan.coverageGaps,
      `AI 已补充 ${addedCount} 个受控查询表达，企业事实仍由数据源返回`
    ]
  };
}
