import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { AgentActor, AgentPlanContext } from "./ai-agent.js";
import { compileAgentGoalSpec, goalSpecSearchText } from "./agent-goal.js";
import type { CrmStore } from "./store.js";
import type {
  AgentKnowledgeDocument,
  AgentKnowledgeKind,
  AgentKnowledgeScope,
  AgentKnowledgeStatus,
  Role
} from "./types.js";

const roleSchema = z.enum(["sales", "manager", "admin", "super_admin"]);
const kindSchema = z.enum(["system", "module", "workflow", "policy", "field", "playbook", "failure_case"]);
const systemFileSchema = z.object({
  id: z.string().trim().min(4).max(160),
  kind: kindSchema,
  module: z.string().trim().min(2).max(80),
  title: z.string().trim().min(2).max(160),
  summary: z.string().trim().min(2).max(500),
  content: z.string().trim().min(10).max(8_000),
  keywords: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  roles: z.array(roleSchema).min(1).max(4),
  toolRefs: z.array(z.string().trim().min(2).max(120)).max(40).default([]),
  successCriteria: z.array(z.string().trim().min(2).max(300)).max(20).default([]),
  failureCases: z.array(z.string().trim().min(2).max(300)).max(20).default([]),
  version: z.string().trim().min(1).max(40)
});

const managedInputSchema = z.object({
  kind: kindSchema.exclude(["system"]),
  scope: z.enum(["team", "company"]).default("team"),
  module: z.string().trim().min(2).max(80),
  title: z.string().trim().min(2).max(160),
  summary: z.string().trim().min(2).max(500),
  content: z.string().trim().min(10).max(8_000),
  keywords: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  roles: z.array(roleSchema).min(1).max(4).default(["sales", "manager", "admin", "super_admin"]),
  toolRefs: z.array(z.string().trim().min(2).max(120)).max(40).default([]),
  successCriteria: z.array(z.string().trim().min(2).max(300)).max(20).default([]),
  failureCases: z.array(z.string().trim().min(2).max(300)).max(20).default([]),
  sourceType: z.enum(["manual", "agent_feedback"]).default("manual"),
  sourceId: z.string().trim().max(160).default("")
});

type SystemKnowledgeState = {
  directory: string;
  documents: AgentKnowledgeDocument[];
  errors: string[];
  loadedAt: string;
};

let systemState: SystemKnowledgeState | null = null;

function hashKnowledge(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function knowledgeDirectories() {
  const moduleRelative = fileURLToPath(new URL("../../agent-knowledge/", import.meta.url));
  return [...new Set([
    process.env.AGENT_KNOWLEDGE_DIR || "",
    path.resolve(process.cwd(), "agent-knowledge"),
    moduleRelative
  ].filter(Boolean))];
}

function fallbackSystemDocument(): AgentKnowledgeDocument {
  const now = new Date(0).toISOString();
  const semantic = {
    id: "system.contract.fallback",
    module: "agent",
    title: "Agent 安全执行边界",
    content: "Agent 只能使用 GoodJob CRM 提供的工具和当前用户权限。不得猜测接口、业务对象或执行结果；只读要求禁止写入和发送。"
  };
  return {
    ...semantic,
    ownerId: "",
    teamId: "all",
    kind: "policy",
    scope: "system",
    summary: "系统知识目录不可用时保留的最小安全契约。",
    keywords: ["权限", "只读", "接口", "执行"],
    roles: ["sales", "manager", "admin", "super_admin"],
    toolRefs: ["api.catalog"],
    successCriteria: ["遵守真实权限", "使用真实工具结果"],
    failureCases: ["猜测接口", "编造结果"],
    sourceType: "system_file",
    sourceId: "built-in",
    status: "published",
    trustLevel: "system",
    version: "1.0.0",
    revision: 1,
    checksum: hashKnowledge(semantic),
    publishedBy: "system",
    publishedAt: now,
    usageCount: 0,
    lastUsedAt: "",
    createdAt: now,
    updatedAt: now
  };
}

export function reloadSystemAgentKnowledge() {
  const directory = knowledgeDirectories().find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory()) || "";
  const documents: AgentKnowledgeDocument[] = [];
  const errors: string[] = [];
  if (directory) {
    for (const fileName of readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
      try {
        const parsed = systemFileSchema.parse(JSON.parse(readFileSync(path.join(directory, fileName), "utf8")));
        const modifiedAt = statSync(path.join(directory, fileName)).mtime.toISOString();
        documents.push({
          ...parsed,
          ownerId: "",
          teamId: "all",
          scope: "system",
          sourceType: "system_file",
          sourceId: fileName,
          status: "published",
          trustLevel: "system",
          revision: 1,
          checksum: hashKnowledge(parsed),
          publishedBy: "system",
          publishedAt: modifiedAt,
          usageCount: 0,
          lastUsedAt: "",
          createdAt: modifiedAt,
          updatedAt: modifiedAt
        });
      } catch (error) {
        errors.push(`${fileName}: ${error instanceof Error ? error.message : "知识格式错误"}`);
      }
    }
  } else {
    errors.push("未找到 agent-knowledge 系统知识目录");
  }
  if (!documents.length) documents.push(fallbackSystemDocument());
  systemState = { directory, documents, errors, loadedAt: new Date().toISOString() };
  return systemState;
}

export function systemAgentKnowledge() {
  return systemState || reloadSystemAgentKnowledge();
}

function canManageTeam(actor: AgentActor) {
  return ["manager", "admin", "super_admin"].includes(actor.role);
}

function sameTeam(actor: AgentActor, teamId: string) {
  return actor.role === "super_admin" || actor.teamId === teamId;
}

function canSeeManaged(actor: AgentActor, document: AgentKnowledgeDocument, includeUnpublished: boolean) {
  if (!sameTeam(actor, document.teamId)) return false;
  if (!document.roles.includes(actor.role as Role)) return false;
  if (document.status === "published") return true;
  return includeUnpublished && (document.ownerId === actor.id || canManageTeam(actor));
}

function canEditManaged(actor: AgentActor, document: AgentKnowledgeDocument) {
  return document.sourceType !== "system_file"
    && sameTeam(actor, document.teamId)
    && (document.ownerId === actor.id || canManageTeam(actor));
}

function semanticDocument(document: Pick<AgentKnowledgeDocument,
  "kind" | "scope" | "module" | "title" | "summary" | "content" | "keywords" | "roles" |
  "toolRefs" | "successCriteria" | "failureCases" | "sourceType" | "sourceId">) {
  return document;
}

function updateChecksum(document: AgentKnowledgeDocument) {
  document.checksum = hashKnowledge(semanticDocument(document));
}

function distillationDocuments(store: CrmStore, actor: AgentActor): AgentKnowledgeDocument[] {
  return store.salesDistillations
    .filter((item) => item.status === "published" && sameTeam(actor, item.teamId))
    .map((item) => {
      const content = [
        ...item.patterns,
        ...item.playbook.map((entry) => `${entry.stage}：${entry.action}；依据：${entry.evidence}`),
        ...item.coachingActions.map((entry) => `训练动作：${entry}`)
      ].join("\n");
      const publishedAt = item.publishedAt || item.createdAt;
      return {
        id: `distillation.${item.id}`,
        ownerId: item.createdBy,
        teamId: item.teamId,
        kind: "playbook",
        scope: "team",
        module: "sales",
        title: `${item.sourceUserName} 业务打法`,
        summary: `${item.periodDays} 天业务样本形成的已发布团队打法`,
        content,
        keywords: ["业务员蒸馏", "销售打法", ...item.playbook.map((entry) => entry.stage)],
        roles: ["sales", "manager", "admin", "super_admin"],
        toolRefs: ["distillation.list_playbooks", "distillation.activate_playbook"],
        successCriteria: item.coachingActions,
        failureCases: [],
        sourceType: "distillation",
        sourceId: item.id,
        status: "published",
        trustLevel: "reviewed",
        version: "1.0.0",
        revision: 1,
        checksum: hashKnowledge({ id: item.id, content }),
        publishedBy: item.publishedBy || item.createdBy,
        publishedAt,
        usageCount: 0,
        lastUsedAt: "",
        createdAt: item.createdAt,
        updatedAt: publishedAt
      };
    });
}

export function listAgentKnowledgeDocuments(store: CrmStore, actor: AgentActor, options: {
  status?: AgentKnowledgeStatus | "all";
  kind?: AgentKnowledgeKind | "all";
  module?: string;
  query?: string;
  includeSystem?: boolean;
} = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const includeSystem = options.includeSystem !== false;
  const systemDocuments = includeSystem
    ? systemAgentKnowledge().documents.filter((item) => item.roles.includes(actor.role as Role))
    : [];
  const managed = store.agentKnowledgeDocuments.filter((item) => canSeeManaged(actor, item, true));
  const derived = distillationDocuments(store, actor);
  return [...systemDocuments, ...managed, ...derived]
    .filter((item) => !options.status || options.status === "all" || item.status === options.status)
    .filter((item) => !options.kind || options.kind === "all" || item.kind === options.kind)
    .filter((item) => !options.module || item.module === options.module)
    .filter((item) => !query || `${item.title} ${item.summary} ${item.content} ${item.keywords.join(" ")}`.toLowerCase().includes(query))
    .sort((left, right) => {
      const trust = { system: 3, reviewed: 2, candidate: 1 };
      return trust[right.trustLevel] - trust[left.trustLevel] || right.updatedAt.localeCompare(left.updatedAt);
    });
}

export async function createAgentKnowledgeDraft(store: CrmStore, actor: AgentActor, input: unknown) {
  const parsed = managedInputSchema.parse(input);
  const now = new Date().toISOString();
  const document: AgentKnowledgeDocument = {
    id: `agk_${randomUUID()}`,
    ownerId: actor.id,
    teamId: actor.teamId,
    ...parsed,
    status: "draft",
    trustLevel: "candidate",
    version: "1.0.0",
    revision: 1,
    checksum: "",
    publishedBy: "",
    publishedAt: "",
    usageCount: 0,
    lastUsedAt: "",
    createdAt: now,
    updatedAt: now
  };
  updateChecksum(document);
  store.agentKnowledgeDocuments.unshift(document);
  await store.persist();
  return document;
}

export async function updateAgentKnowledgeDraft(store: CrmStore, actor: AgentActor, id: string, input: unknown) {
  const document = store.agentKnowledgeDocuments.find((item) => item.id === id);
  if (!document || !canEditManaged(actor, document)) throw new Error("知识不存在或无权编辑");
  const parsed = managedInputSchema.partial().parse(input);
  Object.assign(document, parsed);
  if (document.status === "published") {
    document.status = "review";
    document.trustLevel = "candidate";
    document.publishedBy = "";
    document.publishedAt = "";
  }
  document.updatedAt = new Date().toISOString();
  updateChecksum(document);
  await store.persist();
  return document;
}

export async function setAgentKnowledgeStatus(store: CrmStore, actor: AgentActor, id: string, action: "submit" | "publish" | "archive") {
  const document = store.agentKnowledgeDocuments.find((item) => item.id === id);
  if (!document || !canEditManaged(actor, document)) throw new Error("知识不存在或无权操作");
  const now = new Date().toISOString();
  if (action === "publish") {
    if (!canManageTeam(actor)) throw new Error("发布团队知识需要主管或管理员审核");
    document.status = "published";
    document.trustLevel = "reviewed";
    document.publishedBy = actor.id;
    document.publishedAt = now;
    document.version = `1.0.${Math.max(0, document.revision - 1)}`;
  } else if (action === "submit") {
    document.status = "review";
    document.trustLevel = "candidate";
  } else {
    document.status = "archived";
    document.trustLevel = "candidate";
  }
  document.revision += 1;
  document.updatedAt = now;
  updateChecksum(document);
  await store.persist();
  return document;
}

function knowledgeTerms(value: string) {
  const normalized = value.toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9][a-z0-9_.-]+|[\p{Script=Han}]{2,}/gu) || []);
  for (const group of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < group.length - 1; index += 1) terms.add(group.slice(index, index + 2));
  }
  return terms;
}

function activeModule(value: string) {
  const aliases: Record<string, string> = {
    customers: "customers",
    "customer-detail": "customers",
    "customer-pool": "customer-pool",
    leads: "leads",
    "lead-finder": "lead-finder",
    "prospect-list": "lead-finder",
    "development-email": "development-email",
    whatsapp: "whatsapp",
    "ai-research": "ai-research",
    "ai-agent": "agent"
  };
  return aliases[value] || value;
}

function goalDomainModule(query: string, activeView = "") {
  const spec = compileAgentGoalSpec(query, { activeView });
  const aliases: Partial<Record<typeof spec.primaryDomain, string>> = {
    customers: "customers",
    leads: "leads",
    deals: "pipeline",
    documents: "documents",
    prospecting: "lead-finder",
    outreach: "development-email",
    communication: "whatsapp",
    research: "ai-research",
    maintenance: "customers",
    "sales-training": "sales-distillation",
    knowledge: "knowledge"
  };
  return {
    spec,
    moduleName: activeModule(activeView) || aliases[spec.primaryDomain] || "",
    expandedQuery: goalSpecSearchText(spec)
  };
}

export function retrieveAgentKnowledge(store: CrmStore, actor: AgentActor, query: string, options: {
  activeView?: string;
  limit?: number;
  trackUsage?: boolean;
} = {}) {
  const semantic = goalDomainModule(query, String(options.activeView || ""));
  const queryTerms = knowledgeTerms(semantic.expandedQuery);
  const moduleName = semantic.moduleName;
  const documents = [
    ...systemAgentKnowledge().documents.filter((item) => item.roles.includes(actor.role as Role)),
    ...store.agentKnowledgeDocuments.filter((item) => canSeeManaged(actor, item, false) && item.status === "published"),
    ...distillationDocuments(store, actor)
  ];
  const documentTerms = new Map(documents.map((document) => [document.id, knowledgeTerms([
    document.module,
    document.title,
    document.summary,
    document.content,
    ...document.keywords,
    ...document.toolRefs,
    ...document.successCriteria,
    ...document.failureCases
  ].join(" "))]));
  const documentFrequency = new Map<string, number>();
  for (const terms of documentTerms.values()) {
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  const idf = (term: string) => Math.log((documents.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1;
  const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
  const hits = documents.map((document) => {
    const titleTerms = knowledgeTerms(`${document.title} ${document.keywords.join(" ")}`);
    const bodyTerms = knowledgeTerms(`${document.summary} ${document.content} ${document.successCriteria.join(" ")} ${document.failureCases.join(" ")}`);
    const titleHits = [...queryTerms].filter((term) => titleTerms.has(term));
    const bodyHits = [...queryTerms].filter((term) => bodyTerms.has(term));
    const reasons: string[] = [];
    let score = titleHits.reduce((sum, term) => sum + idf(term) * 6, 0)
      + bodyHits.reduce((sum, term) => sum + idf(term) * 2.5, 0);
    if (titleHits.length) reasons.push(`标题/关键词加权命中 ${titleHits.length}`);
    if (bodyHits.length) reasons.push(`正文加权命中 ${bodyHits.length}`);
    const searchable = `${document.title} ${document.summary} ${document.content}`.normalize("NFKC").toLowerCase();
    if (normalizedQuery.length >= 3 && searchable.includes(normalizedQuery)) {
      score += 14;
      reasons.push("完整短语匹配");
    }
    if (moduleName && document.module === moduleName) {
      score += 16;
      reasons.push(options.activeView ? "当前模块匹配" : `目标域匹配 ${semantic.spec.primaryDomain}`);
    }
    if (document.toolRefs.some((tool) => semantic.expandedQuery.includes(tool.split(".")[0] || ""))) {
      score += 3;
      reasons.push("工具域匹配");
    }
    if (document.trustLevel === "system") {
      score += 3;
      reasons.push("系统可信知识");
    }
    if (document.trustLevel === "reviewed") {
      score += 2;
      reasons.push("已审核知识");
    }
    return { document, score, reasons };
  })
    .filter((hit) => hit.score > 2 || queryTerms.size === 0)
    .sort((left, right) => right.score - left.score || right.document.updatedAt.localeCompare(left.document.updatedAt))
    .slice(0, Math.max(1, Math.min(12, options.limit || 8)));
  if (options.trackUsage !== false) {
    const now = new Date().toISOString();
    for (const hit of hits) {
      const managed = store.agentKnowledgeDocuments.find((item) => item.id === hit.document.id);
      if (!managed) continue;
      managed.usageCount += 1;
      managed.lastUsedAt = now;
    }
  }
  return hits;
}

export function compileAgentKnowledgeEnvelope(store: CrmStore, actor: AgentActor, goal: string, context: AgentPlanContext = {}) {
  const hits = retrieveAgentKnowledge(store, actor, goal, { activeView: context.activeView, limit: 8 });
  return {
    protocol: "goodjob-agent-context/v1",
    knowledgeVersion: hashKnowledge(hits.map((hit) => [hit.document.id, hit.document.version, hit.document.checksum])).slice(0, 16),
    retrievalMode: "structured+weighted-lexical+semantic-expansion",
    vectorEnabled: false,
    page: { activeView: context.activeView || "", selectedCustomerId: context.selectedCustomerId || "", selectedLeadId: context.selectedLeadId || "" },
    knowledge: hits.map((hit) => ({
      id: hit.document.id,
      version: hit.document.version,
      module: hit.document.module,
      kind: hit.document.kind,
      trust: hit.document.trustLevel,
      title: hit.document.title,
      summary: hit.document.summary,
      content: hit.document.content.slice(0, 1_800),
      toolRefs: hit.document.toolRefs,
      successCriteria: hit.document.successCriteria,
      failureCases: hit.document.failureCases,
      source: { type: hit.document.sourceType, id: hit.document.sourceId },
      score: hit.score
    }))
  };
}

export function agentKnowledgeOverview(store: CrmStore, actor: AgentActor) {
  const state = systemAgentKnowledge();
  const visibleManaged = store.agentKnowledgeDocuments.filter((item) => canSeeManaged(actor, item, true));
  const publishedDistillations = distillationDocuments(store, actor);
  const modules = [...new Set([...state.documents, ...visibleManaged, ...publishedDistillations].map((item) => item.module))].sort();
  return {
    systemCount: state.documents.length,
    managedCount: visibleManaged.length,
    publishedCount: visibleManaged.filter((item) => item.status === "published").length,
    reviewCount: visibleManaged.filter((item) => item.status === "review").length,
    distillationCount: publishedDistillations.length,
    modules,
    loadedAt: state.loadedAt,
    directory: state.directory,
    errors: state.errors,
    retrievalMode: "结构化 + 加权词法 + 语义扩展",
    vectorEnabled: false,
    canPublish: canManageTeam(actor)
  };
}
