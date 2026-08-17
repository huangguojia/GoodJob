import { createHash } from "node:crypto";
import type { AiWebSearchCitation } from "./ai-model-runtime.js";
import type { ProviderRecord } from "./provider-contract.js";
import type { WebsiteOpportunity } from "./types.js";

export function aiWebsiteCitationsToProviderRecords(
  candidate: Pick<WebsiteOpportunity, "company" | "country" | "business">,
  citations: AiWebSearchCitation[]
): ProviderRecord[] {
  const fetchedAt = new Date().toISOString();
  return citations.flatMap((citation) => {
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      return [];
    }
    if (url.protocol !== "https:" || url.username || url.password) return [];
    const sourceUrl = url.toString();
    const title = citation.title.trim() || url.hostname;
    const payloadHash = createHash("sha256")
      .update(`${candidate.company}:${sourceUrl}`)
      .digest("hex");
    return [{
      company: title,
      officialWebsite: sourceUrl,
      website: sourceUrl,
      country: candidate.country,
      business: candidate.business,
      contact: "",
      contactInfo: "",
      description: "OpenAI Web Search 返回的官网候选，需继续通过名称与域名评分确认。",
      confidence: 70,
      providerRecordId: payloadHash.slice(0, 24),
      sourceUrl,
      recordType: "discovery_page",
      fetchedAt,
      payloadHash,
      evidenceSummary: title,
      matchedFields: ["officialWebsite"],
      adapterVersion: "openai-native-web-search-v1",
      catalogPolicyVersion: "openai-native-web-search-v1",
      sourceLevel: "discovery",
      retentionPolicyRef: "prospect-official-website-citation"
    }];
  });
}
