import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import { canonicalOrganizationId } from "./organization-identity-conflict-review.js";
import type { CrmStore } from "./store.js";
import type {
  OrganizationAliasFact,
  OrganizationRelationFact,
  OrganizationRelationType,
  SessionUser
} from "./types.js";

const evidenceFields = {
  sourceLabel: z.string().trim().min(2).max(120),
  sourceReference: z.string().trim().max(500).optional().default(""),
  evidenceSummary: z.string().trim().min(2).max(1000),
  verificationStatus: z
    .enum(["reported", "verified"])
    .optional()
    .default("reported"),
  observedAt: z
    .union([z.string().datetime({ offset: true }), z.literal("")])
    .optional()
    .default("")
};

export const organizationAliasBodySchema = z.object({
  aliasType: z.enum([
    "legal_name",
    "trading_name",
    "brand",
    "previous_name",
    "localized_name"
  ]),
  aliasName: z.string().trim().min(2).max(300),
  locale: z.string().trim().max(40).optional().default(""),
  jurisdiction: z.string().trim().max(100).optional().default(""),
  ...evidenceFields
}).strict();

export const organizationRelationBodySchema = z.object({
  sourceOrganizationId: z.string().trim().min(1).max(90),
  targetOrganizationId: z.string().trim().min(1).max(90),
  relationType: z.enum([
    "direct_parent",
    "ultimate_parent",
    "branch_of",
    "brand_of",
    "affiliate"
  ]),
  ...evidenceFields
}).strict();

export type OrganizationAliasBody = z.infer<
  typeof organizationAliasBodySchema
>;
export type OrganizationRelationBody = z.infer<
  typeof organizationRelationBodySchema
>;

export type OrganizationRelationErrorCode =
  | "ORGANIZATION_PROFILE_FORBIDDEN"
  | "ORGANIZATION_FACT_WRITE_FORBIDDEN"
  | "ORGANIZATION_NOT_FOUND"
  | "ORGANIZATION_RELATION_INVALID"
  | "ORGANIZATION_RELATION_CONFLICT"
  | "ORGANIZATION_RELATION_CYCLE";

export class OrganizationRelationError extends Error {
  constructor(
    public readonly code: OrganizationRelationErrorCode,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "OrganizationRelationError";
  }
}

export interface RecordOrganizationAliasInput {
  user: SessionUser;
  organizationId: string;
  body: OrganizationAliasBody;
}

export interface RecordOrganizationAliasResult {
  alias: OrganizationAliasFact;
  replayed: boolean;
}

export interface RecordOrganizationRelationInput {
  user: SessionUser;
  body: OrganizationRelationBody;
}

export interface RecordOrganizationRelationResult {
  relation: OrganizationRelationFact;
  replayed: boolean;
}

const hierarchicalRelationTypes = new Set<OrganizationRelationType>([
  "direct_parent",
  "ultimate_parent",
  "branch_of",
  "brand_of"
]);

function sha256(value: unknown) {
  return createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");
}

function normalizeAlias(value: string) {
  return value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedObservedAt(value: string) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

export function organizationAliasFactHash(
  fact: Omit<OrganizationAliasFact, "factHash">
) {
  return sha256({
    contract: "organization-alias-fact-v1",
    ...fact
  });
}

export function organizationRelationFactHash(
  fact: Omit<OrganizationRelationFact, "factHash">
) {
  return sha256({
    contract: "organization-relation-fact-v1",
    ...fact
  });
}

function requireProfileReader(user: SessionUser) {
  if (!["sales", "manager", "admin"].includes(user.role)) {
    throw new OrganizationRelationError(
      "ORGANIZATION_PROFILE_FORBIDDEN",
      "企业画像只允许当前团队成员读取",
      403
    );
  }
}

function requireFactWriter(user: SessionUser) {
  if (user.role !== "manager" && user.role !== "admin") {
    throw new OrganizationRelationError(
      "ORGANIZATION_FACT_WRITE_FORBIDDEN",
      "只有本团队主管或管理员可以维护企业别名和集团关系",
      403
    );
  }
}

function organizationForTeam(
  store: CrmStore,
  user: SessionUser,
  organizationId: string
) {
  const canonicalId = canonicalOrganizationId(
    store,
    user.teamId,
    organizationId
  );
  const organization = store.organizations.find(
    (item) => item.id === canonicalId && item.teamId === user.teamId
  );
  if (!organization) {
    throw new OrganizationRelationError(
      "ORGANIZATION_NOT_FOUND",
      "企业不存在或无权访问",
      404
    );
  }
  return organization;
}

function aliasFactKey(
  teamId: string,
  organizationId: string,
  body: OrganizationAliasBody,
  normalizedAlias: string
) {
  return sha256({
    contract: "organization-alias-key-v1",
    teamId,
    organizationId,
    aliasType: body.aliasType,
    normalizedAlias,
    locale: body.locale.toLocaleLowerCase("en-US"),
    jurisdiction: body.jurisdiction.toLocaleUpperCase("en-US"),
    sourceLabel: body.sourceLabel,
    sourceReference: body.sourceReference
  });
}

function relationFactKey(
  teamId: string,
  sourceOrganizationId: string,
  targetOrganizationId: string,
  body: OrganizationRelationBody
) {
  return sha256({
    contract: "organization-relation-key-v1",
    teamId,
    sourceOrganizationId,
    targetOrganizationId,
    relationType: body.relationType,
    sourceLabel: body.sourceLabel,
    sourceReference: body.sourceReference
  });
}

export function buildOrganizationAliasFact(
  store: CrmStore,
  input: RecordOrganizationAliasInput
): RecordOrganizationAliasResult {
  requireFactWriter(input.user);
  const organization = organizationForTeam(
    store,
    input.user,
    input.organizationId
  );
  const normalizedAlias = normalizeAlias(input.body.aliasName);
  const factKeyHash = aliasFactKey(
    input.user.teamId,
    organization.id,
    input.body,
    normalizedAlias
  );
  const existing = store.organizationAliasFacts.find(
    (item) =>
      item.teamId === input.user.teamId
      && item.factKeyHash === factKeyHash
  );
  if (existing) return { alias: existing, replayed: true };

  const createdAt = new Date().toISOString();
  const base = {
    id: `oaf_${randomUUID()}`,
    teamId: input.user.teamId,
    organizationId: organization.id,
    aliasType: input.body.aliasType,
    aliasName: input.body.aliasName.normalize("NFC"),
    normalizedAlias,
    locale: input.body.locale,
    jurisdiction: input.body.jurisdiction,
    sourceLabel: input.body.sourceLabel,
    sourceReference: input.body.sourceReference,
    evidenceSummary: input.body.evidenceSummary,
    verificationStatus: input.body.verificationStatus,
    observedAt: normalizedObservedAt(input.body.observedAt),
    createdBy: input.user.id,
    factKeyHash,
    createdAt
  };
  return {
    alias: {
      ...base,
      factHash: organizationAliasFactHash(base)
    },
    replayed: false
  };
}

function relationEdges(store: CrmStore, teamId: string) {
  return store.organizationRelationFacts
    .filter(
      (item) =>
        item.teamId === teamId
        && hierarchicalRelationTypes.has(item.relationType)
    )
    .map((item) => ({
      source: canonicalOrganizationId(
        store,
        teamId,
        item.sourceOrganizationId
      ),
      target: canonicalOrganizationId(
        store,
        teamId,
        item.targetOrganizationId
      )
    }))
    .filter((item) => item.source !== item.target);
}

function hasPath(
  edges: Array<{ source: string; target: string }>,
  start: string,
  destination: string
) {
  const targets = new Map<string, string[]>();
  for (const edge of edges) {
    const current = targets.get(edge.source) || [];
    current.push(edge.target);
    targets.set(edge.source, current);
  }
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === destination) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(targets.get(current) || []));
  }
  return false;
}

export function buildOrganizationRelationFact(
  store: CrmStore,
  input: RecordOrganizationRelationInput
): RecordOrganizationRelationResult {
  requireFactWriter(input.user);
  const source = organizationForTeam(
    store,
    input.user,
    input.body.sourceOrganizationId
  );
  const target = organizationForTeam(
    store,
    input.user,
    input.body.targetOrganizationId
  );
  if (source.id === target.id) {
    throw new OrganizationRelationError(
      "ORGANIZATION_RELATION_INVALID",
      "规范企业不能与自身建立集团关系",
      400
    );
  }

  const factKeyHash = relationFactKey(
    input.user.teamId,
    source.id,
    target.id,
    input.body
  );
  const existing = store.organizationRelationFacts.find(
    (item) =>
      item.teamId === input.user.teamId
      && item.factKeyHash === factKeyHash
  );
  if (existing) return { relation: existing, replayed: true };

  if (hierarchicalRelationTypes.has(input.body.relationType)) {
    const conflicting = store.organizationRelationFacts.find(
      (item) =>
        item.teamId === input.user.teamId
        && item.sourceOrganizationId === source.id
        && item.relationType === input.body.relationType
        && item.targetOrganizationId !== target.id
    );
    if (conflicting) {
      throw new OrganizationRelationError(
        "ORGANIZATION_RELATION_CONFLICT",
        "该企业已存在同类型但目标不同的集团关系，请先人工复核",
        409
      );
    }
    if (hasPath(relationEdges(store, input.user.teamId), target.id, source.id)) {
      throw new OrganizationRelationError(
        "ORGANIZATION_RELATION_CYCLE",
        "本次集团关系会形成层级循环，已拒绝保存",
        409
      );
    }
  }

  const createdAt = new Date().toISOString();
  const base = {
    id: `orf_${randomUUID()}`,
    teamId: input.user.teamId,
    sourceOrganizationId: source.id,
    targetOrganizationId: target.id,
    relationType: input.body.relationType,
    sourceLabel: input.body.sourceLabel,
    sourceReference: input.body.sourceReference,
    evidenceSummary: input.body.evidenceSummary,
    verificationStatus: input.body.verificationStatus,
    observedAt: normalizedObservedAt(input.body.observedAt),
    createdBy: input.user.id,
    factKeyHash,
    createdAt
  };
  return {
    relation: {
      ...base,
      factHash: organizationRelationFactHash(base)
    },
    replayed: false
  };
}

export async function recordOrganizationAlias(
  store: CrmStore,
  input: RecordOrganizationAliasInput
) {
  if (store.recordOrganizationAlias) {
    return store.recordOrganizationAlias(input);
  }
  const result = buildOrganizationAliasFact(store, input);
  if (result.replayed) return result;
  store.organizationAliasFacts.push(result.alias);
  try {
    await store.persist();
  } catch (error) {
    store.organizationAliasFacts.splice(
      store.organizationAliasFacts.indexOf(result.alias),
      1
    );
    throw error;
  }
  return result;
}

export async function recordOrganizationRelation(
  store: CrmStore,
  input: RecordOrganizationRelationInput
) {
  if (store.recordOrganizationRelation) {
    return store.recordOrganizationRelation(input);
  }
  const result = buildOrganizationRelationFact(store, input);
  if (result.replayed) return result;
  store.organizationRelationFacts.push(result.relation);
  try {
    await store.persist();
  } catch (error) {
    store.organizationRelationFacts.splice(
      store.organizationRelationFacts.indexOf(result.relation),
      1
    );
    throw error;
  }
  return result;
}

export function organizationIdentityProfile(
  store: CrmStore,
  user: SessionUser,
  organizationId: string
) {
  requireProfileReader(user);
  const organization = organizationForTeam(store, user, organizationId);
  const aliases = store.organizationAliasFacts
    .filter(
      (item) =>
        item.teamId === user.teamId
        && canonicalOrganizationId(
          store,
          user.teamId,
          item.organizationId
        ) === organization.id
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const relations = store.organizationRelationFacts
    .filter((item) => item.teamId === user.teamId)
    .map((item) => ({
      fact: item,
      sourceOrganizationId: canonicalOrganizationId(
        store,
        user.teamId,
        item.sourceOrganizationId
      ),
      targetOrganizationId: canonicalOrganizationId(
        store,
        user.teamId,
        item.targetOrganizationId
      )
    }))
    .filter(
      (item) =>
        item.sourceOrganizationId !== item.targetOrganizationId
        && (
          item.sourceOrganizationId === organization.id
          || item.targetOrganizationId === organization.id
        )
    )
    .map((item) => {
      const outbound = item.sourceOrganizationId === organization.id;
      const relatedId = outbound
        ? item.targetOrganizationId
        : item.sourceOrganizationId;
      const related = store.organizations.find(
        (candidate) =>
          candidate.id === relatedId
          && candidate.teamId === user.teamId
      );
      return {
        ...item.fact,
        sourceOrganizationId: item.sourceOrganizationId,
        targetOrganizationId: item.targetOrganizationId,
        direction: outbound ? "outbound" : "inbound",
        relatedOrganization: {
          id: relatedId,
          name: related?.legalName || `企业 ${relatedId.slice(-8)}`
        }
      };
    })
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  return {
    organization: {
      id: organization.id,
      legalName: organization.legalName,
      status: organization.status
    },
    aliases,
    relations
  };
}
