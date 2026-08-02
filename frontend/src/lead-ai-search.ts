export interface LeadAiSearchDraft {
  name: string;
  products: string[];
  markets: string[];
  industries: string[];
  exclusions: string[];
  customerType: string;
}

export interface ResolvedLeadAiSearchDraft {
  parsedName: string;
  products: string[];
  markets: string[];
  industries: string[];
  exclusions: string[];
  customerType: string;
  marketOpen: boolean;
}

function normalizedValues(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function resolveLeadAiSearchDraft(draft: LeadAiSearchDraft): ResolvedLeadAiSearchDraft {
  const products = normalizedValues(draft.products);
  if (!products.length) throw new Error("AI 解析结果中的产品关键词不能为空");
  const requestedMarkets = normalizedValues(draft.markets);
  const marketOpen = requestedMarkets.length === 0
    || requestedMarkets.some((market) => /^(global|全球|all|worldwide|不限)$/i.test(market));
  return {
    parsedName: draft.name.trim(),
    products,
    markets: marketOpen ? ["Global"] : requestedMarkets,
    industries: normalizedValues(draft.industries),
    exclusions: normalizedValues(draft.exclusions),
    customerType: draft.customerType.trim() || "*",
    marketOpen
  };
}
