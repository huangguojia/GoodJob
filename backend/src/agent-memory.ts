import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentActor } from "./ai-agent.js";
import { canSeeOwner, hasIamPermission } from "./auth.js";
import type { CrmStore } from "./store.js";
import type { AgentMemoryRecord, AgentMemoryScope, AgentMemoryStatus, AgentMemoryType } from "./types.js";

const memoryInputSchema = z.object({
  type: z.enum(["user_preference", "company_knowledge", "customer_memory", "team_playbook"]),
  scope: z.enum(["personal", "team", "customer", "company"]),
  subjectId: z.string().trim().max(120).default(""),
  title: z.string().trim().min(2).max(120),
  content: z.string().trim().min(2).max(2_000),
  sourceType: z.enum(["crm", "manual", "agent", "playbook"]).default("agent"),
  sourceId: z.string().trim().max(160).default(""),
  confidence: z.coerce.number().int().min(0).max(100).default(70),
  expiresAt: z.string().trim().max(40).refine((value) => !value || Number.isFinite(new Date(value).getTime()), "记忆有效期格式无效").default("")
});

function canManageTeam(actor: AgentActor) {
  return hasIamPermission(actor, "agent.manage");
}

function canSeeCustomer(store: CrmStore, actor: AgentActor, customerId: string) {
  const customer = store.customers.find((item) => item.id === customerId);
  return Boolean(customer && canSeeOwner(actor, customer.ownerId, customer.teamId));
}

function visibleMemory(store: CrmStore, actor: AgentActor, item: AgentMemoryRecord) {
  if (item.teamId !== actor.teamId) return false;
  if (item.scope === "personal") return item.ownerId === actor.id;
  if (item.scope === "customer") return canSeeCustomer(store, actor, item.subjectId) && (item.status === "active" || item.ownerId === actor.id || canManageTeam(actor));
  return item.status === "active" || item.ownerId === actor.id || canManageTeam(actor);
}

function assertManageable(store: CrmStore, actor: AgentActor, item: AgentMemoryRecord) {
  if (!visibleMemory(store, actor, item)) throw new Error("业务记忆不存在或无权访问");
  if (["team", "company"].includes(item.scope) && !canManageTeam(actor)) throw new Error("团队或公司记忆需要主管或管理员维护");
  if (["personal", "customer"].includes(item.scope) && item.ownerId !== actor.id && !canManageTeam(actor)) throw new Error("只能维护本人创建的业务记忆");
}

export function listAgentMemories(store: CrmStore, actor: AgentActor, options: {
  status?: AgentMemoryStatus | "all";
  type?: AgentMemoryType | "all";
  subjectId?: string;
  query?: string;
} = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const now = Date.now();
  return store.agentMemories
    .filter((item) => visibleMemory(store, actor, item))
    .filter((item) => !options.status || options.status === "all" || item.status === options.status)
    .filter((item) => !options.type || options.type === "all" || item.type === options.type)
    .filter((item) => !options.subjectId || item.subjectId === options.subjectId)
    .filter((item) => !query || `${item.title} ${item.content}`.toLowerCase().includes(query))
    .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > now || item.status !== "active")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function proposeAgentMemory(store: CrmStore, actor: AgentActor, input: unknown) {
  const parsed = memoryInputSchema.parse(input);
  if (["team", "company"].includes(parsed.scope) && !canManageTeam(actor)) throw new Error("团队或公司记忆需要主管或管理员创建");
  if (parsed.scope === "customer" && (!parsed.subjectId || !canSeeCustomer(store, actor, parsed.subjectId))) throw new Error("客户记忆必须关联当前账号可见的客户");
  const now = new Date().toISOString();
  const record: AgentMemoryRecord = {
    id: `agm_${randomUUID()}`,
    ownerId: actor.id,
    teamId: actor.teamId,
    type: parsed.type,
    scope: parsed.scope,
    subjectId: parsed.subjectId,
    title: parsed.title,
    content: parsed.content,
    sourceType: parsed.sourceType,
    sourceId: parsed.sourceId,
    status: "proposed",
    confidence: parsed.confidence,
    expiresAt: parsed.expiresAt,
    lastUsedAt: "",
    createdAt: now,
    updatedAt: now
  };
  store.agentMemories.unshift(record);
  await store.persist();
  return record;
}

export async function updateAgentMemory(store: CrmStore, actor: AgentActor, id: string, input: unknown) {
  const item = store.agentMemories.find((entry) => entry.id === id);
  if (!item) throw new Error("业务记忆不存在或无权访问");
  assertManageable(store, actor, item);
  const patch = z.object({
    title: z.string().trim().min(2).max(120).optional(),
    content: z.string().trim().min(2).max(2_000).optional(),
    expiresAt: z.string().trim().max(40).refine((value) => !value || Number.isFinite(new Date(value).getTime()), "记忆有效期格式无效").optional()
  }).parse(input);
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  await store.persist();
  return item;
}

export async function setAgentMemoryStatus(store: CrmStore, actor: AgentActor, id: string, status: AgentMemoryStatus) {
  const item = store.agentMemories.find((entry) => entry.id === id);
  if (!item) throw new Error("业务记忆不存在或无权访问");
  assertManageable(store, actor, item);
  item.status = status;
  item.updatedAt = new Date().toISOString();
  await store.persist();
  return item;
}

export async function deleteAgentMemory(store: CrmStore, actor: AgentActor, id: string) {
  const item = store.agentMemories.find((entry) => entry.id === id);
  if (!item) throw new Error("业务记忆不存在或无权访问");
  assertManageable(store, actor, item);
  store.agentMemories = store.agentMemories.filter((entry) => entry.id !== id);
  await store.persist();
  return item;
}

function memoryTerms(value: string) {
  const normalized = value.toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) || []);
  for (const group of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < group.length - 1; index += 1) terms.add(group.slice(index, index + 2));
  }
  return terms;
}

export function retrieveRelevantAgentMemories(store: CrmStore, actor: AgentActor, goal: string, options: { customerId?: string; limit?: number } = {}) {
  const goalTerms = memoryTerms(goal);
  const now = Date.now();
  const scored = listAgentMemories(store, actor, { status: "active" })
    .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > now)
    .map((item) => {
      const terms = memoryTerms(`${item.title} ${item.content}`);
      let score = [...goalTerms].filter((term) => terms.has(term)).length;
      if (options.customerId && item.scope === "customer" && item.subjectId === options.customerId) score += 8;
      if (item.type === "user_preference") score += 1;
      return { item, score };
    })
    .filter((entry) => entry.score > 0 || goalTerms.size === 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))
    .slice(0, Math.max(1, Math.min(12, options.limit || 6)));
  const usedAt = new Date().toISOString();
  scored.forEach((entry) => { entry.item.lastUsedAt = usedAt; });
  return scored.map((entry) => entry.item);
}
