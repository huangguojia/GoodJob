import {
  CrmUnavailableError,
  crmRequestJson,
  crmTransportUnavailableReason,
  resolveCrmTransport,
  type CrmClientOptions,
  type CrmTransport
} from "./crm-client.js";
import type { ComposeMessage } from "./auto-chat-service.js";

export { CrmUnavailableError } from "./crm-client.js";

/**
 * CRM「资源中心」通道（`docs/RESOURCE-HUB-DESIGN.md` 的 4 个 /api/agent/resources* 接口）。
 *
 * 与 `CrmClient` 的分工：`CrmClient` 是只读的客户/报价/知识通道（GET only）；
 * 这里走的是资源中心的 POST 接口（长对话载荷 + 有副作用的 reveal/feedback）。
 * 两者共用同一份 transport 与自签 token 口径，避免超时/鉴权行为分叉。
 *
 * ⚠️ 真实外链**只从 reveal 拿**，而且只在业务员真的点了「复制链接 / 打开」时调用。
 * 推荐结果里永远不含 URL —— 这不是约定，是 CRM 侧的类型层面就下不来的。
 */

export const RESOURCE_LIST_PATH = "/api/agent/resources";
export const RESOURCE_RECOMMEND_PATH = "/api/agent/resources/recommend";
export const RESOURCE_FEEDBACK_PATH = "/api/agent/resources/feedback";
export const RESOURCE_STATS_PATH = "/api/agent/resources/stats";

export function resourceRevealPath(sourceType: ResourceSourceType | string, id: string): string {
  return `/api/agent/resources/${encodeURIComponent(sourceType)}/${encodeURIComponent(id)}/reveal`;
}

export const RESOURCE_SOURCE_TYPES = ["file", "skill", "knowledge", "product"] as const;
export type ResourceSourceType = (typeof RESOURCE_SOURCE_TYPES)[number];

export type ResourceReasonKind = "lexical" | "structured" | "semantic" | "vector";

export interface CrmResourceReason {
  kind: ResourceReasonKind;
  text: string;
}

export interface CrmResourceMatch {
  lexical: number;
  structured: number;
  semantic: number;
  vector: number;
}

/** 一条候选资源。**没有 url 字段** —— 真实地址只能经 reveal 取。 */
export interface CrmResourceCandidate {
  id: string;
  sourceType: ResourceSourceType;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  fileType: string;
  version: string;
  author: string;
  updatedAt: string;
  accessCount: number;
  hasExternalLink: boolean;
  score: number;
  /** 一句给业务员看的结论，如「「led」「规格书」都在这份资料里」 */
  headline: string;
  match: CrmResourceMatch;
  reasons: CrmResourceReason[];
  hitTerms: string[];
}

export interface CrmResourceRetrieval {
  mode: string;
  scanned: number;
  candidates: number;
  vectorEnabled: boolean;
  tookMs: number;
}

export interface CrmRecommendationResponse {
  recommendations: CrmResourceCandidate[];
  retrieval: CrmResourceRetrieval;
  customer: { matched: boolean; id: string; company: string };
  warnings: string[];
}

export type CrmResourceAccess =
  | { kind: "external"; url: string; shareCode: string }
  | { kind: "inline"; content: string };

export interface CrmRevealResponse {
  resource: { id: string; sourceType: ResourceSourceType; title: string; fileType: string };
  access: CrmResourceAccess;
  accessId: string;
}

export interface CrmFeedbackResponse {
  recorded: number;
  ignored: number;
}

/** 推荐效果报表（CRM `GET /api/agent/resources/stats` 的响应形状）。 */
export interface CrmResourceStatsResponse {
  days: number;
  totals: {
    exposed: number;
    revealed: number;
    accepted: number;
    dismissed: number;
    sent: number;
    /** accepted / max(1, revealed)——分母都是 revealed：看到了才谈得上采纳/发送。 */
    adoptionRate: number;
    sendRate: number;
  };
  items: Array<{
    sourceType: ResourceSourceType;
    resourceId: string;
    title: string;
    counts: { exposed: number; revealed: number; accepted: number; dismissed: number; sent: number };
    adoptionRate: number;
    sendRate: number;
  }>;
  warnings: string[];
}

export interface RecommendResourceInput {
  conversation: Array<{ role: "customer" | "agent"; text: string }>;
  customerId?: string;
  conversationKey?: string;
  limit?: number;
  sourceTypes?: ResourceSourceType[];
  signal?: "inbound" | "compose" | "manual";
  queryVector?: number[];
  timeoutMs?: number;
}

export interface ResourceFeedbackItem {
  resourceId: string;
  sourceType: ResourceSourceType;
  action: "accepted" | "dismissed" | "sent";
}

/** 现场对话 → CRM 的 conversation 形状。inbound = 客户说，outbound = 我方说。 */
export function toCrmConversation(messages: ComposeMessage[]): Array<{ role: "customer" | "agent"; text: string }> {
  return messages
    .map((message) => ({
      role: message.direction === "inbound" ? ("customer" as const) : ("agent" as const),
      text: String(message.body || "").trim()
    }))
    .filter((message) => message.text.length > 0)
    .slice(-20);
}

export class ResourceHubClient {
  private readonly transport: CrmTransport;

  constructor(options: CrmClientOptions) {
    this.transport = resolveCrmTransport(options);
  }

  get configured(): boolean {
    return Boolean(this.transport.baseUrl && this.transport.jwtSecret);
  }

  unavailableReason(): string {
    return crmTransportUnavailableReason(this.transport);
  }

  async list(
    userId: string,
    options: { q?: string; sourceType?: ResourceSourceType | "all"; category?: string; fileType?: string; limit?: number } = {}
  ) {
    return crmRequestJson<{ resources: CrmResourceCandidate[]; total: number; retrievalMode: string; vectorEnabled: boolean }>(
      this.transport,
      userId,
      RESOURCE_LIST_PATH,
      {
        method: "GET",
        query: {
          q: options.q,
          sourceType: options.sourceType,
          category: options.category,
          fileType: options.fileType,
          limit: options.limit
        }
      }
    );
  }

  async recommend(userId: string, input: RecommendResourceInput): Promise<CrmRecommendationResponse> {
    if (!input.conversation.length) throw new CrmUnavailableError("没有可用的对话内容，无法推荐资料");
    return crmRequestJson<CrmRecommendationResponse>(this.transport, userId, RESOURCE_RECOMMEND_PATH, {
      method: "POST",
      timeoutMs: input.timeoutMs,
      body: {
        conversation: input.conversation,
        customerId: input.customerId ?? "",
        conversationKey: input.conversationKey ?? "",
        limit: input.limit ?? 6,
        ...(input.sourceTypes?.length ? { sourceTypes: input.sourceTypes } : {}),
        signal: input.signal ?? "manual",
        ...(input.queryVector?.length ? { queryVector: input.queryVector } : {})
      }
    });
  }

  async reveal(
    userId: string,
    sourceType: ResourceSourceType | string,
    id: string,
    body: { reason?: string; conversationKey?: string } = {}
  ): Promise<CrmRevealResponse> {
    return crmRequestJson<CrmRevealResponse>(this.transport, userId, resourceRevealPath(sourceType, id), {
      method: "POST",
      body: { reason: body.reason ?? "", conversationKey: body.conversationKey ?? "" }
    });
  }

  async feedback(
    userId: string,
    items: ResourceFeedbackItem[],
    conversationKey = ""
  ): Promise<CrmFeedbackResponse> {
    return crmRequestJson<CrmFeedbackResponse>(this.transport, userId, RESOURCE_FEEDBACK_PATH, {
      method: "POST",
      body: { items, conversationKey }
    });
  }

  /** 推荐效果报表（docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）。days ∈ [1,90]。 */
  async stats(userId: string, days = 30): Promise<CrmResourceStatsResponse> {
    return crmRequestJson<CrmResourceStatsResponse>(this.transport, userId, RESOURCE_STATS_PATH, {
      method: "GET",
      query: { days }
    });
  }
}
